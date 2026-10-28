from dataclasses import replace
import re
from types import SimpleNamespace

import pytest

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.qa import answer_document
from BackEnd.rag.evidence import EvidenceChunk
from BackEnd.rag.repository import CatalogSnapshot


DOC_ID = "00000000-0000-0000-0000-000000000001"


def components(*, empty=False, failure=None):
    chunk = EvidenceChunk("source:1", "PROGRAM_1", "content", "평균 절대 오차 MAE는 150만 원입니다.", "",
                          document_id=DOC_ID, document_name="선택 PDF", embed_digest="digest", page_refs=(2,), source_blocks=("b1",))
    snapshot = CatalogSnapshot([], [] if empty else [chunk], "snapshot")
    calls = {"prompts": [], "embeddings": 0}

    def embed(texts):
        calls["embeddings"] += 1
        if failure == "embedding":
            raise RuntimeError("private error")
        return [[0.1] * 1024 for _ in texts]

    def generate(system, user):
        calls["prompts"].append((system, user))
        if failure == "generation":
            raise RuntimeError("private prompt")
        return "원문에 따르면 평균 오차는 150만 원입니다."

    def rerank(_query, passages):
        if failure == "reranker":
            raise RuntimeError("private passage")
        return [0.01] * len(passages)

    def dense(vector, k, allowed_ids, *, snapshot):
        assert len(vector) == 1024 and allowed_ids == [chunk.chunk_id]
        assert snapshot.chunks[0].document_id == DOC_ID
        return [replace(chunk, score=0.65)][:k]

    repo = SimpleNamespace(document_scope=DOC_ID, snapshot=lambda: snapshot, dense_search=dense)
    service = SimpleNamespace(llm=SimpleNamespace(model_digest=lambda: "digest", embed=embed, chat_text=generate,
                                                 last_chat_diagnostics={"done_reason": "stop", "eval_count": 20}),
                              reranker=SimpleNamespace(score=rerank), dense_k=30, keyword_k=30, top_n=40, core_k=6,
                              analyzer=lambda text: re.findall(r"[가-힣A-Za-z0-9]+", text.lower()))
    return repo, service, calls


def test_plain_document_rag_uses_ranked_source_without_threshold_or_fact_selection():
    repo, service, calls = components()
    response, trace = answer_document(repo, service, "MAE 평균 오차는 얼마인가요?")
    assert response["kind"] == "answer" and "150만 원" in response["text"]
    assert calls["prompts"][0][1].endswith("질문: MAE 평균 오차는 얼마인가요?")
    assert "평균 절대 오차 MAE는 150만 원입니다." in calls["prompts"][0][1]
    assert response["evidence"][0]["role"] == "retrieved" and response["evidence"][0]["quote"] == ""
    assert response["evidence"][0]["document_id"] == DOC_ID and response["evidence"][0]["pages"] == [2]
    assert trace["rerank"][0]["score"] == 0.01 and trace["rerank"][0]["selected"]
    assert trace["retrieval"][0]["keyword"] and trace["generation_metadata"]["done_reason"] == "stop"


def test_no_source_is_not_reported_as_a_successful_model_answer():
    repo, service, calls = components(empty=True)
    response, trace = answer_document(repo, service, "무엇인가요?")
    assert response["kind"] == "fallback" and response["reason"] == "no_document_evidence"
    assert calls["embeddings"] == 0 and calls["prompts"] == []
    assert trace["reason"] == "no_document_evidence"


@pytest.mark.parametrize("failure", ["embedding", "reranker", "generation"])
def test_real_model_stage_failure_is_exposed_as_a_safe_failure(failure):
    repo, service, _ = components(failure=failure)
    with pytest.raises(DocumentError, match=f"^document_{failure}_failed$"):
        answer_document(repo, service, "질문")


def test_document_scope_is_required_and_other_document_sources_are_rejected():
    repo, service, calls = components()
    repo.document_scope = None
    with pytest.raises(ValueError, match="문서 범위"):
        answer_document(repo, service, "질문")
    repo.document_scope = "00000000-0000-0000-0000-000000000002"
    with pytest.raises(DocumentError, match="document_scope_mismatch"):
        answer_document(repo, service, "질문")
    assert calls["prompts"] == []
