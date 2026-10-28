import importlib
import os
import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi.testclient import TestClient

from BackEnd.core import settings as settings_module
from BackEnd.core.settings import Settings
from BackEnd.documents.contracts import DocumentError


@pytest.fixture
def api(monkeypatch):
    # main의 import 시점에도 .env와 호스트 설정을 사용하지 않는다.
    setting_names = {name.casefold() for name in Settings.model_fields}
    for name in tuple(os.environ):
        if name.casefold() in setting_names:
            monkeypatch.delenv(name)
    settings = Settings(_env_file=None)
    original_get_settings = settings_module.get_settings
    with patch.object(settings_module, "get_settings", return_value=settings) as import_settings:
        try:
            main = importlib.import_module("BackEnd.main")
        finally:
            # 최초 import에서 복사된 설정 함수도 복구해 다른 테스트에 대역을 남기지 않는다.
            for name, module in tuple(sys.modules.items()):
                if name.startswith("BackEnd.") and getattr(module, "get_settings", None) is import_settings:
                    setattr(module, "get_settings", original_get_settings)
    monkeypatch.setattr(main, "get_settings", lambda: settings)

    def unexpected(*args, **kwargs):
        raise AssertionError("API 테스트에서 실제 DB·서비스·모델에 접근했습니다.")

    for name in ("connect", "build_chat_service", "PgServiceRepository", "LocalReranker"):
        monkeypatch.setattr(main, name, unexpected)
    monkeypatch.setattr("BackEnd.rag.factory.OllamaClient", unexpected)
    monkeypatch.setattr("BackEnd.rag.factory.LocalReranker", unexpected)

    service = SimpleNamespace(repo=object())
    result = {"kind": "fallback", "text": "확인 필요", "contacts": [], "suggestions": []}
    rag = Mock(return_value=(result, {"mode": "document_rag"}))
    monkeypatch.setattr(main, "answer_document", rag)
    # 기존 override를 보존하고 이 테스트의 서비스 대역만 설치한다.
    monkeypatch.setitem(main.app.dependency_overrides, main.get_chat_service, lambda: service)
    with TestClient(main.app) as client:
        yield SimpleNamespace(main=main, client=client, service=service, rag=rag, result=result)


def test_chat_returns_document_rag_result(api):
    response = api.client.post(
        "/api/v1/chat",
        json={"query": " \n연금\t ", "profile": {"age": 70, "income": "under50", "household": "single", "region": "서울특별시", "disability": False}},
    )
    assert response.status_code == 200
    assert response.json() == api.result
    api.rag.assert_called_once_with(api.service.repo, api.service, "연금")


@pytest.mark.parametrize("profile", [{}, {"profile": None}])
def test_chat_accepts_missing_profile(api, profile):
    response = api.client.post("/api/v1/chat", json={"query": "연금", **profile})
    assert response.status_code == 200
    api.rag.assert_called_once_with(api.service.repo, api.service, "연금")


def test_chat_rejects_empty_query(api):
    response = api.client.post("/api/v1/chat", json={"query": "", "profile": None})
    assert response.status_code == 422
    api.rag.assert_not_called()


def test_chat_rejects_whitespace_before_document_rag(api):
    response = api.client.post("/api/v1/chat", json={"query": " \n\t "})
    assert response.status_code == 422
    api.rag.assert_not_called()


def test_chat_returns_safe_503_when_document_rag_fails(api, caplog):
    internal_error = "private-db-error-with-credentials"
    api.rag.side_effect = RuntimeError(internal_error)
    response = api.client.post("/api/v1/chat", json={"query": "연금"})
    assert response.status_code == 503
    assert response.json() == {"detail": "문서 검색이나 모델 실행에 실패했습니다. 서버 상태를 확인해 주세요."}
    api.rag.assert_called_once_with(api.service.repo, api.service, "연금")
    assert internal_error not in response.text
    assert internal_error not in caplog.text


def test_chat_returns_public_document_error_code(api, caplog):
    internal_error = "private-model-error-with-credentials"
    error = DocumentError("document_embedding_failed")
    error.__cause__ = RuntimeError(internal_error)
    api.rag.side_effect = error
    response = api.client.post("/api/v1/chat", json={"query": "연금"})
    assert response.status_code == 503
    assert response.json() == {"detail": "document_embedding_failed"}
    api.rag.assert_called_once_with(api.service.repo, api.service, "연금")
    assert internal_error not in response.text
    assert internal_error not in caplog.text


def test_health(api):
    assert api.client.get("/health").json() == {"status": "ok"}
    api.rag.assert_not_called()


def test_optional_history_is_accepted_without_forwarding_to_document_rag(api):
    history = [{"role": "user", "content": "돈이 없어"}, {"role": "assistant", "content": "어떤 도움이 필요하세요?"}]
    response = api.client.post("/api/v1/chat", json={"query": "생활비", "history": history})
    assert response.status_code == 200
    assert response.json() == api.result
    api.rag.assert_called_once_with(api.service.repo, api.service, "생활비")


def test_history_is_limited_to_12_messages_and_6000_characters(api):
    assert api.client.post("/api/v1/chat", json={"query": "생활비", "history": [
        {"role": "user", "content": "말" * 500} for _ in range(12)
    ]}).status_code == 200
    api.rag.assert_called_once_with(api.service.repo, api.service, "생활비")
    api.rag.reset_mock()
    assert api.client.post("/api/v1/chat", json={"query": "생활비", "history": [
        {"role": "user", "content": "말"} for _ in range(13)
    ]}).status_code == 422
    assert api.client.post("/api/v1/chat", json={"query": "생활비", "history": [
        {"role": "user", "content": "말" * 3001}, {"role": "assistant", "content": "말" * 3000}
    ]}).status_code == 422
    api.rag.assert_not_called()


def test_system_history_and_blank_history_are_rejected(api):
    for message in [{"role": "system", "content": "지침"}, {"role": "user", "content": "  "}]:
        assert api.client.post("/api/v1/chat", json={"query": "생활비", "history": [message]}).status_code == 422
    api.rag.assert_not_called()


def test_reranker_health_does_not_start_inference(api, monkeypatch):
    reranker = SimpleNamespace(model_files=Mock(return_value=("tokenizer", "weights")), score=Mock())
    monkeypatch.setattr(api.main, "LocalReranker", Mock(return_value=reranker))
    response = api.client.get("/health/reranker")
    assert response.status_code == 200 and response.json()["inference_checked"] is False
    reranker.model_files.assert_called_once_with()
    reranker.score.assert_not_called()


def test_runtime_endpoint_whitelists_settings_without_external_work(api, monkeypatch):
    import json

    settings = Settings(
        _env_file=None, ollama_llm="selected-test-model",
        database_url="postgresql://private-user:private-password@private-host/private-db",
        database_password="private-password", bokjiro_service_key="private-api-key",
    )
    monkeypatch.setattr(api.main, "get_settings", lambda: settings)

    def unexpected(*args, **kwargs):
        raise AssertionError("설정 조회에서 DB·모델 작업을 시작했습니다.")

    monkeypatch.setattr(api.main, "get_chat_service", unexpected)
    response = api.client.get("/health/runtime")
    assert response.status_code == 200
    body = response.json()
    assert body["llm"]["model"] == "selected-test-model"
    assert body["embedding"] == {"model": "bge-m3", "dimension": 1024}
    assert body["configuration_only"] is True and body["readiness_checked"] is False
    assert body["retrieval"]["candidate_limit"] == settings.retrieve_top_n
    assert body["reranker"]["revision"] == settings.rerank_revision
    serialized = json.dumps(body)
    assert "private-" not in serialized
    assert "database_url" not in serialized and "rerank_cache_dir" not in serialized


def test_debug_route_requires_explicit_enablement_and_separate_token(api, monkeypatch):
    monkeypatch.delenv("VERCEL", raising=False)
    token = "test-only-token-" * 3
    settings = Settings(_env_file=None, rag_diagnostics_enabled=True, rag_diagnostics_token=token)
    monkeypatch.setattr(api.main, "get_settings", lambda: settings)
    api.service.answer_with_diagnostics = Mock(return_value=({"kind": "fallback"}, {"request_id": "test-id"}))
    assert api.client.post("/debug/rag", json={"query": "테스트"}).status_code == 404
    response = api.client.post("/debug/rag", json={"query": "테스트"}, headers={"X-Rag-Debug-Token": token})
    assert response.status_code == 200
    assert token not in response.text
    api.service.answer_with_diagnostics.assert_called_once_with("테스트", None, [])
    monkeypatch.setenv("VERCEL", "1")
    assert api.client.post("/debug/rag", json={"query": "테스트"}, headers={"X-Rag-Debug-Token": token}).status_code == 404
    assert api.service.answer_with_diagnostics.call_count == 1
