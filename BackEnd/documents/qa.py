"""게시된 문서의 검색 원문을 모델에 전달하는 기본 RAG 질의 경로."""

import math
import time

from BackEnd.documents.contracts import DocumentError
from BackEnd.rag.search import BM25Index, reciprocal_ranks


def answer_document(repo, service, query: str):
    started = time.monotonic()
    trace = {"mode": "document_rag", "scope_document_id": repo.document_scope,
             "retrieval": [], "rerank": [], "timings_ms": {}}
    snapshot = repo.snapshot()
    if repo.document_scope and any(chunk.document_id != str(repo.document_scope) for chunk in snapshot.chunks):
        raise DocumentError("document_scope_mismatch")
    trace["snapshot"] = snapshot.stamp
    trace["versions"] = sorted({chunk.version for chunk in snapshot.chunks})
    if not snapshot.chunks:
        trace["reason"] = "no_document_evidence"
        trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
        return {"kind": "fallback", "text": "등록된 문서에서 검색할 원문을 찾지 못했습니다.",
                "reason": "no_document_evidence", "services": [], "contacts": [], "suggestions": [], "evidence": []}, trace

    retrieval_started = time.monotonic()
    try:
        digest = service.llm.model_digest()
        allowed = {chunk.chunk_id for chunk in snapshot.chunks if chunk.embed_digest == digest}
        if not allowed:
            raise DocumentError("embedding_digest_changed")
        vector = service.llm.embed([query])[0]
        dense = repo.dense_search(vector, service.dense_k, sorted(allowed), snapshot=snapshot)
    except DocumentError:
        raise
    except Exception:
        raise DocumentError("document_embedding_failed") from None
    names = {chunk.service_id: chunk.document_name for chunk in snapshot.chunks}
    index = BM25Index(snapshot.chunks, names, service.analyzer)
    keyword = index.search(query, service.keyword_k, allowed)
    fused = reciprocal_ranks([dense, [chunk for chunk, _ in keyword]])
    candidates = [chunk for chunk, _ in fused[:service.top_n]]
    trace["retrieval"] = [{"intent_id": "document",
        "dense": [{"chunk_id": c.chunk_id, "rank": i + 1, "similarity": c.score} for i, c in enumerate(dense)],
        "keyword": [{"chunk_id": c.chunk_id, "rank": i + 1, "bm25": score} for i, (c, score) in enumerate(keyword)],
        "rrf": [{"chunk_id": c.chunk_id, "rank": i + 1, "score": score} for i, (c, score) in enumerate(fused)]}]
    trace["timings_ms"]["retrieval"] = round((time.monotonic() - retrieval_started) * 1000, 2)
    if not candidates:
        trace["reason"] = "no_document_evidence"
        trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
        return {"kind": "fallback", "text": "등록된 문서에서 질문에 사용할 원문을 찾지 못했습니다.",
                "reason": "no_document_evidence", "services": [], "contacts": [], "suggestions": [], "evidence": []}, trace

    rerank_started = time.monotonic()
    passages = [f"문서: {c.document_name}\n{c.heading_context}\n{c.text}" for c in candidates]
    try:
        scores = service.reranker.score(query, passages)
        if len(scores) != len(candidates) or any(not math.isfinite(score) for score in scores):
            raise ValueError("리랭커 응답 형식이 올바르지 않습니다.")
    except Exception:
        raise DocumentError("document_reranker_failed") from None
    ordered = sorted(zip(candidates, scores), key=lambda row: -row[1])
    selected = [chunk for chunk, _ in ordered[:service.core_k]]
    trace["rerank"] = [{"chunk_id": c.chunk_id, "score": score, "selected": i < service.core_k}
                       for i, (c, score) in enumerate(ordered)]
    trace["timings_ms"]["rerank"] = round((time.monotonic() - rerank_started) * 1000, 2)
    evidence = [{"chunk_id": c.chunk_id, "document_id": c.document_id, "role": "retrieved", "quote": "",
                 "text": c.text, "context": c.text, "pages": list(c.page_refs), "source_blocks": list(c.source_blocks),
                 "heading_context": c.heading_context, "source_url": c.source_url} for c in selected]
    context = "\n\n".join(f"[자료 {i + 1}] {c.document_name}\n쪽: {','.join(map(str, c.page_refs))}\n{c.heading_context}\n{c.text}"
                            for i, c in enumerate(selected))
    generation_started = time.monotonic()
    try:
        text = service.llm.chat_text(
            "제공된 문서 근거로 질문에 답하세요. 자료에 없는 내용은 없다고 말하세요.",
            f"문서 근거:\n{context}\n\n질문: {query}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("빈 모델 응답입니다.")
    except Exception:
        raise DocumentError("document_generation_failed") from None
    trace["timings_ms"]["generation"] = round((time.monotonic() - generation_started) * 1000, 2)
    trace["generation_metadata"] = service.llm.last_chat_diagnostics
    if repo.snapshot().stamp != snapshot.stamp:
        raise DocumentError("document_changed_during_search")
    try:
        current_digest = service.llm.model_digest()
    except Exception:
        raise DocumentError("document_embedding_failed") from None
    if current_digest != digest:
        raise DocumentError("embedding_digest_changed")
    trace["reason"] = "answer"
    trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
    return {"kind": "answer", "text": text.strip(), "services": [], "suggestions": [], "evidence": evidence}, trace
