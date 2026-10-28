from dataclasses import replace
import json
import re

import pytest

from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.chat import ChatService, EvidenceRequirementError
from BackEnd.rag.evidence import EvidenceChunk, EvidenceConsistencyError, active_chunks, fingerprint, read_chunk, validate_version
from BackEnd.rag.repository import CatalogSnapshot


DOCUMENT_ID = "00000000-0000-0000-0000-000000000001"
RECORD = ServiceRecord("PROGRAM_7", "문서 제도", "문서 메타데이터", "기관", "부서", "https://example.invalid/source", [], "")


def automatic_chunks(texts):
    source_hash = fingerprint("\n".join(texts))
    clean, split, digest = "structure-nfc-v2", "auto-content-v1:test", "test-digest"
    version = fingerprint(source_hash + clean + split + RECORD.name + digest + DOCUMENT_ID)[:24]
    chunks = []
    for index, text in enumerate(texts):
        cid = f"{RECORD.service_id}:document:{DOCUMENT_ID}:{version}:content:{index}:0"
        chunks.append(EvidenceChunk(cid, RECORD.service_id, "content", text, RECORD.url,
            source_kind="automatic_document", collected_at="2026-10-28T00:00:00+00:00",
            document_id=DOCUMENT_ID, document_name="업로드 원문", service_name=RECORD.name,
            analysis_hash="a" * 64, processing_mode="automatic", processing_hash="b" * 64,
            source_blocks=(f"b{index}",), page_refs=(index + 1,), parent_index=index,
            parent_id=cid, parent_text=text, start=0, end=len(text), required_parents=(cid,),
            source_hash=source_hash, clean_version=clean, split_version=split,
            embed_digest=digest, version=version))
    return chunks


def test_automatic_source_uses_structure_without_human_review_or_four_sections():
    chunks = automatic_chunks(["온라인 포털에서 신청서를 제출합니다.", "방문 접수는 받지 않습니다."])
    validate_version(chunks)
    restored = read_chunk(chunks[0].chunk_id, RECORD.service_id, chunks[0].storage(), RECORD.url)
    assert restored == chunks[0]
    assert chunks[0].usable_detail
    assert not replace(chunks[0], reviewed_by="local").usable_detail
    with pytest.raises(EvidenceConsistencyError):
        validate_version([replace(chunks[0], text="원문에 없는 내용"), chunks[1]])


def test_automatic_application_restores_its_own_parent_without_section_labels():
    chunks = automatic_chunks(["일반 소개입니다.", "온라인 포털에서 신청서를 제출합니다. 예외는 담당 부서가 확인합니다."])
    parents, required = ChatService._restore(chunks[1], chunks, "application", "신청 방법이 무엇인가요?")
    assert [p.chunk_id for p in parents] == [chunks[1].chunk_id]
    assert required == [chunks[1].chunk_id]
    payload = ChatService._payload({"query": "신청 방법"}, {p.chunk_id: p for p in parents}, [("application", chunks[1], parents, required)])
    assert payload["intents"][0]["core_id"] == chunks[1].chunk_id
    with pytest.raises(EvidenceRequirementError, match="money_or_payment_unit_missing"):
        ChatService._restore(chunks[1], chunks, "benefit", "지원금은 얼마인가요?")


def test_active_documents_from_same_program_keep_their_own_versions():
    first = automatic_chunks(["첫 문서의 신청 방법입니다."])
    second = automatic_chunks(["다른 문서의 지급 내용입니다."])
    other_id = "00000000-0000-0000-0000-000000000002"
    # 별도 문서 ID가 버전 식별자와 부모 ID에 함께 반영된다.
    second = [replace(c, document_id=other_id,
        version=fingerprint(c.source_hash + c.clean_version + c.split_version + c.service_name + c.embed_digest + other_id)[:24]) for c in second]
    second = [replace(c, chunk_id=f"{c.service_id}:document:{other_id}:{c.version}:content:0:0",
        parent_id=f"{c.service_id}:document:{other_id}:{c.version}:content:0:0",
        required_parents=(f"{c.service_id}:document:{other_id}:{c.version}:content:0:0",)) for c in second]
    assert len(active_chunks(first + second)) == 2


class Repository:
    def __init__(self, chunks):
        self.chunks = chunks

    def snapshot(self):
        return CatalogSnapshot([RECORD], self.chunks, "snapshot")

    def dense_search(self, _embedding, k, allowed_ids=None):
        return [replace(c, score=0.9) for c in self.chunks if c.chunk_id in (allowed_ids or [])][:k]


class Model:
    llm_options = {"num_predict": 512}

    def model_digest(self):
        return "test-digest"

    def embed(self, texts):
        return [[0.1] * 1024 for _ in texts]

    def context_limit(self):
        return 8192

    def input_cost(self, system, user):
        return len((system + user).encode()) + 256

    def chat(self, _system, user, *, schema=None):
        data = json.loads(user)
        choices = schema["properties"]["facts"]["items"]["anyOf"]
        facts = [{key: row["properties"][key]["enum"][0] for key in ("intent_id", "chunk_id", "sentence")} for row in choices]
        assert data["evidence"]
        return {"facts": facts, "question_field": "none"}


class Reranker:
    def __init__(self, score=0.9):
        self.value = score

    def score(self, _query, passages):
        return [self.value] * len(passages)


def test_hybrid_search_answers_generic_application_from_exact_source_without_review_gate():
    chunks = automatic_chunks(["온라인 포털에서 신청서를 제출합니다. 방문 접수는 받지 않습니다."])
    service = ChatService(Repository(chunks), Model(), 0.52, 40, reranker=Reranker(),
                          analyzer=lambda text: re.findall(r"[가-힣a-z0-9]+", text.lower()))
    answer, trace = service.answer_with_diagnostics("문서 제도 신청 방법이 무엇인가요?", None)
    assert answer["kind"] == "answer"
    assert "온라인 포털에서 신청서를 제출합니다." in answer["text"]
    assert "방문 접수는 받지 않습니다." in answer["text"]
    assert "사람 검토 없음" in answer["text"]
    assert "검토 문서" not in answer["text"]
    assert trace["unanswered_intents"] == []
    assert trace["retrieval"][0]["keyword"]


def test_semantically_unrelated_source_is_held_without_unverified_model_answer():
    chunks = automatic_chunks(["점검 장비의 색상은 파란색입니다."])
    service = ChatService(Repository(chunks), Model(), 0.52, 40, reranker=Reranker(0),
                          analyzer=lambda text: re.findall(r"[가-힣a-z0-9]+", text.lower()))
    answer = service.answer("문서 제도 신청 방법이 무엇인가요?", None)
    assert answer["kind"] == "fallback"
    assert "신청서를 제출" not in answer["text"]


def test_automatic_database_provenance_roundtrip_preserves_every_block_and_rejects_tampering():
    from BackEnd.documents.contracts import DocumentError, stable_hash
    from BackEnd.documents.indexing import document_children
    from BackEnd.documents.retrieval import validate_document_vectors
    from BackEnd.tests.test_document_automatic_pipeline import source_fixture

    doc, analysis, payload = source_fixture(long=True)
    records = document_children(doc, payload, analysis, doc["service_name"], "digest", len, "tokenizer@revision")
    published = {**doc, "analysis_json": analysis, "markdown": analysis["markdown"], "reviewed_by": None, "reviewed_at": None}
    job = {"job_id": "00000000-0000-0000-0000-000000000003", "embedding_model": "embed", "embedding_digest": "digest",
           "chunk_config": {"processing_mode": "automatic", "payload": payload}}
    rows = []
    for record in records:
        chunk = record["chunk"]
        rows.append({**{key: record[key] for key in ("chunk_index", "char_start", "char_end", "source_spans", "page_start", "page_end")},
            "document_id": doc["document_id"], "job_id": job["job_id"], "chunk_content": chunk.text,
            "embedding_text": chunk.embedding_text(), "input_hash": stable_hash(chunk.embedding_text().encode()),
            "embedding_model": "embed", "embedding_digest": "digest", "char_count": len(chunk.text),
            "section_path": [chunk.section, *chunk.heading_context.splitlines()], "evidence_metadata": {"chunk": json.loads(chunk.storage())}})
    restored, _ = validate_document_vectors(published, job, rows)
    assert len(restored) == len(records)
    assert {c.section for c in restored} == {"content"}
    assert all(c.reviewed_at == "" for c in restored)
    with pytest.raises(DocumentError, match="automatic_processing_mismatch"):
        validate_document_vectors({**published, "source_organization": "임의 변경"}, job, rows)
    with pytest.raises(DocumentError, match="automatic_processing_mismatch"):
        validate_document_vectors({**published, "reviewed_by": "local"}, job, rows)
    changed = [{**row, "source_spans": [dict(span) for span in row["source_spans"]]} for row in rows]
    changed[0]["source_spans"][0]["end"] -= 1
    with pytest.raises(DocumentError, match="source_span_mismatch"):
        validate_document_vectors(published, job, changed)
