"""채팅·진단·문서별 질의가 공유하는 문서 근거 RAG. 상담 맥락과 원문 근거를 분리한다."""

import math
import time
from copy import deepcopy
from dataclasses import replace
from pydantic import ValidationError

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.contacts import fallback_contacts
from BackEnd.core.execution import checkpoint, current_budget, ExecutionTimeoutError, ExecutionCancelledError
from BackEnd.core.qa_diagnostics import diagnose_qa, qa_stage
from BackEnd.rag.search import BM25Index, reciprocal_ranks
from BackEnd.documents.context import ConversationContext, prepare_context, fit_answer, ANSWER_SYSTEM
from BackEnd.documents.welfare import WelfareAnswer, complete_sources, validate_answer

MAX_CACHED_CHUNKS = 2000
MAX_CACHED_INDEX_CHARACTERS = 2_000_000


def _document_keyword_index(repo, service, snapshot, digest):
    checkpoint()
    key = (snapshot.stamp, repo.document_scope, getattr(repo, "include_local_documents", False),
           getattr(repo, "embed_model", None), getattr(repo, "embed_dim", None), digest, id(service.analyzer))
    cached = getattr(service, "_document_bm25", None)
    if cached is not None and cached[0] == key:
        return cached[1], None
    # API의 공통 inference gate 안에서 사용한다. 별도 대기 lock과 질문/답변 캐시는 두지 않는다.
    service._document_bm25 = None
    names = {chunk.service_id: chunk.document_name for chunk in snapshot.chunks}
    characters = sum(len(names[c.service_id]) + len(c.section) + len(c.heading_context) + len(c.text) + 3
                     for c in snapshot.chunks)
    index = BM25Index(snapshot.chunks, names, service.analyzer)
    checkpoint()
    keep = len(snapshot.chunks) <= MAX_CACHED_CHUNKS and characters <= MAX_CACHED_INDEX_CHARACTERS
    return index, (key, index) if keep else None


@diagnose_qa
def answer_document(repo, service, query: str, *, profile=None, history=None, conversation_context=None):
    qa_stage("snapshot")
    checkpoint()
    budget = current_budget()
    llm = service.llm.for_request(budget.deadline, budget.cancelled.is_set) if budget else service.llm
    started = time.monotonic()
    trace = {"mode": "document_rag", "scope_document_id": repo.document_scope,
             "retrieval": [], "rerank": [], "timings_ms": {}}
    snapshot = repo.snapshot()
    checkpoint()
    if repo.document_scope and any(chunk.document_id != str(repo.document_scope) for chunk in snapshot.chunks):
        service._document_bm25 = None
        raise DocumentError("document_scope_mismatch")
    trace["snapshot"] = snapshot.stamp
    trace["versions"] = sorted({chunk.version for chunk in snapshot.chunks})
    if not snapshot.chunks:
        service._document_bm25 = None
        trace["reason"] = "no_document_evidence"
        trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
        contacts = fallback_contacts(snapshot)
        text = "등록된 문서에서 검색할 원문을 찾지 못했습니다."
        text += " 아래 문의처에서 확인해 주세요." if contacts else " 확인된 연락처를 제공하지 못했습니다."
        return {"kind": "fallback", "text": text,
                "reason": "no_document_evidence", "services": [], "contacts": contacts, "suggestions": [], "evidence": []}, trace

    qa_stage("context")
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
    submitted_context = ConversationContext.model_validate(conversation_context) if conversation_context is not None else None
    names = {chunk.document_id: chunk.document_name for chunk in snapshot.chunks}
    requested_documents = submitted_context.documentIds if submitted_context else []
    context_documents = [{"id": identifier, "name": names[identifier]} for identifier in requested_documents if identifier in names]
    search_query, conversation, context_update, context_trace = prepare_context(
        llm, query, profile, history, submitted_context, capacity, output, documents=context_documents)
    if len(context_documents) < len(requested_documents):
        context_trace["context_omitted"] = True
        if context_update and context_update["status"] == "unchanged":
            context_update["status"] = "omitted"
    trace["context"] = context_trace
    trace["context"]["profile_used"] = False
    trace["context"]["history_used"] = bool(context_trace["selected_user_messages"])
    trace["context"]["summary_used"] = bool(conversation["summary"])
    trace["context"]["summary_status"] = context_update["status"] if context_update else "none"
    trace["context"]["generation_context_policy"] = "resolved_intent_only"
    if conversation.get("clarification_documents"):
        trace["reason"] = "clarify"
        return {"kind": "fallback", "reason": "clarify",
                "text": "어느 서비스를 말씀하시나요? " + ", ".join(conversation["clarification_documents"]),
                "services": [], "contacts": [], "suggestions": [], "evidence": [],
                "context_usage": {"omitted": context_trace["context_omitted"]},
                **({"context_update": context_update} if context_update is not None else {})}, trace
    qa_stage("retrieval")
    retrieval_started = time.monotonic()
    try:
        digest = llm.model_digest()
        checkpoint()
        allowed = {chunk.chunk_id for chunk in snapshot.chunks if chunk.embed_digest == digest}
        if not allowed:
            raise DocumentError("embedding_digest_changed")
        vector = llm.embed([search_query])[0]
        checkpoint()
        # 저장소가 이미 계산한 전체 코사인을 받아 BM25 전용 후보에도 재사용한다.
        scored = repo.dense_search(vector, len(allowed), sorted(allowed), snapshot=snapshot)
        checkpoint()
    except (ExecutionTimeoutError, ExecutionCancelledError):
        raise
    except DocumentError:
        raise
    except Exception:
        raise DocumentError("document_embedding_failed") from None
    index, pending_index = _document_keyword_index(repo, service, snapshot, digest)
    checkpoint()
    keyword = index.search(search_query, service.keyword_k, allowed)
    checkpoint()
    by_id = {chunk.chunk_id: chunk for chunk in snapshot.chunks if chunk.chunk_id in allowed}
    if (len({c.chunk_id for c in scored}) != len(scored)
            or any(c.chunk_id not in by_id or type(c.score) not in (int, float)
                   or not math.isfinite(c.score) or not -1 <= c.score <= 1 for c in scored)):
        raise DocumentError("document_embedding_failed")
    cosines = {c.chunk_id: c.score for c in scored}
    dense = [replace(by_id[c.chunk_id], score=c.score) for c in scored[:service.dense_k]]
    keyword = [(by_id[c.chunk_id], score) for c, score in keyword if c.chunk_id in by_id]
    union = {c.chunk_id: c for c in [*dense, *(c for c, _ in keyword)]}
    if any(identifier not in cosines for identifier in union):
        raise DocumentError("document_embedding_failed")
    passing = {identifier for identifier in union if cosines[identifier] >= service.min_similarity}
    filtered_dense = [c for c in dense if c.chunk_id in passing]
    filtered_keyword = [c for c, _ in keyword if c.chunk_id in passing]
    fused = reciprocal_ranks([filtered_dense, filtered_keyword])
    candidates = [chunk for chunk, _ in fused[:service.top_n]]
    dense_ids = {c.chunk_id for c in dense}
    keyword_ids = {c.chunk_id for c, _ in keyword}
    trace["retrieval"] = [{"intent_id": "document",
        "dense": [{"chunk_id": c.chunk_id, "rank": i + 1, "similarity": c.score} for i, c in enumerate(dense)],
        "keyword": [{"chunk_id": c.chunk_id, "rank": i + 1, "bm25": score} for i, (c, score) in enumerate(keyword)],
        "dense_threshold": {"configured": service.min_similarity, "enabled": True,
                            "effective": service.min_similarity, "stage": "hybrid_union"},
        "candidates": [{"chunk_id": identifier, "cosine": cosines[identifier],
                        "sources": [name for name, ids in (("dense", dense_ids), ("keyword", keyword_ids)) if identifier in ids],
                        "passed": identifier in passing} for identifier in union],
        "rrf": [{"chunk_id": c.chunk_id, "rank": i + 1, "score": score} for i, (c, score) in enumerate(fused)]}]
    trace["timings_ms"]["retrieval"] = round((time.monotonic() - retrieval_started) * 1000, 2)
    if not candidates:
        reason = "low_similarity" if union else "no_document_evidence"
        trace["reason"] = reason
        trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
        contacts = fallback_contacts(snapshot)
        text = "질문과 충분히 가까운 문서 근거를 찾지 못했습니다." if union else "등록된 문서에서 질문에 사용할 원문을 찾지 못했습니다."
        text += " 아래 문의처에서 확인해 주세요." if contacts else " 확인된 연락처를 제공하지 못했습니다."
        return {"kind": "fallback", "text": text,
                "reason": reason, "services": [], "contacts": contacts, "suggestions": [], "evidence": [],
                "context_usage": {"omitted": context_trace["context_omitted"]},
                **({"context_update": context_update} if context_update is not None else {})}, trace

    qa_stage("rerank")
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
    core_ids = {chunk.chunk_id for chunk in selected}
    selected = complete_sources(snapshot, selected, query+' '+conversation['search_intent'])
    trace['evidence_expansion'] = {'core_chunks': len(core_ids), 'expanded_chunks': len(selected),
                                 'added_chunks': sum(c.chunk_id not in core_ids for c in selected)}
    trace['evidence_policy'] = 'related_parents_and_conditions_within_document_version'
    documents = [{"id": c.chunk_id, "name": c.document_name, "pages": list(c.page_refs),
                  "heading": c.heading_context, "text": c.text, 'document_id':c.document_id,
                  'version':c.version, 'service_id':c.service_id, 'source_url':c.source_url,
                  'source_updated_at':c.source_updated_at, 'basis_year':c.basis_year,
                  **snapshot.document_metadata.get(c.document_id, {})} for c in selected]
    for index, document in enumerate(documents,1):
        document['reference_id'] = f'C{index}'
    qa_stage("generation")
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
    references = {document['reference_id']:document['id'] for document in included}
    trace['source_references'] = references
    selected = [chunk for chunk in selected if chunk.chunk_id in included_ids]
    trace["context"]["generation_history_messages"] = len(fitted["history"])
    trace["context"]["generation_summary_used"] = bool(fitted["summary"])
    trace["context"]["summary_used"] = context_trace["preparation_summary_used"] or bool(fitted["summary"])
    evidence = [{"chunk_id": c.chunk_id, "document_id": c.document_id, "role": "retrieved", "quote": "",
                 "text": c.text, "context": c.text, "pages": list(c.page_refs), "source_blocks": list(c.source_blocks),
                 "heading_context": c.heading_context, "source_url": c.source_url,
                 'source_updated_at':c.source_updated_at, 'basis_year':c.basis_year,
                 **snapshot.document_metadata.get(c.document_id, {})} for c in selected]
    generation_started = time.monotonic()
    try:
        checkpoint()
        schema = WelfareAnswer.model_json_schema()
        schema['$defs']['Citation']['properties']['id']['enum'] = list(references)
        # 비답변 상태와 인용이 함께 생성되지 않도록 상태별 인용 개수를 제한한다.
        definitions = schema.pop('$defs')
        answer_schema = deepcopy(schema)
        answer_schema['properties']['status'] = {'type': 'string', 'enum': ['answer']}
        answer_schema['properties']['citations']['minItems'] = 1
        fallback_schema = deepcopy(schema)
        fallback_schema['properties']['status'] = {'type': 'string', 'enum': ['clarify', 'no_evidence', 'out_of_scope']}
        fallback_schema['properties']['citations']['maxItems'] = 0
        schema = {'$defs': definitions, 'oneOf': [answer_schema, fallback_schema]}
        raw_answer = llm.chat(ANSWER_SYSTEM, prompt, schema=schema)
        checkpoint()
        if not isinstance(raw_answer, dict) or not raw_answer:
            raise ValueError("빈 모델 응답입니다.")
    except (ExecutionTimeoutError, ExecutionCancelledError):
        raise
    except Exception:
        raise DocumentError("document_generation_failed") from None
    trace["timings_ms"]["generation"] = round((time.monotonic() - generation_started) * 1000, 2)
    trace["generation_metadata"] = dict(llm.last_chat_diagnostics)
    qa_stage("validation")
    if repo.snapshot().stamp != snapshot.stamp:
        service._document_bm25 = None
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
        service._document_bm25 = None
        raise DocumentError("embedding_digest_changed")
    try:
        answer = validate_answer(raw_answer, included)
        trace['answer_validation'] = 'accepted'
    except ValidationError:
        answer = None
        trace['answer_validation'] = 'invalid_schema'
    except (ValueError, TypeError) as exc:
        answer = None
        code = str(exc)
        trace['answer_validation'] = code if code in {
            'empty_answer','unsupported_citations','unsupported_clarification_quantity',
            'missing_or_duplicate_citation','citation_not_in_source','unsupported_quantity','unsupported_contact','invalid_source_references'
        } else 'invalid_answer'
    trace['citation_validation'] = 'exact_source_span_and_literal_values_only'
    # 새 인덱스는 요청의 마지막 원문/digest 확인과 취소 점검이 끝난 뒤에만 게시한다.
    checkpoint()
    if pending_index is not None:
        service._document_bm25 = pending_index
    status = answer.status if answer else 'invalid_evidence_answer'
    trace["reason"] = status
    trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
    if status != 'answer':
        messages = {'out_of_scope':'복지서비스의 대상·지원 내용·신청 방법을 안내하고 있습니다. 복지 관련 질문을 알려주세요.',
                    'no_evidence':'현재 자료에서 질문을 뒷받침하는 근거를 확인하지 못했습니다.',
                    'invalid_evidence_answer':'답변과 원문 근거의 대응을 확인하지 못해 답변을 보류했습니다. 담당 기관의 공식 안내를 확인해 주세요.'}
        text = messages.get(status, answer.text if answer else messages['invalid_evidence_answer'])
        contacts = []
        if status == 'no_evidence':
            confirmed_ids = [d['id'] for d in context_documents if context_trace['preparation'] == 'used' and d['name'] in search_query]
            if repo.document_scope:
                confirmed_ids.append(str(repo.document_scope))
            contact_query = search_query if context_trace['preparation'] in {'used', 'skipped'} else query
            contacts = fallback_contacts(snapshot, included, query=contact_query, confirmed_document_ids=confirmed_ids)
            text += ' 아래 문의처에서 확인해 주세요.' if contacts else ' 확인된 연락처를 제공하지 못했습니다.'
        return {'kind':'fallback', 'reason':status, 'text':text,
                'services':[], 'contacts':contacts, 'suggestions':[], 'evidence':[],
                'context_usage':{'omitted':context_trace['context_omitted']},
                **({'context_update':context_update} if context_update is not None else {})}, trace
    quotes = {references[citation.id]:citation.quote for citation in answer.citations}
    for item in evidence:
        item['quote'] = quotes.get(item['chunk_id'], '')
    return {"kind": "answer", "text": answer.text.strip(), "services": [], "suggestions": [], "evidence": evidence,
            "context_usage": {"omitted": context_trace["context_omitted"]},
            **({"context_update": context_update} if context_update is not None else {})}, trace
