"""외부 채팅·로컬 검증 자료·관리자 권한 경계와 추론 없는 준비 검사를 확인한다."""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from BackEnd.core.settings import Settings
import BackEnd.main as api
import BackEnd.readiness as checks


@pytest.mark.parametrize("local_mode,host,peer,headers,include_local", [
    (True, "localhost", "127.0.0.1", {}, True),
    (True, "api.example.invalid", "198.51.100.8", {}, False),
    (True, "localhost", "127.0.0.1", {"X-Forwarded-For": "127.0.0.1"}, False),
    (False, "localhost", "127.0.0.1", {}, False),
])
def test_chat_separates_public_and_local_documents(monkeypatch, local_mode, host, peer, headers, include_local):
    settings = Settings(_env_file=None, documents_enabled=True, documents_local_mode=local_mode)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setattr(api, "get_settings", lambda: settings)
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: settings)
    public_service = SimpleNamespace(repo=SimpleNamespace(include_local_documents=False))
    api.app.dependency_overrides[api.get_chat_service] = lambda: public_service
    monkeypatch.setattr(api, "PgServiceRepository", lambda *a, **kw: SimpleNamespace(**kw))
    monkeypatch.setattr(api, "build_chat_service", lambda repo, settings: SimpleNamespace(repo=repo))

    def answer(repo, service, query):
        assert repo.include_local_documents is include_local
        return {"kind": "answer", "text": "격리된 검색 결과", "services": [], "suggestions": []}, {}

    monkeypatch.setattr(api, "answer_document", answer)
    try:
        client = TestClient(api.app, base_url=f"http://{host}:8000", client=(peer, 50000))
        assert client.post("/api/v1/chat", json={"query": "문서 질문"}, headers=headers).status_code == 200
    finally:
        api.app.dependency_overrides.clear()


def test_public_admin_still_requires_jwt(monkeypatch):
    settings = Settings(_env_file=None, documents_enabled=True, documents_local_mode=False)
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: settings)
    assert TestClient(api.app).get("/api/v1/admin/documents/programs").status_code == 401


def test_cors_accepts_exact_frontend_and_rejects_other_origins():
    client = TestClient(api.app)
    for origin, expected in [("https://welfare-helper-iota.vercel.app", 200),
                             ("https://untrusted.example.invalid", 400)]:
        response = client.options("/api/v1/chat", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        assert response.status_code == expected
        assert (response.headers.get("access-control-allow-origin") == origin) is (expected == 200)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, cors_allowed_origins=["*"])


def test_readiness_only_reads_dependencies(monkeypatch):
    class Connection:
        def __init__(self):
            self.commands = []
        def set_session(self, **options):
            assert options == {"readonly": True}
        def close(self):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def cursor(self):
            return self
        def execute(self, sql):
            assert sql.startswith(("SELECT", "SET LOCAL"))
            self.commands.append(sql)
        def fetchone(self):
            return ("automatic-v1",) if "processing_contract" in self.commands[-1] else (1,)

    conn = Connection()
    settings = Settings(_env_file=None, documents_enabled=True)
    monkeypatch.setattr(checks, "connect", lambda settings: conn)
    monkeypatch.setattr(checks.LocalReranker, "model_files", lambda self: ())
    monkeypatch.setattr(checks.httpx, "get", lambda *a, **kw: SimpleNamespace(
        raise_for_status=lambda: None, json=lambda: {"models": [
            {"name": settings.ollama_llm}, {"name": "bge-m3:latest"}]}))
    assert checks.check_ready(settings)["inference_checked"] is False
    assert any("processing_contract" in command for command in conn.commands)
    monkeypatch.setattr(checks, "connect", lambda settings: (_ for _ in ()).throw(RuntimeError("private password")))
    with pytest.raises(checks.ReadinessError, match="^database_or_document_schema_not_ready$"):
        checks.check_ready(settings)
