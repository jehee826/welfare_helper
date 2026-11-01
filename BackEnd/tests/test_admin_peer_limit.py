"""미확정 프록시 헤더를 믿지 않고 실제 peer의 로그인 실패만 제한한다."""

from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
import pytest

import BackEnd.admin.session as sessions


@pytest.fixture
def peers(monkeypatch):
    clock = [1_000_000.0]
    monkeypatch.setattr(sessions.time, "time", lambda: clock[0])
    monkeypatch.setattr(sessions, "get_settings", lambda: SimpleNamespace(admin_password=SecretStr("synthetic-only-password")))
    sessions._sessions.clear()
    sessions._failures.clear()
    app = FastAPI()
    app.include_router(sessions.router)
    with ExitStack() as stack:
        def client(peer):
            async def fixed_peer(scope, receive, send):
                await app({**scope, "client": (peer, 12345)}, receive, send)
            return stack.enter_context(TestClient(fixed_peer, base_url="https://api.example.invalid"))
        yield client, clock
    sessions._sessions.clear()
    sessions._failures.clear()


def test_five_failures_share_peer_despite_spoofed_forwarding_headers_and_expire_at_sixty_seconds(peers):
    client, clock = peers
    proxy = client("192.0.2.10")
    for i in range(5):
        response = proxy.post("/api/v1/admin/login", json={"password": "wrong"}, headers={
            "X-Forwarded-For": f"198.51.100.{i + 1}", "X-Real-IP": f"203.0.113.{i + 1}",
            "Forwarded": f"for=198.51.100.{i + 1};proto=https"})
        assert response.status_code == 401
    response = proxy.post("/api/v1/admin/login", json={"password": "synthetic-only-password"},
                          headers={"X-Forwarded-For": "198.51.100.99"})
    assert response.status_code == 429 and response.headers["retry-after"] == "60"
    assert list(sessions._failures) == ["192.0.2.10"]
    clock[0] += 59
    response = proxy.post("/api/v1/admin/login", json={"password": "synthetic-only-password"})
    assert response.status_code == 429 and response.headers["retry-after"] == "1"
    clock[0] += 1
    response = proxy.post("/api/v1/admin/login", json={"password": "synthetic-only-password"})
    assert response.status_code == 200
    assert response.json()["expires_at"] == int(clock[0]) + 8 * 60 * 60
    assert sessions._failures == {}


def test_different_peers_have_separate_failure_buckets(peers):
    client, _ = peers
    first, second = client("192.0.2.10"), client("192.0.2.11")
    for _ in range(5):
        assert first.post("/api/v1/admin/login", json={"password": "wrong"}).status_code == 401
    assert second.post("/api/v1/admin/login", json={"password": "synthetic-only-password"}).status_code == 200
    assert first.post("/api/v1/admin/login", json={"password": "synthetic-only-password"}).status_code == 429


def test_successful_login_resets_only_its_peer_failures_and_keeps_session_cap(peers):
    client, _ = peers
    first, second = client("192.0.2.10"), client("192.0.2.11")
    first.post("/api/v1/admin/login", json={"password": "wrong"})
    second.post("/api/v1/admin/login", json={"password": "wrong"})
    assert first.post("/api/v1/admin/login", json={"password": "synthetic-only-password"}).status_code == 200
    assert "192.0.2.10" not in sessions._failures and "192.0.2.11" in sessions._failures
    assert sessions.SESSION_SECONDS == 28800 and sessions.MAX_SESSIONS == 256
    startup = (Path(__file__).resolve().parents[1] / "startup.py").read_text(encoding="utf-8")
    assert '"--no-proxy-headers"' in startup
