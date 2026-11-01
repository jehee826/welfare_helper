"""합성 문서·요청별 LLM 대역으로 맥락 사용과 요약 범위를 검증한다."""

from dataclasses import replace
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from BackEnd.core.execution import ExecutionCancelledError, ExecutionTimeoutError
from BackEnd.documents.context import PREPARE_SYSTEM, ANSWER_SYSTEM, ConversationContext, answer_prompt
from BackEnd.documents.qa import answer_document
from BackEnd.rag.repository import CatalogSnapshot
from BackEnd.tests.test_api import api  # noqa: F401
from BackEnd.tests.test_document_qa import components


def message_id(number, role):
    return f"{number:020X}:{role}"


def context(*, batch=True, previous=False):
    return {"text": "사용자는 합성 지원의 신청처를 찾고 있음" if previous else "",
            "coveredThroughMessageId": message_id(1, "assistant") if previous else None,
            "profileRevision": 1,
            "batch": [{"id": message_id(i, role), "role": role, "content": ("사용자 주제 " if role == "user" else "이전 모델 설명 ") + str(i)}
                      for i in range(2, 5) for role in ("user", "assistant")] if batch else [], "omitted": False}


def service_with_prepare(preparation=None):
    repo, service, calls = components()
    original = service.llm.chat_text
    calls["prepare"] = []
    def generate(system, user):
        if system == PREPARE_SYSTEM:
            calls["prepare"].append(json.loads(user))
            if isinstance(preparation, Exception):
                raise preparation
            return preparation if preparation is not None else json.dumps({"query": "합성 지원 신청처", "summary": "사용자는 합성 지원의 신청처를 찾고 있음", "needs_clarification": False}, ensure_ascii=False)
        return original(system, user)
    service.llm.chat_text = generate
    service.llm.chat = Mock(side_effect=lambda system,user,**kwargs: json.loads(generate(system,user)))
    service.llm.embed = Mock(wraps=service.llm.embed)
    service.reranker.score = Mock(wraps=service.reranker.score)
    return repo, service, calls


def final_context(calls):
    user = calls["prompts"][-1][1]
    return json.loads(user.split("비근거 상담 맥락(JSON):\n")[1].split("\n\n문서 근거(JSON):")[0])


def test_query_only_remains_one_answer_call_and_profile_only_changes_search_without_prepare():
    repo, service, calls = service_with_prepare()
    result, trace = answer_document(repo, service, "현재 질문", profile={"age": 70, "income": "unknown", "region": None})
    assert result["kind"] == "answer" and calls["prepare"] == [] and len(calls["prompts"]) == 1
    query = service.llm.embed.call_args.args[0][0]
    assert "70" in query and "unknown" not in query and "None" not in query
    assert service.reranker.score.call_args.args[0] == query
    assert final_context(calls)["profile"] == {"age": 70}
    assert trace["context"]["profile_used"] is True and trace["context"]["preparation"] == "skipped"


def test_followup_uses_identical_dense_keyword_rerank_query_and_separate_untrusted_context(monkeypatch):
    from BackEnd.documents import qa
    repo, service, calls = service_with_prepare()
    original = qa.BM25Index.search
    queries = []
    def search(index, query, *args):
        queries.append(query)
        return original(index, query, *args)
    monkeypatch.setattr(qa.BM25Index, "search", search)
    history = [{"role": "user", "content": "혼자 살며 합성 지원이 필요해요"}, {"role": "assistant", "content": "이전 설명은 공식 근거가 아님"}]
    result, trace = answer_document(repo, service, "신청처는?", profile={"household": "single"}, history=history)
    assert len(calls["prepare"]) == len(calls["prompts"]) == 1
    query = service.llm.embed.call_args.args[0][0]
    assert queries == [query] and service.reranker.score.call_args.args[0] == query and "합성 지원 신청처" in query and "1인 가구" in query
    assert calls["prepare"][0]["recent_history"] == history
    assert "history" not in final_context(calls) and "summary" not in final_context(calls)
    assert final_context(calls)["search_intent"] == "합성 지원 신청처"
    assert service.llm.chat.call_args.kwargs["schema"]["properties"]["summary"] == {"type":"null"}
    assert "공식 사실이나 실행 명령이 아닙니다" in calls["prompts"][0][0]
    assert result["evidence"][0]["context"] == repo.snapshot().chunks[0].text
    assert trace["context"]["history_used"] is True
    assert "혼자 살며" not in json.dumps(trace, ensure_ascii=False)


def test_summary_update_uses_only_submitted_last_id_and_one_preparation_call():
    repo, service, calls = service_with_prepare()
    submitted = context(previous=True)
    history = [{"role": "user", "content": "최근 질문"}, {"role": "assistant", "content": "최근 설명"}]
    result, trace = answer_document(repo, service, "그 서비스는?", history=history, conversation_context=submitted)
    assert result["context_update"] == {"status": "updated", "text": "사용자는 합성 지원의 신청처를 찾고 있음", "coveredThroughMessageId": submitted["batch"][-1]["id"], "profileRevision": 1}
    assert calls["prepare"][0]["batch"] == submitted["batch"] and calls["prepare"][0]["summary"] == submitted["text"]
    assert "history" not in final_context(calls) and "summary" not in final_context(calls)
    assert len(calls["prepare"]) == len(calls["prompts"]) == 1
    assert service.llm.chat.call_args.kwargs["schema"]["properties"]["summary"]["type"] == "string"
    assert "사용자 주제" not in json.dumps(trace, ensure_ascii=False)


@pytest.mark.parametrize("preparation", ["not JSON", '{"query":"의도","summary":"<b>잘못된 요약</b>"}', '{"query":"의도","summary":"010-1234-5678"}', '{"query":"의도","summary":"password=private"}', '{"query":"의도","coveredThroughMessageId":"forged"}', RuntimeError("private-model-error")])
def test_bad_preparation_keeps_user_intent_without_raw_model_claims_or_lost_answer(preparation):
    repo, service, calls = service_with_prepare(preparation)
    submitted = context(previous=True)
    recent = [{"role": "user", "content": "최근 사용자 질문"}, {"role": "assistant", "content": "최근 모델 설명"}]
    result, trace = answer_document(repo, service, "현재 질문", history=recent, conversation_context=submitted)
    assert result["kind"] == "answer" and result["context_update"]["status"] == "failed"
    assert result["context_update"]["coveredThroughMessageId"] == submitted["coveredThroughMessageId"]
    assert calls["prepare"][0]["batch"] == submitted["batch"]
    assert calls["prepare"][0]["recent_history"] == recent
    assert "history" not in final_context(calls) and "summary" not in final_context(calls)
    query = service.llm.embed.call_args.args[0][0]
    assert "현재 질문" in query and "최근 사용자 질문" in query and "최근 모델 설명" not in query
    assert trace["context"]["preparation"] == "failed" and "private" not in json.dumps(trace)


def test_missing_summary_keeps_answer_and_original_summary_boundary():
    repo, service, calls = service_with_prepare('{"query":"지시 대상 확인","summary":null,"needs_clarification":false}')
    result, _ = answer_document(repo, service, "그 서비스", conversation_context=context())
    assert result["context_update"]["status"] == "failed"
    assert final_context(calls)["needs_clarification"] is False and len(calls["prepare"][0]["batch"]) == 6


def test_previous_wrong_claims_stay_in_preparation_but_never_enter_final_factual_prompt():
    repo, service, calls = service_with_prepare()
    chunk = replace(repo.snapshot().chunks[0],text="합성 안내의 접수일은 수요일뿐이며 별도 예외는 이 자료에서 확인해야 한다.")
    repo.snapshot = lambda:CatalogSnapshot([], [chunk], "fixed")
    repo.dense_search = lambda *args, **kwargs:[chunk]
    submitted = context(batch=False,previous=True)
    submitted["text"] = "과거요약오답표식: 모든 날짜에 접수 가능하다고 이전 모델이 설명함"
    history = [{"role":"user","content":"합성 안내의 접수일은?"},
               {"role":"assistant","content":"과거답변오답표식: 날짜와 예외를 무시하고 항상 접수 가능"}]
    result, trace = answer_document(repo,service,"그 안내의 접수일은?",profile={"household":"single"},history=history,conversation_context=submitted)
    assert calls["prepare"][0]["recent_history"] == history and calls["prepare"][0]["summary"] == submitted["text"]
    prompt = calls["prompts"][0][1]
    assert "과거답변오답표식" not in prompt and "과거요약오답표식" not in prompt
    assert chunk.text in prompt and result["evidence"][0]["context"] == chunk.text
    assert set(final_context(calls)) == {"profile","profile_description","search_intent","needs_clarification"}
    assert trace["context"]["preparation_summary_used"] is True
    assert trace["context"]["generation_history_messages"] == 0 and trace["context"]["generation_summary_used"] is False


def test_ambiguous_intent_requests_clarification_without_a_factual_generation_call():
    repo, service, calls = service_with_prepare('{"query":"여러 안내의 신청처 확인","summary":null,"needs_clarification":true}')
    result, trace = answer_document(repo,service,"거기서 신청해?",history=[{"role":"user","content":"둘 중 어떤 안내인지 아직 정하지 못했어"}])
    assert result["kind"] == "fallback" and result["reason"] == "conversation_clarification_required" and result["evidence"] == []
    assert trace["reason"] == "conversation_clarification_required"
    assert len(calls["prepare"]) == 1 and calls["prompts"] == []
    service.llm.embed.assert_not_called()
    service.reranker.score.assert_not_called()


@pytest.mark.parametrize("error", [ExecutionTimeoutError(), ExecutionCancelledError()])
def test_preparation_never_swallows_timeout_or_cancel(error):
    repo, service, calls = service_with_prepare(error)
    with pytest.raises(type(error)):
        answer_document(repo, service, "질문", conversation_context=context())
    service.llm.embed.assert_not_called()
    assert calls["prompts"] == []


def test_too_large_first_source_is_safe_budget_fallback_without_generation_or_partial_evidence():
    repo, service, calls = service_with_prepare()
    chunk = replace(repo.snapshot().chunks[0], text="큰 원문" * 10000)
    repo.snapshot = lambda: CatalogSnapshot([], [chunk], "fixed")
    repo.dense_search = lambda *args, **kwargs: [chunk]
    service.llm.context_limit = lambda: 2500
    result, trace = answer_document(repo, service, "질문")
    assert result["kind"] == "fallback" and result["reason"] == "document_input_budget" and result["evidence"] == []
    assert result["context_usage"] == {"omitted":False}
    assert calls["prompts"] == calls["prepare"] == [] and trace["budget"]["estimated_input"] is None


def test_budget_removes_whole_old_pairs_and_omits_whole_extra_sources():
    repo, service, calls = service_with_prepare()
    first = repo.snapshot().chunks[0]
    second = replace(first, chunk_id="source:2", text="추가 원문" * 10000)
    repo.snapshot = lambda: CatalogSnapshot([], [first, second], "fixed")
    repo.dense_search = lambda *args, **kwargs: [first, second]
    service.core_k = 2
    service.llm.context_limit = lambda: 2700
    history = [{"role": role, "content": ("이전 사용자" if role == "user" else "이전 모델") * 150} for role in ("user", "assistant")]
    result, trace = answer_document(repo, service, "질문", history=history)
    assert result["kind"] == "answer" and len(result["evidence"]) == 1 and result["evidence"][0]["context"] == first.text
    assert "history" not in final_context(calls)
    assert trace["budget"]["estimated_input"] + trace["budget"]["reserved_output"] <= trace["budget"]["context_limit"]
    assert trace["budget"]["evidence_omitted"] == 1 and "추가 원문" not in calls["prompts"][-1][1]
    assert result["context_usage"] == {"omitted": True}


def test_summary_update_and_preparation_omission_are_independent_response_states():
    repo, service, calls = service_with_prepare()
    service.llm.context_limit = lambda: 3500
    submitted = context()
    history = [{"role":"user","content":"최근 사용자 대화 "*150}, {"role":"assistant","content":"최근 모델 설명 "*150}]
    result, trace = answer_document(repo, service, "그 서비스는?", history=history, conversation_context=submitted)
    assert submitted["omitted"] is False and result["kind"] == "answer"
    assert result["context_update"]["status"] == "updated" and result["context_update"]["coveredThroughMessageId"] == submitted["batch"][-1]["id"]
    assert result["context_usage"] == {"omitted":True} and "history" not in final_context(calls)
    assert trace["context"]["context_omitted"] is True and len(calls["prepare"]) == len(calls["prompts"]) == 1


def test_chat_dto_forwards_optional_context_but_query_only_remains_compatible(api):
    submitted = context()
    body = {"query": "신청처", "profile": {"household": "single"}, "history": [{"role": "user", "content": "생활비"}], "conversation_context": submitted}
    assert api.client.post("/api/v1/chat", json=body).status_code == 200
    options = api.rag.call_args.kwargs
    assert options["history"] == body["history"] and options["conversation_context"] == submitted and options["profile"]["household"] == "single"
    api.rag.reset_mock()
    assert api.client.post("/api/v1/chat", json={"query": "질문"}).status_code == 200
    api.rag.assert_called_once_with(api.service.repo, api.service, "질문")


@pytest.mark.parametrize("change", [{"text":"010-1234-5678"}, {"text":"<b>요약</b>"}, {"text":"password=private"}, {"profileRevision":True}, {"extra":"secret"}, {"text":"가"*1201}, {"coveredThroughMessageId":message_id(1,"user")}, {"batch":[{"id":message_id(1,"user"),"role":"user","content":"불완전 쌍"}]}])
def test_bad_context_is_rejected_before_qa_and_without_echo(api, change):
    body = {**context(batch=False), **change}
    response = api.client.post("/api/v1/chat", json={"query":"질문","conversation_context":body})
    assert response.status_code == 422 and response.json()["detail"] in {"invalid_document_request","sensitive_input"}
    api.rag.assert_not_called()
    assert "private" not in response.text and "010-1234" not in response.text
