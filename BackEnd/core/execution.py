"""문서·화면 추론의 프로세스 내 실행 상한과 협력적 기한·취소를 관리한다."""

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


class GenerationStopped(Exception):
    """스트림 소비자가 필요한 값을 확정해 나머지 생성을 멈출 때 올린다."""


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


INFERENCE_CONCURRENCY = 3
inference_gate = BoundedSemaphore(INFERENCE_CONCURRENCY)
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
    from BackEnd.core.qa_diagnostics import diagnostic_scope, current_diagnostic, record_request_error
    with diagnostic_scope(state.get("timing_diagnostic") or current_diagnostic()):
        if not inference_gate.acquire(blocking=False):
            record_request_error(429)
            raise HTTPException(429, "inference_busy", headers={"Retry-After": "1"})
        token = _budget.set(budget)
        try:
            budget.remaining()
            yield budget
            budget.remaining()
        except ExecutionTimeoutError:
            record_request_error(504)
            raise HTTPException(504, prefix + "_timeout") from None
        except ExecutionCancelledError:
            record_request_error(499)
            raise HTTPException(499, prefix + "_cancelled") from None
        finally:
            # 동기 DB·ONNX 호출을 떠난 뒤에만 반환한다. 바깥 HTTP task 취소로 먼저 반환하지 않는다.
            _budget.reset(token)
            inference_gate.release()


def inference_path(path: str) -> bool:
    return path in {"/api/v1/chat", "/api/v1/chat/stream", "/debug/rag", "/api/v1/conversation/summary", "/api/v1/desktop/guide", "/api/v1/screen/guide"} or (
        path.startswith("/api/v1/admin/documents/") and path.endswith(("/query", "/search")))


class InferenceTiming:
    """가장 바깥 ASGI send 반환을 측정한다. 클라이언트 수신 완료를 뜻하지 않는다."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST" or not inference_path(scope.get("path", "")):
            return await self.app(scope, receive, send)
        from BackEnd.core.qa_diagnostics import Diagnostic, diagnostic_scope, mark_response, finish_response
        state = Diagnostic()
        scope.setdefault("state", {})["timing_diagnostic"] = state
        status = finished = None
        disconnected, send_failed, cancelled, app_failed = False, False, False, False
        disconnected_at_finish = False

        async def observed_receive():
            nonlocal disconnected
            message = await receive()
            if message["type"] == "http.disconnect":
                disconnected = True
            return message

        async def observed_send(message):
            nonlocal status, finished, send_failed, disconnected_at_finish
            if message["type"] == "http.response.start":
                status = message["status"]
            try:
                await send(message)
            except asyncio.CancelledError:
                raise
            except BaseException:
                send_failed = True
                raise
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                finished = monotonic()
                flag = scope["state"].get("inference_disconnected")
                disconnected_at_finish = disconnected or (flag is not None and flag.is_set())

        with diagnostic_scope(state):
            mark_response("request_start")
            try:
                return await self.app(scope, observed_receive, observed_send)
            except asyncio.CancelledError:
                cancelled = True
                raise
            except BaseException:
                app_failed = True
                raise
            finally:
                flag = scope["state"].get("inference_disconnected")
                disconnected |= flag is not None and flag.is_set()
                # 마지막 send 이후의 정상 연결 종료가 이미 끝난 전송을 실패로 바꾸지 않는다.
                if send_failed:
                    outcome = "send_error"
                elif finished is not None:
                    outcome = "disconnected" if disconnected_at_finish else "complete"
                elif cancelled:
                    outcome = "cancelled"
                else:
                    outcome = "disconnected" if disconnected else "incomplete"
                if app_failed:
                    state.outcome_code = "error"
                finish_response(state, status, outcome, finished if finished is not None else monotonic())


class InferenceBodyLimit:
    def __init__(self, app, timeout_seconds=lambda: 1800, screen_enabled=lambda: False):
        self.app = app
        self.timeout_seconds = timeout_seconds
        self.screen_enabled = screen_enabled

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path") == "/api/v1/screen/guide" and not self.screen_enabled():
            return await JSONResponse({"detail": "screen_guidance_disabled"}, status_code=404,
                                      headers={"Cache-Control": "no-store"})(scope, receive, send)
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
