"""합성 원문으로 인덱스 재사용·상주 한도·취소/교체 경계를 확인한다."""

from dataclasses import replace
from threading import Event

import pytest

from BackEnd.core import execution
from BackEnd.documents import qa
from BackEnd.documents.contracts import DocumentError
from BackEnd.tests.measure_document_bm25 import CountingAnalyzer, components as measured_components


def components(size):
    repo,service,snapshot,calls=measured_components(size)
    original=repo.dense_search
    repo.dense_search=lambda *args,**kwargs:[replace(chunk,score=.65) for chunk in original(*args,**kwargs)]
    service.min_similarity=.52
    return repo,service,snapshot,calls


def ask(repo, service):
    return qa.answer_document(repo, service, "가상 검색 항목")


def test_repeated_qa_reuses_only_document_index_with_same_ranking_and_current_snapshot():
    repo, service, _, calls = components(100)
    legacy = service._bm25 = object()
    results = [ask(repo, service) for _ in range(3)]
    assert all(result[0] == results[0][0] for result in results)
    assert all(result[1]["retrieval"] == results[0][1]["retrieval"] for result in results)
    assert service.analyzer.document_calls == 100 and service.analyzer.query_calls == 3
    assert calls["snapshot"] == 6 and service._bm25 is legacy
    assert service._document_bm25 is not None


@pytest.mark.parametrize("change", ["scope", "permission", "model", "dimension", "analyzer", "snapshot", "digest"])
def test_changed_index_identity_rebuilds_without_reusing_other_scope(change):
    repo, service, snapshot, _ = components(1)
    ask(repo, service)
    previous = service._document_bm25
    if change == "scope":
        repo.document_scope = snapshot.chunks[0].document_id
    elif change == "permission":
        repo.include_local_documents = True
    elif change == "model":
        repo.embed_model = "different-model"
    elif change == "dimension":
        repo.embed_dim = 2048
    elif change == "analyzer":
        service.analyzer = CountingAnalyzer()
    elif change == "snapshot":
        repo.snapshot = lambda: replace(snapshot, stamp="replacement", chunks=[replace(snapshot.chunks[0], text="가상 검색 항목의 바뀐 합성 설명입니다.")])
    else:
        repo.snapshot = lambda: replace(snapshot, chunks=[replace(snapshot.chunks[0], embed_digest="different-digest")])
        service.llm.model_digest = lambda: "different-digest"
    ask(repo, service)
    assert service._document_bm25 is not previous
    assert service.analyzer.document_calls == (1 if change == "analyzer" else 2)


def test_cached_index_never_bypasses_snapshot_failure_empty_catalog_or_wrong_scope():
    repo, service, snapshot, _ = components(2)
    ask(repo, service)

    def fail():
        raise DocumentError("invalid_document_provenance")

    repo.snapshot = fail
    with pytest.raises(DocumentError, match="invalid_document_provenance"):
        ask(repo, service)
    assert service.analyzer.query_calls == 1
    repo.snapshot = lambda: replace(snapshot, chunks=[])
    assert ask(repo, service)[0]["reason"] == "no_evidence"
    assert service._document_bm25 is None
    repo.snapshot = lambda: snapshot
    ask(repo, service)
    repo.document_scope = "different-document"
    with pytest.raises(DocumentError, match="document_scope_mismatch"):
        ask(repo, service)
    assert service._document_bm25 is None


@pytest.mark.parametrize("size,keep", [(2000, True), (2001, False)])
def test_chunk_residency_limit_does_not_reject_or_truncate_large_requests(size, keep):
    repo, service, _, _ = components(size)
    response, _ = ask(repo, service)
    assert response["kind"] == "answer" and service.analyzer.document_calls == size
    assert (service._document_bm25 is not None) == keep


@pytest.mark.parametrize("extra,keep", [(0, True), (1, False)])
def test_exact_index_input_character_limit_is_not_a_heap_or_service_limit(extra, keep):
    repo, service, snapshot, _ = components(1)
    ask(repo, service)
    chunk = snapshot.chunks[0]
    overhead = len(chunk.document_name) + len(chunk.section) + len(chunk.heading_context) + 3
    oversized = replace(snapshot, stamp="large", chunks=[replace(chunk, text="x" * (2_000_000 + extra - overhead))])
    index, pending = qa._document_keyword_index(repo, service, oversized, "synthetic")
    assert len(index.documents) == 1 and len(index.chunks[0].text) == 2_000_000 + extra - overhead
    assert (pending is not None) == keep and service._document_bm25 is None


@pytest.mark.parametrize("stage", ["analysis", "generation"])
def test_failed_request_never_publishes_a_new_index_and_next_request_rebuilds(stage):
    repo, service, _, _ = components(10)
    original_generate = service.llm.chat

    def fail(_text):
        raise RuntimeError("synthetic analyzer failure")

    if stage == "analysis":
        service.analyzer = fail
        expected = RuntimeError
    else:
        service.llm.chat = lambda *args, **kwargs: fail("")
        expected = DocumentError
    with pytest.raises(expected):
        ask(repo, service)
    assert getattr(service, "_document_bm25", None) is None
    service.analyzer = CountingAnalyzer()
    service.llm.chat = original_generate
    assert ask(repo, service)[0]["kind"] == "answer"
    assert service.analyzer.document_calls == 10 and service._document_bm25 is not None


@pytest.mark.parametrize("kind", ["cancel", "timeout"])
def test_cancel_or_deadline_during_index_build_is_not_published(monkeypatch, kind):
    repo, service, _, _ = components(10)
    cancelled, clock = Event(), [0.0]
    analyzer = service.analyzer

    def stop_during_analysis(text):
        tokens = analyzer(text)
        if text.startswith("합성원문 "):
            if kind == "cancel":
                cancelled.set()
            else:
                clock[0] = 2.0
        return tokens

    service.analyzer = stop_during_analysis
    service.llm.for_request = lambda *_: service.llm
    monkeypatch.setattr(execution, "monotonic", lambda: clock[0])
    token = execution._budget.set(execution.RequestBudget(1.0, cancelled))
    try:
        with pytest.raises(execution.ExecutionCancelledError if kind == "cancel" else execution.ExecutionTimeoutError):
            ask(repo, service)
    finally:
        execution._budget.reset(token)
    assert service._document_bm25 is None
    service.analyzer = CountingAnalyzer()
    assert ask(repo, service)[0]["kind"] == "answer"
    assert service.analyzer.document_calls == 10


@pytest.mark.parametrize("warm", [False, True])
def test_final_snapshot_replacement_invalidates_even_a_warm_index(warm):
    repo, service, snapshot, _ = components(10)
    if warm:
        ask(repo, service)
    generate = service.llm.chat
    replacement = replace(snapshot, stamp="published-replacement")

    def replace_document(*args, **kwargs):
        repo.snapshot = lambda: replacement
        return generate(*args, **kwargs)

    service.llm.chat = replace_document
    with pytest.raises(DocumentError, match="document_changed_during_search"):
        ask(repo, service)
    assert service._document_bm25 is None
    service.llm.chat = generate
    assert ask(repo, service)[0]["kind"] == "answer" and service.analyzer.document_calls == 20


def test_final_digest_change_does_not_publish_a_new_index():
    repo, service, _, _ = components(10)
    values = iter(["synthetic", "changed-during-request"])
    service.llm.model_digest = lambda: next(values)
    with pytest.raises(DocumentError, match="embedding_digest_changed"):
        ask(repo, service)
    assert service._document_bm25 is None
    service.llm.model_digest = lambda: "synthetic"
    assert ask(repo, service)[0]["kind"] == "answer" and service.analyzer.document_calls == 20
