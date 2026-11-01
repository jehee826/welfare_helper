import asyncio
import json
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from BackEnd.core import execution
from BackEnd.core.settings import Settings
from BackEnd.documents.auth import require_document_admin
from BackEnd.documents.store import get_document_store
from BackEnd.tests.test_api import api  # noqa: F401


DOC = "00000000-0000-0000-0000-000000000001"
PATHS = ["/api/v1/chat", "/debug/rag", f"/api/v1/admin/documents/{DOC}/query",
         f"/api/v1/admin/documents/{DOC}/search", "/api/v1/desktop/guide"]


class Exchange:
    def __init__(self, app, path, body):
        self.queue = asyncio.Queue()
        encoded = json.dumps(body).encode()
        self.queue.put_nowait({"type": "http.request", "body": encoded[:7], "more_body": True})
        self.queue.put_nowait({"type": "http.request", "body": encoded[7:], "more_body": False})
        headers = [(b"content-type", b"application/json"), (b"x-rag-debug-token", b"d" * 40)]
        if path == PATHS[-1]:
            headers.append((b"authorization", b"Bearer " + b"x" * 40))
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
                 "method": "POST", "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
                 "root_path": "", "headers": headers, "client": ("127.0.0.1", 1), "server": ("test", 80)}
        self.messages = []
        async def send(message):
            self.messages.append(message)
        self.task = asyncio.create_task(app(scope, self.queue.get, send))

    @property
    def status(self):
        return next((m["status"] for m in self.messages if m["type"] == "http.response.start"), None)

    async def finish(self):
        await asyncio.wait_for(self.task, 3)
        return self.status


def body(path, question="정상 질문"):
    return {"source": "dom", "snapshot_id": "F" * 20, "question": question, "candidates": []} if path == PATHS[-1] else {"query": question}


@pytest.fixture
def bounded_api(api, monkeypatch):
    import BackEnd.desktop_guidance as guide
    import BackEnd.documents.api as documents
    settings = Settings(_env_file=None, documents_enabled=True, desktop_guidance_enabled=True,
                        desktop_extension_token="x" * 40, rag_diagnostics_enabled=True,
                        rag_diagnostics_token="d" * 40, ollama_timeout=2)
    for module in (api.main, documents, guide):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("BACKEND_BIND_HOST", "127.0.0.1")
    entered, release, calls, budgets = Event(), Event(), [], []
    def work(question):
        calls.append(question)
        budgets.append(execution.current_budget().remaining())
        if question == "대기":
            entered.set()
            assert release.wait(2), "검사가 native 대역을 정리하지 못했습니다."
        execution.checkpoint()
    result = {"kind": "fallback", "text": "문서 근거 없음", "contacts": [], "suggestions": []}
    def qa(_repo, _service, question):
        work(question)
        return result, {"mode": "document_rag"}
    monkeypatch.setattr(api.main, "answer_document", qa)
    monkeypatch.setattr("BackEnd.documents.qa.answer_document", qa)
    chunk = SimpleNamespace(chunk_id="chunk", embed_digest="digest", section="content", text="가상 원문",
                            score=.5, start=0, end=5, page_refs=[1], source_blocks=["b1"])
    snapshot = SimpleNamespace(stamp="snapshot", chunks=[chunk])
    repo = SimpleNamespace(snapshot=lambda: snapshot, dense_search=lambda *_a, **_kw: [chunk])
    llm = SimpleNamespace(model_digest=lambda: "digest", embed=lambda texts: (work(texts[0]) or [[.1]]))
    llm.for_request = lambda *_: llm
    monkeypatch.setattr(documents, "scoped_repository", lambda *_: repo)
    monkeypatch.setattr("BackEnd.rag.factory.build_chat_service", lambda *_: SimpleNamespace(repo=repo, llm=llm))
    monkeypatch.setitem(api.main.app.dependency_overrides, require_document_admin, lambda: "test-actor")
    store = SimpleNamespace(status=lambda *_: ({"test_only": False, "program_test_only": False}, None))
    monkeypatch.setitem(api.main.app.dependency_overrides, get_document_store, lambda: store)
    monkeypatch.setattr(guide, "OllamaClient", lambda *_a, **_kw: object())
    def generate(_llm, request):
        work(request.question)
        return guide.GuideAnswer(kind="설명", answer="공개 화면입니다.", targets=[])
    monkeypatch.setattr(guide, "generate_step", generate)
    return SimpleNamespace(**vars(api), settings=settings, entered=entered, release=release, calls=calls, budgets=budgets)


@pytest.mark.parametrize("first_path", PATHS)
def test_all_expensive_routes_share_one_slot_without_a_queue(bounded_api, first_path):
    api = bounded_api
    async def run():
        first = Exchange(api.main.app, first_path, body(first_path, "대기"))
        try:
            assert await asyncio.to_thread(api.entered.wait, 1)
            for path in PATHS:
                other = Exchange(api.main.app, path, body(path))
                assert await other.finish() == 429
                start = next(m for m in other.messages if m["type"] == "http.response.start")
                assert (b"retry-after", b"1") in start["headers"]
            assert api.calls == ["대기"]
        finally:
            api.release.set()
            await first.finish()
        assert first.status == 200
        assert await Exchange(api.main.app, PATHS[0], body(PATHS[0])).finish() == 200
        assert not [t for t in asyncio.all_tasks() if t.get_name() == "inference-disconnect"]
    asyncio.run(run())


@pytest.mark.parametrize("stop", ["timeout", "disconnect", "task_cancel"])
def test_native_work_keeps_slot_until_it_exits_and_never_returns_success(bounded_api, monkeypatch, stop):
    api = bounded_api
    if stop == "timeout":
        monkeypatch.setattr(api.main, "get_settings", lambda: api.settings.model_copy(update={"ollama_timeout": .08}))
    async def run():
        first = Exchange(api.main.app, PATHS[0], body(PATHS[0], "대기"))
        try:
            assert await asyncio.to_thread(api.entered.wait, 1)
            if stop == "disconnect":
                await first.queue.put({"type": "http.disconnect"})
                await asyncio.sleep(.03)
            elif stop == "task_cancel":
                first.task.cancel()
                await asyncio.sleep(.03)
            else:
                await asyncio.sleep(.12)
            acquired = execution.inference_gate.acquire(blocking=False)
            if acquired:
                execution.inference_gate.release()
            assert not acquired
            assert await Exchange(api.main.app, PATHS[1], body(PATHS[1])).finish() == 429
        finally:
            api.release.set()
            try:
                await first.finish()
            except asyncio.CancelledError:
                assert stop == "task_cancel"
        assert first.status != 200
        if stop == "timeout":
            assert first.status == 504
        for _ in range(100):
            if execution.inference_gate.acquire(blocking=False):
                execution.inference_gate.release()
                break
            await asyncio.sleep(.01)
        assert await Exchange(api.main.app, PATHS[0], body(PATHS[0])).finish() == 200
        assert not [t for t in asyncio.all_tasks() if t.get_name() == "inference-disconnect"]
    asyncio.run(run())


def test_body_replay_has_one_consumer_and_cleans_watcher():
    async def run():
        original = asyncio.Queue()
        for message in [{"type": "http.request", "body": b"first", "more_body": True}, {"type": "http.request", "body": b"second", "more_body": False}]:
            original.put_nowait(message)
        active, maximum = 0, 0
        async def receive():
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            try:
                return await original.get()
            finally:
                active -= 1
        async def app(scope, replay, _send):
            assert (await replay())["body"] == b"first"
            assert (await replay())["body"] == b"second"
            await original.put({"type": "http.disconnect"})
            assert (await replay())["type"] == "http.disconnect"
            assert scope["state"]["inference_disconnected"].is_set()
        await execution.InferenceBodyLimit(app)({"type": "http", "method": "POST", "path": PATHS[0]}, receive, Mock())
        assert maximum == 1 and active == 0
        assert not [t for t in asyncio.all_tasks() if t.get_name() == "inference-disconnect"]
    asyncio.run(run())


@pytest.mark.parametrize("case,status", [("limit", 413), ("body_timeout", 504)])
def test_body_limits_reject_before_application_without_env(case, status):
    async def run():
        app = Mock()
        messages = []
        async def receive():
            if case == "limit":
                return {"type": "http.request", "body": b"x" * 65537, "more_body": False}
            await asyncio.sleep(1)
        async def send(message):
            messages.append(message)
        await execution.InferenceBodyLimit(app, timeout_seconds=lambda: .01)({"type": "http", "method": "POST", "path": PATHS[0]}, receive, send)
        assert messages[0]["status"] == status
        app.assert_not_called()
    asyncio.run(run())


@pytest.mark.parametrize("server,client,expected", [(900, None, 900), (2000, None, 1800), (900, 3, 3), (2, 8, 2)])
def test_document_budget_limits_and_context_cleanup(monkeypatch, server, client, expected):
    monkeypatch.setattr(execution, "monotonic", lambda: 100)
    with execution.inference_request(None, server, client) as budget:
        assert budget.deadline == 100 + expected and execution.current_budget() is budget
    assert execution.current_budget() is None


def test_request_llm_has_independent_mutable_state():
    from BackEnd.rag.ollama import OllamaClient
    cached = OllamaClient("http://example.invalid", "embed", "model", llm_options={"num_ctx": 8192})
    first, second = cached.for_request(1, lambda: False), cached.for_request(2, lambda: True)
    first.last_chat_diagnostics["eval_count"] = 99
    first.llm_options["num_ctx"] = 512
    assert not cached.last_chat_diagnostics and not second.last_chat_diagnostics
    assert second.llm_options["num_ctx"] == cached.llm_options["num_ctx"] == 8192
    assert cached.request_deadline is None and first.request_deadline == 1 and second.request_deadline == 2


@pytest.mark.parametrize("path", PATHS[:-1])
def test_document_routes_apply_the_shorter_client_budget(bounded_api, path):
    api = bounded_api
    async def run():
        assert await Exchange(api.main.app, path, {"query": "문서 질문", "timeout_seconds": 1}).finish() == 200
        assert 0 < api.budgets[0] <= 1
    asyncio.run(run())


@pytest.mark.parametrize("value", [0, 1801, True, 1.5, "1"])
def test_document_timeout_requires_bounded_integer(api, value):
    from pydantic import ValidationError
    from BackEnd.documents.api import DocumentQuery
    for model in (api.main.ChatRequest, DocumentQuery):
        with pytest.raises(ValidationError):
            model(query="문서 질문", timeout_seconds=value)


def test_db_cursor_uses_remaining_budget_and_preserves_cancel_status(monkeypatch):
    import psycopg2
    from BackEnd.core.db import RequestCursor
    clock = [100.0]
    monkeypatch.setattr(execution, "monotonic", lambda: clock[0])
    raw = Mock()
    with execution.inference_request(None, 1):
        RequestCursor(raw).execute("SELECT public_data", ("virtual",))
        assert raw.execute.call_args_list[0].args == ("SELECT set_config('statement_timeout', %s, true)", ("1000",))
        assert raw.execute.call_args_list[1].args == ("SELECT public_data", ("virtual",))
    raw.execute.side_effect = [None, psycopg2.errors.QueryCanceled()]
    with pytest.raises(HTTPException) as stopped:
        with execution.inference_request(None, 1):
            RequestCursor(raw).execute("SELECT public_data")
    assert stopped.value.status_code == 504


def test_db_connect_budget_and_late_connection_cleanup(monkeypatch):
    import BackEnd.core.db as db
    clock = [100.0]
    monkeypatch.setattr(execution, "monotonic", lambda: clock[0])
    connection = Mock()
    driver = Mock(return_value=connection)
    monkeypatch.setattr(db.psycopg2, "connect", driver)
    url = "postgresql://user@example.invalid/db?options=-c%20search_path%3Dpublic"
    settings = Settings(_env_file=None, database_url=url)
    with execution.inference_request(None, .5):
        assert db.connect(settings) is connection
    assert driver.call_args.kwargs["connect_timeout"] == 1 and driver.call_args.kwargs["dsn"] == url
    assert "options" not in driver.call_args.kwargs
    def late(**_kwargs):
        clock[0] += 1
        return connection
    driver.side_effect = late
    with pytest.raises(HTTPException) as stopped:
        with execution.inference_request(None, .5):
            db.connect(settings)
    assert stopped.value.status_code == 504
    connection.close.assert_called_once()


def test_store_status_and_snapshot_apply_transaction_local_budget(monkeypatch):
    from unittest.mock import MagicMock
    from BackEnd.documents.store import DocumentStore
    from BackEnd.rag.repository import PgServiceRepository
    connection, raw = MagicMock(), MagicMock()
    connection.__enter__.return_value = connection
    connection.cursor.return_value.__enter__.return_value = raw
    raw.fetchone.return_value = {"document_id": DOC, "jobs": []}
    raw.fetchall.return_value = []
    monkeypatch.setattr("BackEnd.documents.retrieval.active_document_chunks", lambda *_a, **_kw: ([], {}, {}, []))
    with execution.inference_request(None, 2):
        assert DocumentStore(lambda: connection).status(DOC)[0]["document_id"] == DOC
        assert not PgServiceRepository(lambda: connection).snapshot().chunks
    statements = raw.execute.call_args_list
    assert len(statements) == 4
    for index in (0, 2):
        assert statements[index].args[0] == "SELECT set_config('statement_timeout', %s, true)"
        assert 0 < int(statements[index].args[1][0]) <= 2000
    assert "rag_documents" in statements[1].args[0] and "welfare_programs" in statements[3].args[0]
