import json
import math
import asyncio
import socket
import threading
import time

import httpx
import pytest
from fastapi import HTTPException
from langchain_core.messages import AIMessage
from langchain_ollama import ChatOllama
from pydantic import ValidationError
from starlette.requests import Request

from BackEnd.core.settings import Settings
from BackEnd import desktop_connection, desktop_guidance as guide
from BackEnd.rag import ollama


@pytest.mark.parametrize(('value', 'expected'), [(600, 600), (900, 900), (2000, 1800), (0.1, 1)])
def test_connection_exports_actual_bounded_timeout(tmp_path, capsys, value, expected):
    settings = Settings(_env_file=None, ollama_timeout=value, desktop_extension_token='x' * 40)
    destination = tmp_path / 'connection.json'
    desktop_connection.write_connection(destination, settings)
    assert json.loads(destination.read_text())['timeoutSeconds'] == expected
    assert 'x' * 40 not in capsys.readouterr().out


@pytest.mark.parametrize('value', [math.nan, math.inf, -math.inf])
def test_nonfinite_timeout_rejected(value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, ollama_timeout=value)


def test_export_without_token_rejected(tmp_path):
    destination = tmp_path / 'connection.json'
    with pytest.raises(ValueError):
        desktop_connection.write_connection(destination, Settings(_env_file=None, desktop_extension_token=None))
    assert not destination.exists()


def test_wrong_extension_token_rejected_before_model(monkeypatch):
    monkeypatch.setattr(guide, 'get_settings', lambda: Settings(_env_file=None, desktop_guidance_enabled=True, desktop_extension_token='x'*40))
    monkeypatch.setattr(guide, 'OllamaClient', lambda *a, **k: pytest.fail('인증 실패 시 모델 호출 금지'))
    request = guide.DomGuideRequest(source='dom', snapshot_id='F'*20, question='화면 설명', candidates=[])
    transport = Request({'type': 'http', 'headers': [(b'authorization', ('Bearer ' + 'y'*40).encode())]})
    with pytest.raises(HTTPException) as error: guide.desktop_guide(request, transport)
    assert error.value.status_code == 401


def test_connection_refresh_and_failed_replace_preserve_existing_file(tmp_path, monkeypatch):
    destination = tmp_path / 'connection.json'
    initial = Settings(_env_file=None, desktop_extension_token='x'*40, ollama_timeout=600)
    updated = Settings(_env_file=None, desktop_extension_token='y'*40, ollama_timeout=900)
    desktop_connection.write_connection(destination, initial)
    old = destination.read_bytes()
    with monkeypatch.context() as patch:
        patch.setattr(desktop_connection.os, 'replace', lambda *_: (_ for _ in ()).throw(OSError('replace failed')))
        with pytest.raises(OSError): desktop_connection.write_connection(destination, updated)
    assert destination.read_bytes() == old
    assert list(tmp_path.iterdir()) == [destination]
    desktop_connection.write_connection(destination, updated)
    data = json.loads(destination.read_text())
    assert data == {'version': 1, 'token': 'y'*40, 'timeoutSeconds': 900}


def test_metadata_and_generation_share_remaining_budget(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(ollama, 'monotonic', lambda: clock[0])
    captured = {}
    class Response:
        def raise_for_status(self): pass
        def json(self): return {'model_info': {'x.context_length': 8192}}
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def aiter_bytes(self): yield b'{"message":{"content":"{\\"ok\\":true}"},"done":true}\n'
    class Client:
        def __init__(self, timeout): self.timeout = timeout
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, *args, **kwargs):
            captured['metadata'] = self.timeout
            clock[0] += 20
            return Response()
        def stream(self, *args, **kwargs):
            captured['generation'] = self.timeout
            return Response()
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    client = ollama.OllamaClient('http://localhost:11434', 'embed', 'model', timeout=600, request_deadline=160)
    assert client.chat('규칙', '질문', schema={'type': 'object'}) == {'ok': True}
    assert captured == {'metadata': 60, 'generation': 40}


@pytest.mark.parametrize('periodic', [True, False])
def test_wall_clock_timeout_closes_stream_and_client(monkeypatch, periodic):
    closed = []
    class Response:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): closed.append('response')
        def raise_for_status(self): pass
        async def aiter_bytes(self):
            while True:
                await asyncio.sleep(0.01 if periodic else 10)
                yield b'{"message":{"content":"x"},"done":false}\n'
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): closed.append('client')
        def stream(self, *args, **kwargs): return Response()
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    client = ollama.OllamaClient('http://localhost:11434', 'embed', 'model', request_deadline=time.monotonic()+0.08)
    client._effective_context = 8192
    with pytest.raises(ollama.GenerationTimeoutError):
        client.chat('규칙', '질문')
    assert closed == ['response', 'client']


def test_metadata_silence_is_bounded_and_closes_client(monkeypatch):
    closed = []
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): closed.append(True)
        async def post(self, *args, **kwargs): await asyncio.sleep(10)
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    client = ollama.OllamaClient('http://localhost:11434', 'embed', 'model', request_deadline=time.monotonic()+0.08)
    with pytest.raises(ollama.GenerationTimeoutError):
        client.context_limit()
    assert closed == [True]


def test_metadata_silence_is_cancelled_and_closes_client(monkeypatch):
    closed = []
    started = time.monotonic()
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): closed.append(True)
        async def post(self, *args, **kwargs): await asyncio.sleep(10)
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    client = ollama.OllamaClient('http://localhost:11434', 'embed', 'model', request_deadline=started+5,
                                 request_cancelled=lambda: time.monotonic()-started > 0.08)
    with pytest.raises(ollama.GenerationCancelledError): client.context_limit()
    assert closed == [True] and time.monotonic()-started < 2


def test_cancelled_endpoint_is_499_and_gate_is_released(monkeypatch):
    settings = Settings(_env_file=None, desktop_guidance_enabled=True, desktop_extension_token='x'*40)
    monkeypatch.setattr(guide, 'get_settings', lambda: settings)
    monkeypatch.setattr(guide, 'OllamaClient', lambda *args, **kwargs: object())
    monkeypatch.setattr(guide, 'generate_step', lambda *_: (_ for _ in ()).throw(ollama.GenerationCancelledError()))
    request = guide.DomGuideRequest(source='dom', snapshot_id='F'*20, question='화면 설명', candidates=[])
    transport = Request({'type': 'http', 'headers': [(b'authorization', ('Bearer ' + 'x'*40).encode())]})
    with pytest.raises(HTTPException) as error: guide.desktop_guide(request, transport)
    assert error.value.status_code == 499
    assert guide._gate.acquire(blocking=False)
    guide._gate.release()


def test_rag_text_without_deadline_keeps_langchain_path(monkeypatch):
    calls = []
    def invoke(model, prompt, *args, **kwargs):
        calls.append(model.client_kwargs['timeout'])
        return AIMessage(content='공개 자료 설명', response_metadata={'done_reason': 'stop'})
    monkeypatch.setattr(ChatOllama, 'invoke', invoke)
    client = ollama.OllamaClient('http://localhost:11434', 'embed', 'model', timeout=600)
    monkeypatch.setattr(client, '_chat_before_deadline', lambda *args: pytest.fail('RAG에 화면 전용 전송을 사용하면 안 된다'))
    assert client.chat_text('규칙', '질문') == '공개 자료 설명'
    assert calls == [600]


def test_bounded_plain_text_stream_uses_no_format_or_image(monkeypatch):
    captured = []
    class Response:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        def raise_for_status(self): pass
        async def aiter_bytes(self):
            yield b'{"message":{"content":"plain answer"},"done":true,"eval_count":2}\n'
    class Client:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        def stream(self, *_args, **kwargs):
            captured.append(kwargs['json'])
            return Response()
    monkeypatch.setattr(httpx, 'AsyncClient', Client)
    client = ollama.OllamaClient('http://example.invalid', 'embed', 'model', request_deadline=time.monotonic()+3)
    assert client.chat_text('규칙', '가상 질문') == 'plain answer'
    assert captured[0]['stream'] is True and 'format' not in captured[0]
    assert all('images' not in message for message in captured[0]['messages'])


def test_dom_text_http_contract_and_body_limit_with_fake_model(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from BackEnd.core.execution import InferenceBodyLimit
    calls = []
    monkeypatch.setattr(guide, 'get_settings', lambda: Settings(_env_file=None, desktop_guidance_enabled=True,
        desktop_extension_token='x'*40))
    monkeypatch.setenv('BACKEND_BIND_HOST', '127.0.0.1')
    monkeypatch.delenv('VERCEL', raising=False)
    class Client:
        def chat(self, system, user, **kwargs):
            calls.append(kwargs)
            assert 'images' not in kwargs
            return {'kind': '설명', 'answer': '공개 화면입니다.', 'targets': []}
    monkeypatch.setattr(guide, 'OllamaClient', lambda *args, **kwargs: Client())
    app = FastAPI()
    app.add_middleware(InferenceBodyLimit)
    app.include_router(guide.router)
    payload = {'source': 'dom', 'snapshot_id': 'F'*20, 'question': '화면 설명',
               'screen_context': [{'kind': 'heading', 'text': '복지서비스'}], 'candidates': []}
    with TestClient(app) as client:
        headers = {'Authorization': 'Bearer ' + 'x'*40}
        response = client.post('/api/v1/desktop/guide', json=payload, headers=headers)
        assert response.status_code == 200 and response.json()['reply']['snapshot_id'] == 'F'*20
        assert len(calls) == 1
        for image in [None, 'iVBORw0KGgo=']:
            rejected = client.post('/api/v1/desktop/guide', json={**payload, 'image': image}, headers=headers)
            assert rejected.status_code == 422 and len(calls) == 1
        oversized = client.post('/api/v1/desktop/guide', content=b'x'*(2*1024*1024+65537))
        assert oversized.status_code == 413 and len(calls) == 1


def test_http_disconnect_closes_model_stream_and_releases_gate(monkeypatch):
    import uvicorn
    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    from BackEnd.main import app
    entered, closed = threading.Event(), threading.Event()
    model = FastAPI()
    @model.post('/api/show')
    async def show(): return {'model_info': {'x.context_length': 8192}}
    @model.post('/api/chat')
    async def chat():
        async def chunks():
            entered.set()
            try:
                while True:
                    yield b'{"message":{"content":"x"},"done":false}\n'
                    await asyncio.sleep(0.05)
            finally: closed.set()
        return StreamingResponse(chunks(), media_type='application/x-ndjson')
    model_listener = socket.socket()
    model_listener.bind(('127.0.0.1', 0))
    model_listener.listen(8)
    model_server = uvicorn.Server(uvicorn.Config(model, log_level='critical', lifespan='off'))
    model_thread = threading.Thread(target=model_server.run, kwargs={'sockets': [model_listener]}, daemon=True)
    model_thread.start()
    monkeypatch.setattr(guide, 'get_settings', lambda: Settings(_env_file=None, desktop_guidance_enabled=True,
        desktop_extension_token='x'*40, ollama_base_url=f'http://127.0.0.1:{model_listener.getsockname()[1]}'))
    monkeypatch.setenv('BACKEND_BIND_HOST', '127.0.0.1')
    monkeypatch.delenv('VERCEL', raising=False)
    monkeypatch.setattr(guide, 'generate_step', lambda client, request: client.chat('규칙', '질문'))
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(8)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='critical', lifespan='off'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic()+2
        while not (server.started and model_server.started) and time.monotonic()<deadline: time.sleep(0.01)
        assert server.started and model_server.started
        body = json.dumps({'source':'dom','snapshot_id':'F'*20,'question':'화면 설명','candidates':[]}).encode()
        client = socket.create_connection(('127.0.0.1', port), timeout=2)
        client.sendall(b'POST /api/v1/desktop/guide HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+b'x'*40+b'\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
        assert entered.wait(2)
        client.close()
        assert closed.wait(2)
        deadline = time.monotonic()+2
        acquired = False
        while time.monotonic()<deadline:
            if guide._gate.acquire(blocking=False):
                acquired = True
                guide._gate.release()
                break
            time.sleep(0.01)
        assert acquired
        monkeypatch.setattr(guide, 'generate_step', lambda *_: guide.GuideAnswer(kind='설명', answer='공개 화면입니다.', targets=[]))
        response = httpx.post(f'http://127.0.0.1:{port}/api/v1/desktop/guide', content=body,
            headers={'Authorization': 'Bearer ' + 'x'*40, 'Content-Type': 'application/json'}, timeout=2, trust_env=False)
        assert response.status_code == 200
    finally:
        server.should_exit = True
        model_server.should_exit = True
        thread.join(3)
        model_thread.join(3)
        listener.close()
        model_listener.close()
    assert not thread.is_alive() and not model_thread.is_alive()


def test_endpoint_timeout_releases_gate_and_preserves_busy(monkeypatch):
    settings = Settings(_env_file=None, desktop_guidance_enabled=True, desktop_extension_token='x'*40, ollama_timeout=600)
    monkeypatch.setattr(guide, 'get_settings', lambda: settings)
    monkeypatch.setattr(guide, 'monotonic', lambda: 100)
    monkeypatch.setattr('BackEnd.core.execution.monotonic', lambda: 100)
    deadlines = []
    class Client:
        def __init__(self, *args, **kwargs): deadlines.append(kwargs['request_deadline'])
    monkeypatch.setattr(guide, 'OllamaClient', Client)
    monkeypatch.setattr(guide, 'generate_step', lambda *_: (_ for _ in ()).throw(ollama.GenerationTimeoutError()))
    request = guide.DomGuideRequest(source='dom', snapshot_id='F'*20, question='화면 설명', candidates=[], timeout_seconds=20)
    transport = Request({'type': 'http', 'headers': [(b'authorization', ('Bearer ' + 'x'*40).encode())]})
    with pytest.raises(HTTPException) as error:
        guide.desktop_guide(request, transport)
    assert error.value.status_code == 504 and deadlines == [120]
    assert guide._gate.acquire(blocking=False)
    try:
        with pytest.raises(HTTPException) as busy:
            guide.desktop_guide(request, transport)
        assert busy.value.status_code == 429
    finally:
        guide._gate.release()


def test_legacy_request_uses_90_second_deadline(monkeypatch):
    settings = Settings(_env_file=None, desktop_guidance_enabled=True, desktop_extension_token='x'*40, ollama_timeout=600)
    monkeypatch.setattr(guide, 'get_settings', lambda: settings)
    monkeypatch.setattr(guide, 'monotonic', lambda: 100)
    monkeypatch.setattr('BackEnd.core.execution.monotonic', lambda: 100)
    deadlines = []
    class Client:
        def __init__(self, *args, **kwargs): deadlines.append(kwargs['request_deadline'])
    monkeypatch.setattr(guide, 'OllamaClient', Client)
    monkeypatch.setattr(guide, 'generate_step', lambda *_: (_ for _ in ()).throw(ollama.GenerationTimeoutError()))
    request = guide.DomGuideRequest(source='dom', snapshot_id='F'*20, question='화면 설명', candidates=[])
    transport = Request({'type': 'http', 'headers': [(b'authorization', ('Bearer ' + 'x'*40).encode())]})
    with pytest.raises(HTTPException) as error:
        guide.desktop_guide(request, transport)
    assert error.value.status_code == 504 and deadlines == [190]
