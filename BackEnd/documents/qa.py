"""채팅·진단·문서별 질의가 공유하는 문서 근거 RAG. 상담 맥락과 원문 근거를 분리한다."""

import math
import time

from BackEnd.documents.contracts import DocumentError
from BackEnd.core.execution import checkpoint, current_budget, ExecutionTimeoutError, ExecutionCancelledError
from BackEnd.rag.search import BM25Index, reciprocal_ranks
from BackEnd.documents.context import prepare_context, fit_answer, ANSWER_SYSTEM


def answer_document(repo, service, query: str, *, profile=None, history=None, conversation_context=None):
    checkpoint()
    budget = current_budget()
    llm = service.llm.for_request(budget.deadline, budget.cancelled.is_set) if budget else service.llm
    started = time.monotonic()
    trace = {"mode": "document_rag", "scope_document_id": repo.document_scope,
             "retrieval": [], "rerank": [], "timings_ms": {}}
    snapshot = repo.snapshot()
    checkpoint()
    if repo.document_scope and any(chunk.document_id != str(repo.document_scope) for chunk in snapshot.chunks):
        raise DocumentError("document_scope_mismatch")
    trace["snapshot"] = snapshot.stamp
    trace["versions"] = sorted({chunk.version for chunk in snapshot.chunks})
    if not snapshot.chunks:
        trace["reason"] = "no_document_evidence"
        trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
        return {"kind": "fallback", "text": "등록된 문서에서 검색할 원문을 찾지 못했습니다.",
                "reason": "no_document_evidence", "services": [], "contacts": [], "suggestions": [], "evidence": []}, trace

    try:
        capacity = llm.context_limit()
        output = getattr(llm, "llm_options", {}).get("num_predict", 512)
        checkpoint()
        if type(capacity) is not int or type(output) is not int or output <= 0 or capacity <= output:
            raise ValueError("문맥 예산을 확인하지 못했습니다.")
    except (ExecutionTimeoutError, ExecutionCancelledError):
        raise
    except Exception:
        raise DocumentError("document_input_budget") from None
    search_query, conversation, context_update, context_trace = prepare_context(
        llm, query, profile, history, conversation_context, capacity, output)
    trace["context"] = context_trace
    trace["context"]["profile_used"] = bool(conversation["profile"])
    trace["context"]["history_used"] = bool(conversation["history"])
    trace["context"]["summary_used"] = bool(conversation["summary"])
    trace["context"]["summary_status"] = context_update["status"] if context_update else "none"
    trace["context"]["generation_context_policy"] = "resolved_intent_only"
    if conversation["needs_clarification"]:
        trace["reason"] = "conversation_clarification_required"
        trace["timings_ms"]["total"] = round((time.monotonic()-started)*1000, 2)
        return {"kind":"fallback", "text":"이어서 확인할 서비스 이름과 현재 조건을 구체적으로 알려주세요.",
                "reason":"conversation_clarification_required", "services":[], "contacts":[], "suggestions":[], "evidence":[],
                "context_usage":{"omitted":context_trace["context_omitted"]},
                **({"context_update":context_update} if context_update is not None else {})}, trace
    retrieval_started = time.monotonic()
    try:
        digest = llm.model_digest()
        checkpoint()
        allowed = {chunk.chunk_id for chunk in snapshot.chunks if chunk.embed_digest == digest}
        if not allowed:
            raise DocumentError("embedding_digest_changed")
        vector = llm.embed([search_query])[0]
        checkpoint()
        dense = repo.dense_search(vector, service.dense_k, sorted(allowed), snapshot=snapshot)
        checkpoint()
    except (ExecutionTimeoutError, ExecutionCancelledError):
        raise
    except DocumentError:
        raise
    except Exception:
        raise DocumentError("document_embedding_failed") from None
    names = {chunk.service_id: chunk.document_name for chunk in snapshot.chunks}
    index = BM25Index(snapshot.chunks, names, service.analyzer)
    checkpoint()
    keyword = index.search(search_query, service.keyword_k, allowed)
    checkpoint()
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
                "reason": "no_document_evidence", "services": [], "contacts": [], "suggestions": [], "evidence": [],
                "context_usage": {"omitted": context_trace["context_omitted"]},
                **({"context_update": context_update} if context_update is not None else {})}, trace

    rerank_started = time.monotonic()
    passages = [f"문서: {c.document_name}\n{c.heading_context}\n{c.text}" for c in candidates]
    try:
        scores = service.reranker.score(search_query, passages)
        checkpoint()
        if len(scores) != len(candidates) or any(not math.isfinite(score) for score in scores):
            raise ValueError("리랭커 응답 형식이 올바르지 않습니다.")
    except (ExecutionTimeoutError, ExecutionCancelledError):
        raise
    except Exception:
        raise DocumentError("document_reranker_failed") from None
    ordered = sorted(zip(candidates, scores), key=lambda row: -row[1])
    selected = [chunk for chunk, _ in ordered[:service.core_k]]
    trace["rerank"] = [{"chunk_id": c.chunk_id, "score": score, "selected": i < service.core_k}
                       for i, (c, score) in enumerate(ordered)]
    trace["timings_ms"]["rerank"] = round((time.monotonic() - rerank_started) * 1000, 2)
    documents = [{"id": c.chunk_id, "name": c.document_name, "pages": list(c.page_refs),
                  "heading": c.heading_context, "text": c.text} for c in selected]
    prompt, included, fitted, omitted = fit_answer(llm, query, conversation, documents, capacity, output)
    trace["context"]["context_omitted"] |= omitted
    trace["budget"] = {"context_limit": capacity, "reserved_output": output,
                       "estimated_input": llm.input_cost(ANSWER_SYSTEM, prompt) if prompt else None,
                       "evidence_omitted": len(documents)-len(included)}
    if not prompt:
        trace["reason"] = "document_input_budget"
        trace["timings_ms"]["total"] = round((time.monotonic()-started)*1000, 2)
        return {"kind": "fallback", "text": "질문과 최소 원문 근거가 모델 입력 예산을 넘어 답변을 보류했습니다.",
                "reason": "document_input_budget", "services": [], "contacts": [], "suggestions": [], "evidence": [],
                "context_usage": {"omitted": context_trace["context_omitted"]},
                **({"context_update": context_update} if context_update is not None else {})}, trace
    included_ids = {document["id"] for document in included}
    selected = [chunk for chunk in selected if chunk.chunk_id in included_ids]
    trace["context"]["generation_history_messages"] = len(fitted["history"])
    trace["context"]["generation_summary_used"] = bool(fitted["summary"])
    prepared_history = context_trace["preparation"] == "used" and bool(
        context_trace.get("preparation_history_messages", 0) + context_trace["batch_messages"])
    fallback_questions = context_trace["preparation"] not in {"used", "skipped"} and any(
        message["role"] == "user" for message in conversation["history"])
    trace["context"]["history_used"] = bool(fitted["history"]) or prepared_history or fallback_questions
    trace["context"]["summary_used"] = context_trace["preparation_summary_used"] or bool(fitted["summary"])
    evidence = [{"chunk_id": c.chunk_id, "document_id": c.document_id, "role": "retrieved", "quote": "",
                 "text": c.text, "context": c.text, "pages": list(c.page_refs), "source_blocks": list(c.source_blocks),
                 "heading_context": c.heading_context, "source_url": c.source_url} for c in selected]
    generation_started = time.monotonic()
    try:
        checkpoint()
        text = llm.chat_text(ANSWER_SYSTEM, prompt)
        checkpoint()
        if not isinstance(text, str) or not text.strip():
            raise ValueError("빈 모델 응답입니다.")
    except (ExecutionTimeoutError, ExecutionCancelledError):
        raise
    except Exception:
        raise DocumentError("document_generation_failed") from None
    trace["timings_ms"]["generation"] = round((time.monotonic() - generation_started) * 1000, 2)
    trace["generation_metadata"] = dict(llm.last_chat_diagnostics)
    if repo.snapshot().stamp != snapshot.stamp:
        raise DocumentError("document_changed_during_search")
    checkpoint()
    try:
        current_digest = llm.model_digest()
        checkpoint()
    except (ExecutionTimeoutError, ExecutionCancelledError):
        raise
    except Exception:
        raise DocumentError("document_embedding_failed") from None
    if current_digest != digest:
        raise DocumentError("embedding_digest_changed")
    trace["reason"] = "answer"
    trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
    return {"kind": "answer", "text": text.strip(), "services": [], "suggestions": [], "evidence": evidence,
            "context_usage": {"omitted": context_trace["context_omitted"]},
            **({"context_update": context_update} if context_update is not None else {})}, trace
