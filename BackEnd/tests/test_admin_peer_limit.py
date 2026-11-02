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
    monkeypatch.setattr(sessions, "get_settings", lambda: SimpleNamespace(admin_password=SecretStr("synthetic-only-password"), admin_trusted_proxy_ips=[]))
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


def test_trusted_proxy_keeps_clients_in_separate_buckets(peers, monkeypatch):
    client, _ = peers
    monkeypatch.setattr(sessions, 'get_settings', lambda: SimpleNamespace(
        admin_password=SecretStr('synthetic-only-password'), admin_trusted_proxy_ips=['192.0.2.10']))
    proxy = client('192.0.2.10')
    for _ in range(5):
        assert proxy.post('/api/v1/admin/login', json={'password': 'wrong'}, headers={'X-Forwarded-For': '198.51.100.1'}).status_code == 401
    assert proxy.post('/api/v1/admin/login', json={'password': 'synthetic-only-password'}, headers={'X-Forwarded-For': '198.51.100.2'}).status_code == 200
    assert proxy.post('/api/v1/admin/login', json={'password': 'synthetic-only-password'}, headers={'X-Forwarded-For': '198.51.100.1'}).status_code == 429


@pytest.mark.parametrize('headers', [
    [], [(b'x-forwarded-for', b'')], [(b'x-forwarded-for', b'not-an-ip')],
    [(b'x-forwarded-for', b'198.51.100.1, 198.51.100.2')],
    [(b'x-forwarded-for', b'198.51.100.1'), (b'x-forwarded-for', b'198.51.100.2')],
    [(b'x-forwarded-for', b'1' * 46)], [(b'x-forwarded-for', b'fe80::1%eth0')],
    [(b'x-real-ip', b'198.51.100.1'), (b'forwarded', b'for=198.51.100.2')],
])
def test_invalid_forwarded_headers_fall_back_to_peer(headers, monkeypatch):
    from starlette.requests import Request
    monkeypatch.setattr(sessions, 'get_settings', lambda: SimpleNamespace(admin_trusted_proxy_ips=['192.0.2.10']))
    request = Request({'type': 'http', 'client': ('192.0.2.10', 123), 'headers': headers})
    assert sessions.login_client_key(request) == '192.0.2.10'
    assert request.client.host == '192.0.2.10'


def test_ipv6_canonicalization_and_direct_peer_remains_unchanged(monkeypatch):
    from starlette.requests import Request
    monkeypatch.setattr(sessions, 'get_settings', lambda: SimpleNamespace(admin_trusted_proxy_ips=['2001:db8::1']))
    request = Request({'type': 'http', 'client': ('2001:0db8:0:0:0:0:0:1', 123),
                       'headers': [(b'x-forwarded-for', b'2001:0db8:0:0:0:0:0:2')]})
    assert sessions.login_client_key(request) == '2001:db8::2'
    assert request.client.host == '2001:0db8:0:0:0:0:0:1'


def test_caddy_overwrites_forwarded_header_without_global_proxy_headers():
    root = Path(__file__).resolve().parents[2]
    caddy = (root / 'deploy/Caddyfile').read_text(encoding='utf-8')
    startup = (root / 'BackEnd/startup.py').read_text(encoding='utf-8')
    assert 'header_up X-Forwarded-For {remote_host}' in caddy
    assert '--no-proxy-headers' in startup


@pytest.mark.parametrize('value', ['*', '192.0.2.0/24', 'proxy.example.invalid', 'fe80::1%eth0'])
def test_proxy_allowlist_rejects_non_ip_values(value):
    from pydantic import ValidationError
    from BackEnd.core.settings import Settings
    with pytest.raises(ValidationError):
        Settings(_env_file=None, admin_trusted_proxy_ips=[value])


def test_proxy_allowlist_defaults_empty_and_canonicalizes_without_duplicates():
    from BackEnd.core.settings import Settings
    assert Settings(_env_file=None, _env_prefix='P3_A_TEST_').admin_trusted_proxy_ips == []
    assert Settings(_env_file=None, admin_trusted_proxy_ips=['2001:0db8::1', '2001:db8::1']).admin_trusted_proxy_ips == ['2001:db8::1']


@pytest.mark.parametrize('header', [b'x-forwarded-for', b'forwarded', b'x-real-ip'])
def test_desktop_still_rejects_forwarded_headers(header, monkeypatch):
    from fastapi import HTTPException
    from starlette.requests import Request
    from BackEnd import desktop_guidance as guide
    from BackEnd.core.settings import Settings
    settings = Settings(_env_file=None, desktop_guidance_enabled=True,
                        desktop_extension_token='x' * 40, admin_trusted_proxy_ips=['127.0.0.1'])
    monkeypatch.setattr(guide, 'get_settings', lambda: settings)
    monkeypatch.setenv('BACKEND_BIND_HOST', '127.0.0.1')
    monkeypatch.delenv('VERCEL', raising=False)
    monkeypatch.setattr(guide, 'OllamaClient', lambda *a, **k: pytest.fail('차단 전에 모델을 호출하면 안 됩니다'))
    request = guide.DomGuideRequest(source='dom', snapshot_id='F' * 20, question='화면 설명', candidates=[])
    transport = Request({'type': 'http', 'client': ('127.0.0.1', 123),
                         'headers': [(b'authorization', ('Bearer ' + 'x' * 40).encode()), (header, b'198.51.100.1')]})
    with pytest.raises(HTTPException) as error:
        guide.desktop_guide(request, transport)
    assert error.value.status_code == 403
    assert transport.client.host == '127.0.0.1'
