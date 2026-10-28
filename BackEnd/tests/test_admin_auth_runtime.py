"""공통 비밀번호·세션 폐기·익명 격리와 nullable 접수 계약을 외부 쓰기 없이 확인한다."""
from contextlib import contextmanager
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from BackEnd.core.settings import Settings
from BackEnd.documents.contracts import DocumentError, stable_hash
from BackEnd.documents.store import DocumentStore
import BackEnd.main as api
import BackEnd.admin.session as sessions
import BackEnd.documents.auth as auth
import BackEnd.documents.api as documents

@pytest.fixture
def client(monkeypatch):
    settings = Settings(_env_file=None, documents_enabled=True, admin_password="configured-test-password")
    for module in (api, auth, documents, sessions):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    sessions._sessions.clear(); sessions._failures.clear()
    api.app.dependency_overrides[api.get_chat_service] = lambda: SimpleNamespace(repo=SimpleNamespace(include_local_documents=False))
    monkeypatch.setattr(api, "PgServiceRepository", lambda *a, **kw: SimpleNamespace(**kw))
    monkeypatch.setattr(api, "build_chat_service", lambda repo, settings: SimpleNamespace(repo=repo))
    monkeypatch.setattr(api, "answer_document", lambda repo, service, query: ({"kind":"answer", "text":"관리자 원문" if repo.include_local_documents else "공개 원문", "services":[], "suggestions":[]}, {}))
    yield TestClient(api.app, base_url="https://api.example.invalid")
    api.app.dependency_overrides.clear(); sessions._sessions.clear(); sessions._failures.clear()

def login(client):
    response = client.post("/api/v1/admin/login", json={"password":"configured-test-password"})
    assert response.status_code == 200
    return response.json(), {"Authorization":"Bearer " + response.json()["access_token"]}

def test_login_session_chat_and_server_logout(client):
    body, headers = login(client)
    assert body["expires_at"] - int(sessions.time.time()) in {28799, 28800}
    assert client.get("/api/v1/admin/session", headers=headers).json()["access_mode"] == "shared_password"
    assert client.post("/api/v1/chat", headers=headers, json={"query":"원문 질문"}).json()["text"] == "관리자 원문"
    assert client.post("/api/v1/chat", json={"query":"원문 질문"}).json()["text"] == "공개 원문"
    assert client.post("/api/v1/admin/logout", headers=headers).status_code == 204
    assert client.get("/api/v1/admin/session", headers=headers).status_code == 401
    assert client.post("/api/v1/chat", headers=headers, json={"query":"원문 질문"}).status_code == 401

def test_wrong_password_and_failure_limit(client, monkeypatch):
    for _ in range(5):
        assert client.post("/api/v1/admin/login", json={"password":"wrong"}).status_code == 401
    response = client.post("/api/v1/admin/login", json={"password":"configured-test-password"})
    assert response.status_code == 429 and 1 <= int(response.headers["retry-after"]) <= 60
    future = sessions.time.time() + 61
    monkeypatch.setattr(sessions.time, "time", lambda: future)
    login(client)

def test_expired_session_and_process_restart(client, monkeypatch):
    body, headers = login(client)
    future = body["expires_at"] + 1
    monkeypatch.setattr(sessions.time, "time", lambda: future)
    assert client.get("/api/v1/admin/session", headers=headers).status_code == 401
    _, fresh = login(client)
    sessions._sessions.clear()
    assert client.get("/api/v1/admin/session", headers=fresh).status_code == 401

def test_missing_password_never_allows_loopback_bypass(client, monkeypatch):
    settings = Settings(_env_file=None, documents_enabled=True, admin_password=None)
    monkeypatch.setattr(sessions, "get_settings", lambda: settings)
    assert client.post("/api/v1/admin/login", json={"password":"anything"}).status_code == 503
    assert client.get("/api/v1/admin/session").status_code == 503

def test_invalid_token_and_invalid_login_body_do_not_leak_secrets(client):
    assert client.get("/api/v1/admin/session", headers={"Authorization":"Bearer invalid"}).status_code == 401
    response = client.post("/api/v1/admin/login", json={"password":"private-password" * 30})
    assert response.status_code == 400 and "private-password" not in response.text
    assert response.headers["cache-control"] == "no-store"

def test_session_count_is_bounded(client, monkeypatch):
    monkeypatch.setattr(sessions, "MAX_SESSIONS", 1)
    login(client)
    assert client.post("/api/v1/admin/login", json={"password":"configured-test-password"}).status_code == 503

def test_shared_upload_passes_no_fake_actor_and_records_auth_mode(client):
    _, headers = login(client)
    class Store:
        def register(self, metadata, digest, size, suffix, actor, config, content, **kwargs):
            assert actor is None and kwargs["shared_password"] is True
            assert config["auth_mode"] == "shared_password" and config["artifact_store"] == "postgres-current-v2"
            assert metadata["test_only"] is False
            return {"document_id":"d", "program_id":1, "active_job_id":None}, {"job_id":"j", "state":"queued"}
    api.app.dependency_overrides[documents.get_document_store] = lambda: Store()
    response = client.post("/api/v1/admin/documents", headers=headers,
        data={"metadata":'{"service_id":"WLF_PUBLIC","name":"공개 원문","source_url":"https://example.invalid/source","source_organization":"기관","test_only":false}'},
        files={"file":("source.md", "# 공개 원문\n내용입니다.".encode(), "text/markdown")})
    assert response.status_code == 202 and response.json()["processing_mode"] == "automatic"

@pytest.mark.parametrize("operation", ["cancel", "retry", "replace"])
def test_shared_session_can_manage_legacy_nonlocal_document_without_admin_lookup(monkeypatch, operation):
    class Cursor:
        def execute(self, *a): pass
        def fetchall(self): return [{"program_id":1, "test_only":False}]
    class Store(DocumentStore):
        @contextmanager
        def cursor(self): yield Cursor()
    store = Store(None)
    monkeypatch.setattr(store, "automatic_ready", lambda: True)
    monkeypatch.setattr(store, "_document", lambda *a, **kw: {"program_id":1, "local_ingestion":False, "original_bytes":b"source", "source_url":"https://example.invalid", "source_organization":"기관", "source_updated_at":None,"basis_year":None,"valid_from":None,"valid_until":None,"region_scope":None,"test_only":False,"file_sha256":"hash","file_format":"md","document_name":"원문","service_id":"WLF_PUBLIC"})
    monkeypatch.setattr(store, "_pending", lambda *a: {"job_id":"j", "local_ingestion":False} if operation == "cancel" else None)
    monkeypatch.setattr(store, "_discard", lambda *a: None)
    monkeypatch.setattr(store, "_new_job", lambda *a: {"job_id":"j"})
    if operation == "cancel":
        assert store.cancel("d", None, shared_password=True) == "j"
    elif operation == "retry":
        assert store.retry("d", None, {"auth_mode":"shared_password"}, shared_password=True) == "j"
    else:
        store.register({"service_id":"WLF_PUBLIC","name":"원문","test_only":False}, stable_hash(b"source"), 6, "md", None,
                       {"auth_mode":"shared_password"}, b"source", document_id="d", shared_password=True)
