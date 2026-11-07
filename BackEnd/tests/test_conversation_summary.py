"""공개 상담 요약의 입력 경계와 모델 1회·검색 0회 계약을 확인한다."""

from types import SimpleNamespace
from unittest.mock import Mock
import asyncio
from threading import Event

import pytest

from BackEnd.core import execution
from BackEnd.core.settings import Settings
from BackEnd.tests.test_api import api  # noqa: F401


PATH = "/api/v1/conversation/summary"


def payload(pairs=1):
    return {"request_id": "A" * 20, "messages": [
        {"id": f"{index:020X}:{role}", "role": role, "content": "질문한 서비스" if role == "user" else "당시 안내와 남은 확인사항"}
        for index in range(pairs) for role in ("user", "assistant")], "partial": False}


@pytest.fixture
def summary_api(api, monkeypatch):
    from BackEnd import conversation_summary as summary
    from BackEnd.core import chat_rate

    settings = Settings(_env_file=None, documents_enabled=True)
    for module in (api.main, summary, chat_rate):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setattr(chat_rate, "chat_rate_limiter", chat_rate.ChatRateLimiter())
    llm = SimpleNamespace(context_limit=Mock(return_value=32768),
                          input_cost=Mock(side_effect=lambda system, user: len((system + user).encode())),
                          chat=Mock(return_value={"text": "당시 상담한 서비스와 남은 확인사항입니다."}))
    llm.for_request = Mock(return_value=llm)
    factory = Mock(return_value=llm)
    monkeypatch.setattr(summary, "summary_client", factory)
    return SimpleNamespace(**vars(api), settings=settings, summary=summary, llm=llm, factory=factory)


def test_summary_echoes_request_and_server_selected_ids_with_one_model_call(summary_api):
    api = summary_api
    body = payload(3)
    response = api.client.post(PATH, json=body)
    assert response.status_code == 200
    assert response.json() == {"request_id": body["request_id"], "text": "당시 상담한 서비스와 남은 확인사항입니다.",
                               "source_message_ids": [message["id"] for message in body["messages"]], "partial": False}
    assert response.headers["cache-control"] == "no-store"
    api.factory.assert_called_once_with(api.settings)
    api.llm.chat.assert_called_once()
    assert "남은 확인사항" in api.llm.chat.call_args.args[1]
    assert api.llm.for_request.call_args.args[0] > 0


@pytest.mark.parametrize("case", ["empty", "odd", "role", "pair", "duplicate", "count", "characters", "privacy", "profile", "request_id", "partial"])
def test_invalid_input_never_constructs_or_calls_model(summary_api, case):
    api = summary_api
    body = payload()
    if case == "empty":
        body["messages"] = []
    elif case == "odd":
        body["messages"].pop()
    elif case == "role":
        body["messages"].reverse()
    elif case == "pair":
        body["messages"][1]["id"] = "B" * 20 + ":assistant"
    elif case == "duplicate":
        body["messages"] *= 2
    elif case == "count":
        body = payload(31)
    elif case == "characters":
        body["messages"][1]["content"] = "가" * 12000
    elif case == "privacy":
        body["messages"][0]["content"] = "010-0000-0000"
    elif case == "profile":
        body["profile"] = {"age": 70}
    elif case == "request_id":
        body["request_id"] = "a" * 20
    else:
        body["partial"] = "true"
    response = api.client.post(PATH, json=body)
    assert response.status_code == 422
    assert response.json() == {"detail": "sensitive_input" if case == "privacy" else "invalid_document_request"}
    assert "010-0000-0000" not in response.text
    api.factory.assert_not_called()


def test_exact_input_limits_and_partial_input_are_preserved(summary_api):
    api = summary_api
    body = payload(30)
    for message in body["messages"]:
        message["content"] = "가" * 200
    body["partial"] = True
    api.llm.input_cost.return_value = 1
    api.llm.input_cost.side_effect = None
    response = api.client.post(PATH, json=body)
    assert response.status_code == 200 and response.json()["partial"] is True
    assert len(response.json()["source_message_ids"]) == 60


def test_model_context_budget_keeps_recent_complete_pairs_and_marks_partial(summary_api):
    api = summary_api
    body = payload(3)
    api.llm.input_cost.side_effect = lambda _system, user: 100000 if '00000000000000000000:user' in user else 1
    response = api.client.post(PATH, json=body)
    assert response.status_code == 200 and response.json()["partial"] is True
    assert response.json()["source_message_ids"] == [message["id"] for message in body["messages"][2:]]
    api.llm.chat.assert_called_once()


def test_no_complete_pair_fits_never_calls_generation(summary_api):
    api = summary_api
    api.llm.context_limit.return_value = 1
    response = api.client.post(PATH, json=payload())
    assert response.status_code == 422 and response.json() == {"detail": "summary_input_budget"}
    api.llm.chat.assert_not_called()


@pytest.mark.parametrize("result", [{"text": ""}, {"text": "가" * 1201}, {"text": "요약", "source_message_ids": ["invented"]}])
def test_invalid_model_output_is_safe_and_not_silently_truncated(summary_api, result):
    api = summary_api
    api.llm.chat.return_value = result
    response = api.client.post(PATH, json=payload())
    assert response.status_code == 503 and response.json() == {"detail": "summary_generation_failed"}
    api.llm.chat.assert_called_once()


def test_capability_and_admin_exclusion_do_not_call_model(summary_api):
    api = summary_api
    assert api.client.get(PATH).json() == {"available": True, "version": 1}
    assert api.client.post(PATH, json=payload(), headers={"Authorization": "Bearer virtual-test-token"}).status_code == 403
    api.settings.documents_enabled = False
    assert api.client.get(PATH).status_code == 404
    api.factory.assert_not_called()


def test_summary_uses_same_rate_and_inference_gate(summary_api):
    api = summary_api
    api.settings.chat_rate_limit_per_minute = 1
    assert execution.inference_path(PATH)
    for _ in range(3):
        assert execution.inference_gate.acquire(blocking=False)
    try:
        response = api.client.post(PATH, json=payload())
        assert response.status_code == 429 and response.json() == {"detail": "inference_busy"}
    finally:
        for _ in range(3):
            execution.inference_gate.release()
    response = api.client.post(PATH, json=payload())
    assert response.status_code == 429 and response.json() == {"detail": "chat_rate_limited"}
    api.factory.assert_not_called()


def test_disconnect_budget_stays_bound_to_model_and_returns_cancelled(summary_api):
    api = summary_api
    def cancel(*_args, **_kwargs):
        budget = execution.current_budget()
        assert budget is not None
        budget.cancelled.set()
        return {"text": "늦은 요약"}
    api.llm.chat.side_effect = cancel
    response = api.client.post(PATH, json=payload())
    assert response.status_code == 499 and response.json() == {"detail": "request_cancelled"}
    assert execution.inference_gate.acquire(blocking=False)
    execution.inference_gate.release()


def test_http_disconnect_keeps_gate_until_summary_native_call_exits(summary_api):
    from BackEnd.tests.test_request_execution import Exchange
    api = summary_api
    entered, release = Event(), Event()
    def generate(*_args, **_kwargs):
        entered.set()
        assert release.wait(2)
        return {"text": "중단 뒤 늦은 요약"}
    api.llm.chat.side_effect = generate
    async def run():
        for _ in range(2):
            assert execution.inference_gate.acquire(blocking=False)
        exchange = Exchange(api.main.app, PATH, payload())
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            await exchange.queue.put({"type": "http.disconnect"})
            await asyncio.sleep(.03)
            acquired = execution.inference_gate.acquire(blocking=False)
            if acquired:
                execution.inference_gate.release()
            assert not acquired
        finally:
            release.set()
            await exchange.finish()
            for _ in range(2):
                execution.inference_gate.release()
        assert exchange.status == 499
        assert not [task for task in asyncio.all_tasks() if task.get_name() == "inference-disconnect"]
    asyncio.run(run())
