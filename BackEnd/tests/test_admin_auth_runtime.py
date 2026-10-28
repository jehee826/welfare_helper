"""공개 관리자 인증과 일반/관리자 채팅 격리를 외부 호출 없이 확인한다."""

from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

import BackEnd.main as api
import BackEnd.documents.auth as auth
import BackEnd.documents.api as documents
from BackEnd.core.settings import Settings


@pytest.fixture
def setup_auth(monkeypatch):
    settings = Settings(_env_file=None, documents_enabled=True, documents_local_mode=False,
                        supabase_url="https://project.example.invalid", supabase_publishable_key="sb_publishable_dummy")
    actor = str(uuid4())
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(api, "get_settings", lambda: settings)
    monkeypatch.setattr(documents, "get_settings", lambda: settings)
    api.app.dependency_overrides[api.get_chat_service] = lambda: SimpleNamespace(repo=SimpleNamespace(include_local_documents=False))
    monkeypatch.setattr(api, "PgServiceRepository", lambda *a, **kw: SimpleNamespace(**kw))
    monkeypatch.setattr(api, "build_chat_service", lambda repo, settings: SimpleNamespace(repo=repo))
    monkeypatch.setattr(api, "answer_document", lambda repo, service, query: (
        {"kind": "answer", "text": "관리자 원문" if repo.include_local_documents else "공개 원문", "services": [], "suggestions": []}, {}))

    def configure(active=True, expired=False, anonymous=False):
        def verify_user(url, **kwargs):
            assert url.endswith("/auth/v1/user")
            assert kwargs["headers"] == {"apikey": "sb_publishable_dummy", "Authorization": "Bearer user-jwt"}
            return httpx.Response(401 if expired else 200, request=httpx.Request("GET", url),
                                  json={"id": actor, "is_anonymous": anonymous})
        monkeypatch.setattr(auth.httpx, "get", verify_user)
        monkeypatch.setattr("BackEnd.documents.store.get_document_store", lambda: SimpleNamespace(is_admin=lambda user: active and user == actor))
        return TestClient(api.app, base_url="https://api.example.invalid"), actor
    yield configure
    api.app.dependency_overrides.clear()


@pytest.mark.parametrize("active,expired,anonymous,status", [(True, False, False, 200),
    (False, False, False, 403), (True, True, False, 401), (True, False, True, 403)])
def test_public_admin_session_and_chat_require_current_permission(setup_auth, active, expired, anonymous, status):
    client, _ = setup_auth(active, expired, anonymous)
    headers = {"Authorization": "Bearer user-jwt"}
    assert client.get("/api/v1/admin/session", headers=headers).status_code == status
    response = client.post("/api/v1/chat", json={"query": "문서 질문"}, headers=headers)
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    if status == 200:
        assert response.json()["text"] == "관리자 원문"
    assert client.post("/api/v1/chat", json={"query": "문서 질문"}).json()["text"] == "공개 원문"


def test_public_upload_preserves_actor_and_postgres_artifact_contract(setup_auth):
    client, actor = setup_auth()
    document_id, job_id = str(uuid4()), str(uuid4())
    calls = []

    class Store:
        def register(self, metadata, digest, size, suffix, received_actor, config, content, **kwargs):
            assert received_actor == actor and metadata["test_only"] is False
            assert config["artifact_store"] == "postgres-current-v2"
            calls.append("queued")
            return {"document_id": document_id, "program_id": 1, "active_job_id": None}, {"job_id": job_id, "state": "queued"}

    api.app.dependency_overrides[documents.get_document_store] = lambda: Store()
    response = client.post("/api/v1/admin/documents", headers={"Authorization": "Bearer user-jwt"},
        data={"metadata": '{"service_id":"WLF_PUBLIC","name":"공개 원문","source_url":"https://example.invalid/source","source_organization":"기관","test_only":false}'},
        files={"file": ("source.md", "# 공개 원문\n확인한 내용입니다.".encode(), "text/markdown")})
    assert response.status_code == 202 and calls == ["queued"]
    assert response.json()["processing_mode"] == "automatic"
    assert response.json()["embedding_started"] is False


def test_auth_does_not_accept_storage_secret_key(monkeypatch):
    settings = Settings(_env_file=None, documents_enabled=True, supabase_url="https://project.example.invalid",
                        supabase_publishable_key="sb_secret_not-for-auth")
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    response = TestClient(api.app).get("/api/v1/admin/session", headers={"Authorization": "Bearer user-jwt"})
    assert response.status_code == 503 and "sb_secret" not in response.text
