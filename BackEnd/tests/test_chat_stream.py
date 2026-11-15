import json
import os
import socket
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from BackEnd.core import chat_rate, execution
from BackEnd.core.settings import Settings
from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.stream import DraftStream, partial_text, stable_draft
from BackEnd.tests.test_chat_http_recovery import (  # noqa: F401
    server, assert_available_slots, assert_no_disconnect_watcher,
)


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


@pytest.mark.parametrize('status', ['answer', 'clarify', 'no_evidence', 'out_of_scope', 'unknown'])
def test_text_first_waits_for_complete_top_level_status(status):
    sent = []
    stream = DraftStream(sent.append, interval=0)
    stream.feed('{"text":"먼저 생성된 초안", "status":"')
    assert sent == []
    stream.feed(status)
    assert sent == []
    stream.feed('"}')
    assert sent == (['먼저 생성된 초안'] if status in {'answer', 'clarify', 'no_evidence'} else [])


@pytest.mark.parametrize('prefix', [
    '{"text":"인용 \\"status\\":\\"answer\\"",',
    '{"nested":{"status":"answer","text":"중첩 초안"},"text":"현재 초안",',
    '{"source_ids":["status",{"status":"answer"}],"text":"현재 초안",',
])
def test_quoted_or_nested_status_cannot_allow_an_out_of_scope_draft(prefix):
    sent = []
    stream = DraftStream(sent.append, interval=0)
    stream.feed(prefix)
    assert sent == []
    stream.feed('"status":"out_of_')
    assert sent == []
    stream.feed('scope"}')
    assert sent == []


def test_text_member_ignores_nested_and_quoted_keys():
    raw = json.dumps({'nested': {'text': '숨긴 초안'}, 'source_ids': ['"text":"가짜"'],
                      'text': '실제 초안'}, ensure_ascii=False)
    assert partial_text(raw) == ('실제 초안', True)
    sent = []
    stream = DraftStream(sent.append, interval=0)
    stream.feed('{"status":"answer","text":"인용 \\"status\\":\\"out_of_scope\\""}')
    assert sent == ['인용 "status":"out_of_scope"']


@pytest.mark.parametrize('text', ['본인 연락처 010-1234-5678 입니다',
                                 '주민번호 900101-1234567 입니다', '계좌번호 123456789 입니다'])
def test_stream_masks_private_numbers_across_character_and_unicode_escape_boundaries(text):
    sent = []
    stream = DraftStream(sent.append, interval=0)
    for char in json.dumps({'status': 'answer', 'text': text}, ensure_ascii=True):
        stream.feed(char)
    assert sent and '[개인정보 가림]' in sent[-1]
    assert all(not any(char.isdigit() for char in draft) for draft in sent)


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
        yield SimpleNamespace(client=client, calls=calls, settings=settings)


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


def test_ollama_chat_stops_stream_and_applies_call_output_limit(monkeypatch):
    from BackEnd.core.execution import GenerationStopped
    from BackEnd.rag import ollama
    bodies = []
    lines = [{"message": {"content": '{"relation":'}}, {"message": {"content": '"independent"'}},
             {"message": {"content": "}"}, "done": True, "done_reason": "stop"}]
    def handler(request):
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"model_info": {"x.context_length": 8192}})
        bodies.append(json.loads(request.content))
        return httpx.Response(200, content="".join(json.dumps(line) + "\n" for line in lines).encode())
    original = httpx.AsyncClient
    monkeypatch.setattr(ollama.httpx, "AsyncClient",
                        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    import time
    client = ollama.OllamaClient("http://model", "bge-m3", "qwen", 30, {"num_ctx": 4096, "num_predict": 1024})
    client = client.for_request(time.monotonic() + 30, lambda: False)
    seen = []
    def stop(piece):
        seen.append(piece)
        if len(seen) == 2:
            raise GenerationStopped()
    with pytest.raises(GenerationStopped):
        client.chat("시스템", "질문", schema={"type": "object"}, on_content=stop, num_predict=128)
    assert seen == ['{"relation":', '"independent"']
    assert bodies[0]["options"]["num_predict"] == 128


def test_stream_records_contacts_once_only_for_the_final_answer(api, monkeypatch):
    from BackEnd import main
    api.settings.referral_records_enabled = True
    contact = {'label': '합성 부서', 'phone': '02-123-4567', 'source_url': 'https://example.go.kr/contact'}
    recorded = []
    monkeypatch.setattr(main, 'record_public', lambda identifier, contacts: recorded.append((identifier, contacts)))

    def qa(*args, **options):
        assert options['select_contacts'] is True
        options['on_draft']('초안')
        options['on_draft']('초안 계속')
        assert recorded == []
        return {'kind': 'answer', 'text': '최종 안내', 'contacts': [contact]}, {'selected_contacts': [contact]}

    monkeypatch.setattr(main, 'answer_document', qa)
    with api.client.stream('POST', '/api/v1/chat/stream', json={'query': '합성 문의'}) as response:
        received = events(response)
    assert [item['type'] for item in received] == ['accepted', 'draft', 'draft', 'final']
    assert len(recorded) == 1 and recorded[0][1] == [contact]


def _stream_socket(server, *, timeout_seconds=None):
    sock = socket.create_connection(('127.0.0.1', server.port), timeout=3)
    payload = {'query': '합성 질문'}
    if timeout_seconds is not None:
        payload['timeout_seconds'] = timeout_seconds
    data = json.dumps(payload).encode()
    sock.sendall(b'POST /api/v1/chat/stream HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: '
                 + str(len(data)).encode() + b'\r\n\r\n' + data)
    return sock


def test_disconnect_before_acceptance_does_not_enter_qa_or_leak_slots(server, monkeypatch):
    from BackEnd import main
    original = main._answer_chat
    finished, disconnected = threading.Event(), []

    def delayed(*args, **kwargs):
        disconnected.append(args[1].scope['state']['inference_disconnected'])
        server.entered.set()
        try:
            assert server.release.wait(3)
            return original(*args, **kwargs)
        finally:
            finished.set()

    monkeypatch.setattr(main, '_answer_chat', delayed)
    sock = _stream_socket(server)
    peer = sock.getsockname()[1]
    try:
        assert server.entered.wait(3)
        sock.close()
        assert disconnected[0].wait(3)
        assert_available_slots(3)
    finally:
        sock.close()
        server.release.set()
    assert finished.wait(3) and server.completed[peer].wait(3)
    assert server.calls == [] and 200 not in server.statuses[peer]
    assert_available_slots(3)
    assert_no_disconnect_watcher(server)


@pytest.mark.parametrize('phase', ['draft', 'before_final', 'deadline'])
def test_stream_cancellation_keeps_slot_until_worker_exits_and_never_records(server, monkeypatch, phase):
    from BackEnd import main
    server.settings.referral_records_enabled = True
    original, redact, line = main._answer_chat, main.redact_document, main._stream_line
    finished, encoded, recorded, budgets = threading.Event(), [], [], []
    contact = {'label': '합성 부서', 'phone': '02-123-4567', 'source_url': 'https://example.go.kr/contact'}

    def block():
        server.entered.set()
        while not server.release.wait(.01):
            if budgets[0].cancelled.is_set():
                server.cancelled.set()

    def qa(*args, **options):
        budgets.append(execution.current_budget())
        options['on_draft']('합성 초안')
        if phase != 'before_final':
            block()
            options['on_draft']('취소 뒤 늦은 초안')
        return {'kind': 'answer', 'text': '최종 안내', 'contacts': [contact]}, {'selected_contacts': [contact]}

    def before_final(response):
        if phase == 'before_final':
            block()
        return redact(response)

    def observe(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        finally:
            finished.set()

    monkeypatch.setattr(main, 'answer_document', qa)
    monkeypatch.setattr(main, 'redact_document', before_final)
    monkeypatch.setattr(main, '_answer_chat', observe)
    monkeypatch.setattr(main, '_stream_line', lambda event: (encoded.append(event), line(event))[1])
    monkeypatch.setattr(main, 'record_public', lambda *args: recorded.append(args))
    sock = _stream_socket(server, timeout_seconds=1 if phase == 'deadline' else None)
    peer = sock.getsockname()[1]
    try:
        assert server.entered.wait(3)
        data = b''
        while b'"type": "draft"' not in data:
            data += sock.recv(8192)
        if phase == 'deadline':
            time.sleep(1.15)
        else:
            sock.close()
            assert server.cancelled.wait(3)
        assert_available_slots(2)
        assert not finished.is_set()
    finally:
        server.release.set()
    try:
        assert finished.wait(3) and server.completed[peer].wait(3)
        assert recorded == [] and not any(event['type'] == 'final' for event in encoded)
        assert not any(event.get('text') == '취소 뒤 늦은 초안' for event in encoded)
        if phase == 'deadline':
            assert encoded[-1]['type'] == 'error' and encoded[-1]['status'] == 504
        assert_available_slots(3)
        assert_no_disconnect_watcher(server)
    finally:
        sock.close()
