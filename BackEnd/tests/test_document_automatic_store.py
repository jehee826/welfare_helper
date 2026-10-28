from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from BackEnd.documents.contracts import DocumentError, automatic_source_fingerprint, stable_hash
from BackEnd.documents.store import DocumentStore


PROCESSED = datetime(2026, 10, 28, 2, 0, tzinfo=timezone.utc)


class Cursor:
    def __init__(self, responses=()):
        self.responses = list(responses)
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchone(self):
        return self.responses.pop(0)


class IsolatedStore(DocumentStore):
    def __init__(self, cursor, job=None):
        super().__init__(None)
        self.recording, self.job = cursor, job

    @contextmanager
    def cursor(self):
        yield self.recording

    def _lease(self, *args):
        return self.job

    def _admin(self, *args, **kwargs):
        pass

    def _document(self, *args, **kwargs):
        return {"document_id":"doc", "service_id":"WLF1", "service_name":"실제 제도"}


def job(mode="automatic"):
    return {"state":"parsing", "parse_config":{"processing_mode":mode}, "created_by":None,
            "local_ingestion":True, "document_id":"doc", "created_at":PROCESSED-timedelta(minutes=1),
            "candidate_metadata":{"file_sha256":"a"*64,"file_format":"pdf","document_name":"원문",
                                  "source_url":"https://example.invalid/document","source_organization":"발행 기관",
                                  "test_only":False,"basis_year":None,"source_updated_at":None}}


@pytest.mark.parametrize("rows,ready", [([{"contract":None}], False),
    ([{"contract":"function"},{"version":"old"}], False),
    ([{"contract":"function"},{"version":"automatic-v1"}], True)])
def test_readiness_requires_exact_transaction_marker(rows, ready):
    cursor = Cursor(rows)
    assert IsolatedStore(cursor).automatic_ready() is ready
    assert all(sql.startswith("SELECT") for sql, _ in cursor.calls)


def test_old_schema_blocks_registration_before_any_write():
    cursor = Cursor([{"contract":None}])
    with pytest.raises(DocumentError, match="automatic_processing_schema_required"):
        IsolatedStore(cursor).register({}, "", 0, "pdf", None, {}, b"")
    assert len(cursor.calls) == 1 and cursor.calls[0][0].startswith("SELECT")


def test_automatic_analysis_keeps_lease_without_inventing_human_review(monkeypatch):
    monkeypatch.setattr("BackEnd.documents.store.get_settings", lambda: SimpleNamespace(
        ollama_embed="bge-m3", rerank_model="tokenizer", rerank_revision="revision"))
    cursor = Cursor([{"processed_at":PROCESSED}])
    current = job()
    store = IsolatedStore(cursor, current)
    analysis = {"markdown":"원문", "blocks":[{"id":"b1","text":"원문"}], "blockers":[]}
    store.finish_analysis("job", "lease", analysis)
    statement, params = cursor.calls[-1]
    config = params[2].adapted
    payload = config["payload"]
    assert "lease_token" not in statement and "lease_until" not in statement and "reviewed_" not in statement
    assert "awaiting_review" not in statement
    assert config["processing_mode"] == "automatic" and config["embedding_model"] == "bge-m3"
    assert payload["analysis_hash"] == stable_hash(analysis)
    expected = {**store._document(), **current["candidate_metadata"]}
    assert payload["source_fingerprint"] == automatic_source_fingerprint(expected)
    assert payload["source_file_sha256"] == "a"*64
    assert payload["processed_at"] == PROCESSED.isoformat()
    assert "reviewed_at" not in payload and "reviewed_by" not in payload and "review" not in payload


def test_claim_excludes_all_legacy_jobs_including_reviewed_waiting_jobs():
    cursor = Cursor([None])
    assert IsolatedStore(cursor).claim(300) is None
    sql = cursor.calls[0][0]
    assert "j.parse_config->>'processing_mode'='automatic'" in sql
    assert "awaiting_review" not in sql and "chunk_config ? 'payload'" not in sql


def test_legacy_analysis_can_only_remain_in_its_old_waiting_state():
    cursor = Cursor()
    IsolatedStore(cursor, job("manual")).finish_analysis("job", "lease", {"markdown":"원문"})
    sql, _ = cursor.calls[0]
    assert "state='awaiting_review'" in sql and "lease_token=NULL,lease_until=NULL" in sql
    assert "reviewed_" not in sql


def test_embedding_requires_automatic_analysis_not_manual_approval():
    current = job("manual")
    current["chunk_config"] = {"payload":{"review":{}}}
    cursor = Cursor()
    with pytest.raises(DocumentError, match="automatic_analysis_required"):
        IsolatedStore(cursor, current).begin_embedding("job", "lease", "bge-m3", "digest")
    assert cursor.calls == []


@pytest.mark.parametrize("mode,state,replaced", [("manual","awaiting_review",True),
    ("automatic","awaiting_review",False), ("automatic","embedding",False), ("manual","parsing",False)])
def test_explicit_file_replacement_only_replaces_legacy_waiting_candidate(mode, state, replaced):
    class RegistrationCursor(Cursor):
        def fetchall(self):
            return [{"program_id":1,"test_only":False}]

    class RegistrationStore(IsolatedStore):
        def automatic_ready(self):
            return True

        def _document(self, *args, **kwargs):
            return {"document_id":"doc","program_id":1,"active_job_id":"published","local_ingestion":True}

        def _pending(self, *args):
            return {"job_id":"legacy", "state":state, "parse_config":{"processing_mode":mode}}

        def _new_job(self, cur, doc, *args):
            assert doc['active_job_id'] == 'published'
            return {"job_id":"new", "state":"queued"}

    cursor = RegistrationCursor()
    store = RegistrationStore(cursor)
    metadata = {"service_id":"WLF1","name":"새 원문","test_only":False}
    def upload():
        return store.register(metadata, stable_hash(b'new'), 3, 'md', None, {}, b'new', document_id='doc')
    if replaced:
        doc, new = upload()
        assert doc['active_job_id'] == 'published' and new['job_id'] == 'new'
        assert cursor.calls[1][1] == ('cancelled', 'legacy_replaced_by_upload', 'legacy')
        assert cursor.calls[2][1] == ('legacy',)
    else:
        with pytest.raises(DocumentError, match='document_job_already_pending'):
            upload()
        assert len(cursor.calls) == 1
