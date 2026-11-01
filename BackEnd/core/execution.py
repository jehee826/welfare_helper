"""문서·화면 추론의 프로세스 내 단일 실행과 협력적 기한·취소를 관리한다."""

import asyncio
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import BoundedSemaphore, Event
from time import monotonic

from fastapi import HTTPException
from starlette.responses import JSONResponse


class ExecutionTimeoutError(RuntimeError):
    pass


class ExecutionCancelledError(RuntimeError):
    pass


@dataclass(frozen=True)
class RequestBudget:
    deadline: float
    cancelled: Event

    def remaining(self) -> float:
        if self.cancelled.is_set():
            raise ExecutionCancelledError()
        remaining = self.deadline - monotonic()
        if remaining <= 0:
            raise ExecutionTimeoutError()
        return remaining


inference_gate = BoundedSemaphore(1)
_budget: ContextVar[RequestBudget | None] = ContextVar("inference_budget", default=None)


def current_budget() -> RequestBudget | None:
    return _budget.get()


def checkpoint() -> None:
    budget = current_budget()
    if budget is not None:
        budget.remaining()


@contextmanager
def inference_request(transport, server_timeout: float, timeout_seconds: int | None = None,
                      *, prefix: str = "request", started_at: float | None = None):
    state = transport.scope.get("state", {}) if transport else {}
    start = state.get("inference_started", monotonic() if started_at is None else started_at)
    budget = RequestBudget(start + min(server_timeout, 1800, timeout_seconds or 1800),
                           state.get("inference_disconnected", Event()))
    if not inference_gate.acquire(blocking=False):
        raise HTTPException(429, "inference_busy", headers={"Retry-After": "1"})
    token = _budget.set(budget)
    try:
        budget.remaining()
        yield budget
        budget.remaining()
    except ExecutionTimeoutError:
        raise HTTPException(504, prefix + "_timeout") from None
    except ExecutionCancelledError:
        raise HTTPException(499, prefix + "_cancelled") from None
    finally:
        # 동기 DB·ONNX 호출을 떠난 뒤에만 반환한다. 바깥 HTTP task 취소로 먼저 반환하지 않는다.
        _budget.reset(token)
        inference_gate.release()


def inference_path(path: str) -> bool:
    return path in {"/api/v1/chat", "/debug/rag", "/api/v1/desktop/guide"} or (
        path.startswith("/api/v1/admin/documents/") and path.endswith(("/query", "/search")))


class InferenceBodyLimit:
    def __init__(self, app, timeout_seconds=lambda: 1800):
        self.app = app
        self.timeout_seconds = timeout_seconds

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST" or not inference_path(scope.get("path", "")):
            return await self.app(scope, receive, send)
        desktop = scope["path"] == "/api/v1/desktop/guide"
        cap = 2 * 1024 * 1024 + 65536 if desktop else 65536
        messages, size = deque(), 0
        scope.setdefault("state", {})["inference_started"] = monotonic()
        try:
            async with asyncio.timeout(min(self.timeout_seconds(), 1800)):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    size += len(message.get("body", b""))
                    if size > cap:
                        code = "desktop_body_size_limit" if desktop else "document_body_size_limit"
                        return await JSONResponse({"detail": code}, status_code=413,
                                                  headers={"Cache-Control": "no-store"})(scope, receive, send)
                    messages.append(message)
                    if not message.get("more_body"):
                        break
        except TimeoutError:
            return await JSONResponse({"detail": "request_timeout"}, status_code=504,
                                      headers={"Cache-Control": "no-store"})(scope, receive, send)
        disconnected = Event()
        scope["state"]["inference_disconnected"] = disconnected

        async def watch_disconnect():
            while True:
                if (await receive())["type"] == "http.disconnect":
                    disconnected.set()
                    return

        watcher = asyncio.create_task(watch_disconnect(), name="inference-disconnect")

        async def replay():
            if messages:
                return messages.popleft()
            await asyncio.shield(watcher)
            return {"type": "http.disconnect"}

        try:
            return await self.app(scope, replay, send)
        except asyncio.CancelledError:
            disconnected.set()
            raise
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
