"""임시 해시 파일과 합성 관리자만 사용하며 실제 비밀번호·DB는 사용하지 않는다."""

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import json
import re

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from BackEnd.admin import credentials, session
from BackEnd.core.settings import Settings
from BackEnd.documents import auth as document_auth
from BackEnd.main import app

OLD = "synthetic-old-password"


@pytest.fixture
def system(tmp_path, monkeypatch):
    path = tmp_path / "credentials.json"
    store = credentials.CredentialFile(path)
    store.initialize(OLD)
    settings = Settings(_env_file=None, documents_enabled=True, admin_password="synthetic-legacy-password", admin_credentials_file=str(path))
    monkeypatch.setattr(session, "get_settings", lambda: settings)
    monkeypatch.setattr(credentials, "get_settings", lambda: settings)
    monkeypatch.setattr(document_auth, "get_settings", lambda: settings)
    monkeypatch.setattr(credentials, "_pending", None)
    monkeypatch.setattr(session, "_sessions", {})
    monkeypatch.setattr(session, "_failures", session.OrderedDict())
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, store=store, path=path, settings=settings)


def login(system, password=OLD):
    response = system.client.post("/api/v1/admin/login", json={"password": password})
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def issue(system, headers):
    response = system.client.post("/api/v1/admin/password/issue", headers=headers, json={"current_password": OLD})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def activate(system, headers, body):
    return system.client.post("/api/v1/admin/password/activate", headers=headers,
                              json={"rotation_token": body["rotation_token"]})


def test_issue_receive_activate_invalidates_old_sessions_and_persists_only_hash(system):
    first, second = login(system), login(system)
    body = issue(system, first)
    assert re.fullmatch(r"[A-Za-z0-9_-]{32}", body["password"])
    assert system.client.get("/api/v1/admin/session", headers=second).status_code == 200
    assert activate(system, first, body).status_code == 200
    assert all(system.client.get("/api/v1/admin/session", headers=headers).status_code == 401 for headers in (first, second))
    assert system.client.post("/api/v1/admin/login", json={"password": OLD}).status_code == 401
    fresh = login(system, body["password"])
    assert system.client.get("/api/v1/admin/session", headers=fresh).status_code == 200
    state = json.loads(system.path.read_text())
    assert set(state) == {"schema_version", "version", "password_hash"} and state["version"] == 2
    assert all(value not in system.path.read_text() for value in (OLD, body["password"], body["rotation_token"]))


def test_lost_activation_response_is_idempotent_and_preserves_new_sessions(system):
    headers = login(system); body = issue(system, headers)
    assert activate(system, headers, body).status_code == 200
    fresh = login(system, body["password"])
    assert activate(system, headers, body).status_code == 200
    assert system.store.read()["version"] == 2
    assert system.client.get("/api/v1/admin/session", headers=fresh).status_code == 200


def test_lost_issue_response_expires_without_changing_current_password(system, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(credentials.time, "monotonic", lambda: clock[0])
    headers = login(system); body = issue(system, headers)
    clock[0] += credentials.GRANT_SECONDS
    assert activate(system, headers, body).status_code == 401
    assert system.store.read()["version"] == 1
    login(system)
    assert issue(system, headers)["rotation_token"] != body["rotation_token"]


def test_wrong_current_password_is_rate_limited_without_exposing_input(system):
    headers = login(system)
    for _ in range(5):
        response = system.client.post("/api/v1/admin/password/issue", headers=headers,
                                      json={"current_password": "synthetic-private-wrong"})
        assert response.status_code == 403 and "synthetic-private-wrong" not in response.text
    response = system.client.post("/api/v1/admin/password/issue", headers=headers, json={"current_password": OLD})
    assert response.status_code == 429 and int(response.headers["retry-after"]) <= 60
    assert system.store.read()["version"] == 1


@pytest.mark.parametrize("body", [{}, {"current_password": "x", "extra": "private"}, {"current_password": "x" * 257}])
def test_invalid_issue_body_is_safe_and_cannot_write(system, body):
    headers = login(system)
    response = system.client.post("/api/v1/admin/password/issue", headers=headers, json=body)
    assert response.status_code == 400 and "private" not in response.text
    assert system.store.read()["version"] == 1


def test_grant_is_bound_to_the_original_admin_session(system):
    first, second = login(system), login(system)
    body = issue(system, first)
    assert activate(system, {}, body).status_code == 401
    assert activate(system, second, body).status_code == 401
    assert activate(system, first, body).status_code == 200


def test_unauthenticated_issue_and_logged_out_grant_are_rejected(system):
    assert system.client.post("/api/v1/admin/password/issue", json={"current_password": OLD}).status_code == 401
    headers = login(system); body = issue(system, headers)
    assert system.client.post("/api/v1/admin/logout", headers=headers).status_code == 204
    assert activate(system, headers, body).status_code == 401
    assert system.store.read()["version"] == 1


def test_concurrent_issue_allows_one_pending_password(system):
    headers = login(system)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: system.client.post("/api/v1/admin/password/issue", headers=headers,
                                                           json={"current_password": OLD}).status_code, range(2)))
    assert sorted(results) == [200, 409]
    assert system.store.read()["version"] == 1


def test_failed_atomic_write_keeps_old_password_and_can_retry(system, monkeypatch):
    headers = login(system); body = issue(system, headers)
    original = system.path.read_bytes()
    replace = credentials.os.replace
    def fail(*_args): raise OSError("synthetic-private-path")
    monkeypatch.setattr(credentials.os, "replace", fail)
    response = activate(system, headers, body)
    assert response.status_code == 503 and "synthetic-private-path" not in response.text
    assert system.path.read_bytes() == original
    login(system)
    monkeypatch.setattr(credentials.os, "replace", replace)
    assert activate(system, headers, body).status_code == 200


@pytest.mark.parametrize("damage", ["missing", "corrupt"])
def test_file_failure_never_falls_back_to_runtime_password(system, damage):
    if damage == "missing": system.path.unlink()
    else: system.path.write_text("invalid")
    response = system.client.post("/api/v1/admin/login", json={"password": "synthetic-legacy-password"})
    assert response.status_code == 503


def test_fresh_session_memory_still_uses_rotated_file(system, monkeypatch):
    headers = login(system); body = issue(system, headers)
    assert activate(system, headers, body).status_code == 200
    monkeypatch.setattr(session, "_sessions", {})
    monkeypatch.setattr(credentials, "_pending", None)
    login(system, body["password"])
    assert system.client.post("/api/v1/admin/login", json={"password": OLD}).status_code == 401


def test_initialization_never_overwrites_existing_credentials(system):
    original = system.path.read_bytes()
    with pytest.raises(HTTPException) as error:
        system.store.initialize("synthetic-other")
    assert error.value.status_code == 409 and system.path.read_bytes() == original
