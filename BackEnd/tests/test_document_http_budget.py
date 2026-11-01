import asyncio
from threading import Event
import time

import httpx
import pytest

from BackEnd.rag.ollama import OllamaClient, GenerationCancelledError, GenerationTimeoutError


@pytest.mark.parametrize("stage", ["digest", "embedding", "generation"])
@pytest.mark.parametrize("stop", ["timeout", "cancel"])
def test_each_http_stage_closes_on_total_budget_or_cancel(monkeypatch, stage, stop):
    closed, payloads = [], []
    cancelled = Event()
    async def wait():
        await asyncio.sleep(.01)
        if stop == "cancel":
            cancelled.set()
        await asyncio.sleep(2)
    class Response:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): closed.append("response")
        def raise_for_status(self): pass
        async def aiter_bytes(self):
            while True:
                if stop == "cancel":
                    cancelled.set()
                await asyncio.sleep(.005)
                yield b'{"message":{"content":"x"},"done":false}\n'
    class Client:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_): closed.append("client")
        async def get(self, *_a, **_kw): await wait()
        async def post(self, *_a, **_kw): await wait()
        def stream(self, *_args, **kwargs):
            payloads.append(kwargs["json"])
            return Response()
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    client = OllamaClient("http://example.invalid", "embed", "model", request_deadline=time.monotonic() + (.06 if stop == "timeout" else 1),
                          request_cancelled=cancelled.is_set)
    call = {"digest": lambda: client.model_digest(), "embedding": lambda: client.embed(["가상 질의"]),
            "generation": lambda: client.chat_text("규칙", "가상 질의")}[stage]
    with pytest.raises(GenerationTimeoutError if stop == "timeout" else GenerationCancelledError):
        call()
    assert closed == (["response", "client"] if stage == "generation" else ["client"])
    if stage == "generation":
        assert "format" not in payloads[0] and payloads[0]["stream"] is True
    assert not client.last_chat_diagnostics


def test_plain_stream_preserves_prompt_options_and_per_request_metadata(monkeypatch):
    captured = []
    class Response:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        def raise_for_status(self): pass
        async def aiter_bytes(self):
            yield b'{"message":{"content":"plain answer"},"done":true,"eval_count":2,"load_duration":10}\n'
    class Client:
        def __init__(self, **_kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
        def stream(self, *args, **kwargs):
            captured.append(kwargs["json"])
            return Response()
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    original = OllamaClient("http://example.invalid", "embed", "model", llm_options={"temperature": 0, "num_ctx": 8192})
    client = original.for_request(time.monotonic() + 1, lambda: False)
    assert client.chat_text("기존 규칙", "기존 원문 질의") == "plain answer"
    assert captured[0]["messages"] == [{"role": "system", "content": "기존 규칙"}, {"role": "user", "content": "기존 원문 질의"}]
    assert captured[0]["options"] == original.llm_options and "format" not in captured[0]
    assert client.last_chat_diagnostics == {"eval_count": 2, "load_duration": 10}
    assert original.last_chat_diagnostics == {}
