"""채팅·진단·문서별 질의가 공유하는 문서 근거 RAG. 상담 맥락과 원문 근거를 분리한다."""

import math
import time
from dataclasses import replace
from pydantic import ValidationError

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.contacts import (fallback_contacts, contact_candidates, ContactSelectionAnswer,
                                       CONTACT_SELECTION_SYSTEM)
from BackEnd.core.execution import checkpoint, current_budget, ExecutionTimeoutError, ExecutionCancelledError
from BackEnd.core.qa_diagnostics import diagnose_qa, qa_stage, context_preparation, qa_step
from BackEnd.rag.search import BM25Index, reciprocal_ranks
from BackEnd.documents.context import ConversationContext, prepare_context, fit_answer, ANSWER_SYSTEM, EMPTY_EVIDENCE_SYSTEM
from BackEnd.documents.welfare import WelfareAnswer, complete_sources, validate_answer
from BackEnd.documents.stream import DraftStream
from BackEnd.profile_context import ProfileContext

MAX_CACHED_CHUNKS = 2000
MAX_CACHED_INDEX_CHARACTERS = 2_000_000
OUT_OF_SCOPE_TEXT = "저는 복지서비스 챗봇입니다. 해당질문에는 답해드릴수 없습니다"


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


def _validate_answer_selection(raw_answer, included, references, evidence, contact_options,
                               *, select_contacts, empty_evidence, trace):
    referenced = included
    allowed_contacts = {}
    try:
        answer = ContactSelectionAnswer.model_validate(raw_answer) if select_contacts else validate_answer(raw_answer)
        if not answer.text.strip():
            raise ValueError('empty_answer')
        if answer.source_ids is not None:
            source_ids = answer.source_ids
            if (len(set(source_ids)) != len(source_ids) or any(identifier not in references for identifier in source_ids)
                    or answer.status == 'answer' and not source_ids):
                raise ValueError('invalid_source_selection')
            versions = {(document['document_id'], document['version']) for document in included
                        if document['reference_id'] in source_ids}
            # 표시·문의처만 좁히며 선택 문서의 조건·예외와 원문 버전은 함께 보존한다.
            referenced = [document for document in included if (document['document_id'], document['version']) in versions]
            selected_chunks = {document['id'] for document in referenced}
            evidence = [item for item in evidence if item['chunk_id'] in selected_chunks]
            trace['source_reference_selection'] = 'model_selected_document_versions'
        else:
            trace['source_reference_selection'] = 'legacy_server_references'
        allowed_contacts = {candidate['id']: candidate for candidate in contact_options
                            if any(d['document_id'] == candidate['document_id'] and d['version'] == candidate['document_version']
                                   for d in referenced)}
        if select_contacts and (len(set(answer.contact_ids)) != len(answer.contact_ids)
                                or any(identifier not in allowed_contacts for identifier in answer.contact_ids)
                                or answer.status != 'answer' and answer.contact_ids):
            raise ValueError('invalid_contact_selection')
        if empty_evidence and answer.status not in {'out_of_scope', 'no_evidence'}:
            raise ValueError('invalid_scope_answer')
        trace['answer_validation'] = 'accepted'
    except ValidationError:
        answer = None
        trace['answer_validation'] = 'invalid_schema'
    except (ValueError, TypeError) as exc:
        answer = None
        code = str(exc)
        trace['answer_validation'] = code if code == 'empty_answer' else 'invalid_answer'
    return answer, referenced, evidence, allowed_contacts


@diagnose_qa
def answer_document(repo, service, query: str, *, profile=None, history=None, conversation_context=None,
                    select_contacts=False, profile_context=None, on_draft=None):
    consent = ProfileContext.model_validate(profile_context) if profile_context is not None else None
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
    context_preparation(context_trace)
    if len(context_documents) < len(requested_documents):
        context_trace["context_omitted"] = True
        if context_update and context_update["status"] == "unchanged":
            context_update["status"] = "omitted"
    trace["context"] = context_trace
    trace["context"]["profile_used"] = False
    trace["context"]["history_used"] = context_trace["preparation"] == "used" and bool(
        context_trace["selected_user_messages"] or context_trace["preparation_dialogue_messages"])
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
    pending_index = None
    digest = None
    selected, documents = [], []
    if snapshot.chunks:
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
            with qa_step("dense", eligible_count=len(allowed)) as timing:
                scored = repo.dense_search(vector, len(allowed), sorted(allowed), snapshot=snapshot)
                timing["candidate_count"] = len(scored)
            checkpoint()
        except (ExecutionTimeoutError, ExecutionCancelledError):
            raise
        except DocumentError:
            raise
        except Exception:
            raise DocumentError("document_embedding_failed") from None
        with qa_step("bm25_index", input_count=len(snapshot.chunks)):
            index, pending_index = _document_keyword_index(repo, service, snapshot, digest)
        checkpoint()
        with qa_step("bm25_search", eligible_count=len(allowed)) as timing:
            keyword = index.search(search_query, service.keyword_k, allowed)
            timing["candidate_count"] = len(keyword)
        checkpoint()
        with qa_step("rrf") as timing:
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
            timing.update(dense_count=len(dense), keyword_count=len(keyword), union_count=len(union),
                          passing_count=len(passing), candidate_count=len(candidates))
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
            trace["retrieval_reason"] = "low_similarity" if union else "no_document_evidence"

        if candidates:
            qa_stage("rerank")
            rerank_started = time.monotonic()
            passages = [f"문서: {c.document_name}\n{c.heading_context}\n{c.text}" for c in candidates]
            try:
                if hasattr(service.reranker, "score_with_diagnostics"):
                    scores, windows = service.reranker.score_with_diagnostics(search_query, passages)
                else:
                    scores, windows = service.reranker.score(search_query, passages), [{} for _ in passages]
                checkpoint()
                if len(scores) != len(candidates) or len(windows) != len(candidates)                         or any(not math.isfinite(score) for score in scores):
                    raise ValueError("리랭커 응답 형식이 올바르지 않습니다.")
            except (ExecutionTimeoutError, ExecutionCancelledError):
                raise
            except Exception:
                raise DocumentError("document_reranker_failed") from None
            ordered = sorted(zip(candidates, scores, windows), key=lambda row: -row[1])
            selected = [chunk for chunk, _, _ in ordered[:service.core_k]]
            trace["rerank"] = [{"chunk_id": c.chunk_id, "score": score, "selected": i < service.core_k, **window}
                               for i, (c, score, window) in enumerate(ordered)]
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
    else:
        service._document_bm25 = None
        trace["retrieval_reason"] = "no_document_evidence"

    empty_evidence = not documents
    generation_system = EMPTY_EVIDENCE_SYSTEM if empty_evidence else ANSWER_SYSTEM
    contact_options = contact_candidates(snapshot, documents) if select_contacts and not empty_evidence else []
    if select_contacts:
        generation_system += CONTACT_SELECTION_SYSTEM
        for document in documents:
            document['contact_candidates'] = [
                {key: candidate[key] for key in ('id', 'label', 'phone', 'source_url')}
                for candidate in contact_options if candidate['document_id'] == document['document_id']
                and candidate['document_version'] == document['version']]
    qa_stage("generation")
    with qa_step("prompt_prepare", evidence_count=len(documents),
                 document_count=len({d['document_id'] for d in documents})) as timing:
        prompt, included, fitted, omitted = fit_answer(llm, query, conversation, documents, capacity, output, system=generation_system,
                                                     saved_profile=consent.profile.model_dump() if consent else None)
        trace["context"]["context_omitted"] |= omitted
        trace["budget"] = {"context_limit": capacity, "reserved_output": output,
                           "estimated_input": llm.input_cost(generation_system, prompt) if prompt else None,
                           "evidence_omitted": len(documents)-len(included)}
        timing.update(trace["budget"], included_evidence_count=len(included))
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
        schema = (ContactSelectionAnswer if select_contacts else WelfareAnswer).model_json_schema()
        schema['properties']['source_ids'] = {'type': 'array', 'maxItems': min(6, len(references)),
            'items': {'type': 'string', **({'enum': list(references)} if references else {})}}
        schema['required'] = [*schema['required'], 'source_ids']
        if empty_evidence:
            schema['properties']['status']['enum'] = ['out_of_scope', 'no_evidence']
        stream = {'on_content': DraftStream(on_draft).feed} if on_draft is not None else {}
        raw_answer = llm.chat(generation_system, prompt, schema=schema, **stream)
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
    if digest is not None:
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
    answer, referenced, evidence, allowed_contacts = _validate_answer_selection(
        raw_answer, included, references, evidence, contact_options,
        select_contacts=select_contacts, empty_evidence=empty_evidence, trace=trace)
    trace['citation_validation'] = 'not_performed_server_references'
    # 새 인덱스는 요청의 마지막 원문/digest 확인과 취소 점검이 끝난 뒤에만 게시한다.
    checkpoint()
    if pending_index is not None:
        service._document_bm25 = pending_index
    status = answer.status if answer else 'invalid_evidence_answer'
    text = answer.text.strip() if answer else '답변 형식을 확인하지 못했습니다. 잠시 후 다시 질문해 주세요.'
    if status == 'out_of_scope':
        text = OUT_OF_SCOPE_TEXT
        evidence = []
    trace["reason"] = status
    trace["timings_ms"]["total"] = round((time.monotonic() - started) * 1000, 2)
    contacts = []
    if select_contacts:
        chosen = [allowed_contacts[identifier] for identifier in answer.contact_ids] if answer and status == 'answer' else []
        contacts = [candidate['contact'] for candidate in chosen]
        # HTTP 필드가 아닌 서버 내부 전달값이다. 본문·질문·프로필을 저장 경로에 넘기지 않는다.
        trace['selected_contacts'] = [{key: candidate[key] for key in (
            'label', 'phone', 'source_url', 'document_id', 'document_version', 'contact_version')}
            for candidate in chosen]
    elif status == 'answer' and answer.source_ids is not None:
        contacts = [candidate['contact'] for candidate in contact_candidates(snapshot, referenced)]
    elif status in {'answer', 'no_evidence'}:
        confirmed_ids = ([document['document_id'] for document in referenced]
                         if status == 'answer' else list(conversation['document_ids']))
        if repo.document_scope:
            confirmed_ids.append(str(repo.document_scope))
        contact_query = search_query if context_trace['preparation'] in {'used', 'skipped'} else query
        contacts = fallback_contacts(snapshot, referenced, query=contact_query, confirmed_document_ids=confirmed_ids)
    return {"kind": "answer" if status == 'answer' else 'fallback',
            'contacts': contacts,
            **({'reason': status} if status != 'answer' else {}),
            "text": text,
            "services": [], "suggestions": [], "evidence": evidence if answer else [],
            "context_usage": {"omitted": context_trace["context_omitted"]},
            **({"context_update": context_update} if context_update is not None else {})}, trace
