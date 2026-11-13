import json
import os
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from BackEnd.core import chat_rate, execution
from BackEnd.core.settings import Settings
from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.stream import DraftStream, partial_text, stable_draft


def test_partial_text_decodes_only_complete_escapes():
    assert partial_text('{"status":"answer"') == (None, False)
    assert partial_text('{"status":"answer","text":"줄\\n바꿈 \\"인용\\" \\u') == ('줄\n바꿈 "인용" ', False)
    assert partial_text('{"text":"\\ud83d\\ude00끝"') == ('😀끝', True)
    assert partial_text('{"text":"끝\\') == ('끝', False)


def test_stable_draft_holds_back_unfinished_number_runs():
    assert stable_draft('지원 대상입니다. 본인 연락처 010-12', False) == '지원 대상입니다. 본인 연락처'
    assert stable_draft('본인 연락처 010-1234-5678 입니다', True) == '[개인정보 가림] 입니다'
    assert stable_draft('기준 중위소득 50% 이하', True) == '기준 중위소득 50% 이하'


def test_draft_stream_throttles_and_skips_out_of_scope():
    sent, now = [], [0.0]
    stream = DraftStream(sent.append, interval=0.1, clock=lambda: now[0])
    for piece in ['{"status":"answer","text":"가', '나', '다']:
        stream.feed(piece)
    assert sent == ['가']
    now[0] = 0.2
    stream.feed('라"')
    assert sent == ['가', '가나다라']
    blocked = []
    out = DraftStream(blocked.append)
    out.feed('{"status":"out_of_scope","text":"범위 밖 내용"')
    assert blocked == []


def test_ollama_chat_reports_stream_pieces(monkeypatch):
    from BackEnd.rag import ollama
    lines = [{"message": {"content": '{"status":"answer",'}},
             {"message": {"content": '"text":"안내"}'}},
             {"message": {"content": ""}, "done": True, "done_reason": "stop", "prompt_eval_count": 10, "eval_count": 5}]
    def handler(request):
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"model_info": {"x.context_length": 8192}})
        body = "".join(json.dumps(line) + "\n" for line in lines)
        return httpx.Response(200, content=body.encode())
    original = httpx.AsyncClient
    monkeypatch.setattr(ollama.httpx, "AsyncClient",
                        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    client = ollama.OllamaClient("http://model", "bge-m3", "qwen", 30, {"num_ctx": 4096, "num_predict": 64})
    import time
    client = client.for_request(time.monotonic() + 30, lambda: False)
    pieces = []
    assert client.chat("시스템", "질문", schema={"type": "object"}, on_content=pieces.append) == {"status": "answer", "text": "안내"}
    assert pieces == ['{"status":"answer",', '"text":"안내"}']


@pytest.fixture
def api(monkeypatch):
    for name in tuple(os.environ):
        if name.casefold() in {field.casefold() for field in Settings.model_fields}:
            monkeypatch.delenv(name)
    from BackEnd import main
    settings = Settings(_env_file=None)
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(chat_rate, "get_settings", lambda: settings)
    monkeypatch.setattr(chat_rate, "chat_rate_limiter", chat_rate.ChatRateLimiter())
    def unexpected(*args, **kwargs):
        raise AssertionError("실제 DB·모델 진입 금지")
    for name in ("connect", "build_chat_service", "PgServiceRepository", "LocalReranker"):
        monkeypatch.setattr(main, name, unexpected)
    monkeypatch.setitem(main.app.dependency_overrides, main.get_chat_service, lambda: SimpleNamespace(repo=object()))
    calls = []
    def qa(_repo, _service, question, **options):
        calls.append(options)
        if question == "실패":
            raise DocumentError("document_generation_failed")
        if "on_draft" in options:
            options["on_draft"]("초안")
            options["on_draft"]("초안 계속")
        answer = {"kind": "answer", "text": "본인 연락처 010-1234-5678", "contacts": [], "suggestions": []}
        return answer, {}
    monkeypatch.setattr(main, "answer_document", qa)
    with TestClient(main.app) as client:
        yield SimpleNamespace(client=client, calls=calls)


def events(response):
    return [json.loads(line) for line in response.iter_lines() if line]


def test_stream_sends_drafts_then_redacted_final(api):
    with api.client.stream("POST", "/api/v1/chat/stream", json={"query": "지원 대상"}) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert response.headers["cache-control"] == "no-store"
        received = events(response)
    assert [event["type"] for event in received] == ["accepted", "draft", "draft", "final"]
    assert received[1] == {"type": "draft", "text": "초안"}
    assert received[2] == {"type": "draft", "append": " 계속"}
    assert received[-1]["response"]["text"] == "[개인정보 가림]"
    plain = api.client.post("/api/v1/chat", json={"query": "지원 대상"})
    assert plain.status_code == 200 and plain.json() == received[-1]["response"]
    assert "on_draft" not in api.calls[-1]


def test_stream_reports_failures_after_acceptance_as_event(api):
    with api.client.stream("POST", "/api/v1/chat/stream", json={"query": "실패"}) as response:
        assert response.status_code == 200
        received = events(response)
    assert [event["type"] for event in received] == ["accepted", "error"]
    assert received[-1]["status"] == 503 and received[-1]["detail"] == "document_generation_failed"


def test_stream_rejects_busy_and_invalid_requests_before_streaming(api):
    held = [execution.inference_gate.acquire(blocking=False) for _ in range(execution.INFERENCE_CONCURRENCY)]
    try:
        busy = api.client.post("/api/v1/chat/stream", json={"query": "지원 대상"})
    finally:
        for acquired in held:
            if acquired:
                execution.inference_gate.release()
    assert busy.status_code == 429 and busy.headers["retry-after"] == "1"
    invalid = api.client.post("/api/v1/chat/stream", json={"query": "주민번호 900101-1234567"})
    assert invalid.status_code == 422 and invalid.json() == {"detail": "sensitive_input"}
