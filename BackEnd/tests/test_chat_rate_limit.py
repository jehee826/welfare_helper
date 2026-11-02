from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient

from BackEnd.core import chat_rate
from BackEnd.core.settings import Settings


def test_thirty_requests_then_expiry_and_separate_ip():
    now = [100.0]
    limiter = chat_rate.ChatRateLimiter(clock=lambda: now[0])
    assert all(limiter.admit('first', 30) is None for _ in range(30))
    assert limiter.admit('first', 30) == 60
    assert limiter.admit('second', 30) is None
    now[0] += 59
    assert limiter.admit('first', 30) == 1
    now[0] += 1
    assert limiter.admit('first', 30) is None


def test_concurrent_requests_are_counted_once_under_lock():
    limiter = chat_rate.ChatRateLimiter(clock=lambda: 100.0)
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(lambda _: limiter.admit('same', 30), range(60)))
    assert results.count(None) == 30
    assert results.count(60) == 30


def test_capacity_refuses_new_key_without_evicting_active_keys():
    now = [100.0]
    assert chat_rate.ChatRateLimiter().capacity == 4096
    limiter = chat_rate.ChatRateLimiter(capacity=2, clock=lambda: now[0])
    assert limiter.admit('a', 1) is None and limiter.admit('b', 1) is None
    assert limiter.admit('c', 1) == 60
    assert list(limiter.windows) == ['a', 'b']
    assert limiter.admit('a', 1) == 60
    now[0] += 60
    assert limiter.admit('c', 1) is None


def test_sliding_window_expires_individual_timestamps():
    now = [100.0]
    limiter = chat_rate.ChatRateLimiter(clock=lambda: now[0])
    assert limiter.admit('a', 2) is None
    now[0] = 130.0
    assert limiter.admit('a', 2) is None
    now[0] = 160.0
    assert limiter.admit('a', 2) is None
    now[0] = 161.0
    assert limiter.admit('a', 2) == 29


def test_trusted_proxy_clients_have_separate_limits_and_untrusted_spoofing_does_not(monkeypatch):
    from starlette.requests import Request
    from BackEnd.admin import session
    monkeypatch.setattr(session, 'get_settings', lambda: SimpleNamespace(admin_trusted_proxy_ips=['192.0.2.1']))
    def key(peer, forwarded):
        return session.login_client_key(Request({'type': 'http', 'client': (peer, 123),
                                                'headers': [(b'x-forwarded-for', forwarded.encode())]}))
    limiter = chat_rate.ChatRateLimiter(clock=lambda: 100.0)
    assert limiter.admit(key('192.0.2.1', '198.51.100.1'), 1) is None
    assert limiter.admit(key('192.0.2.1', '198.51.100.2'), 1) is None
    assert limiter.admit(key('192.0.2.2', '198.51.100.1'), 1) is None
    assert limiter.admit(key('192.0.2.2', '198.51.100.2'), 1) == 60


@pytest.mark.parametrize('value', [0, 601, -1])
def test_invalid_rate_settings_are_rejected(value):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, chat_rate_limit_per_minute=value)


def test_chat_rejected_before_service_and_login_is_independent(monkeypatch):
    from BackEnd import main
    from BackEnd.admin import session
    limiter = chat_rate.ChatRateLimiter(clock=lambda: 100.0)
    monkeypatch.setattr(chat_rate, 'chat_rate_limiter', limiter)
    monkeypatch.setattr(chat_rate, 'get_settings', lambda: SimpleNamespace(chat_rate_limit_per_minute=1))
    from pydantic import SecretStr
    monkeypatch.setattr(session, 'get_settings', lambda: SimpleNamespace(admin_trusted_proxy_ips=[], admin_password=SecretStr('synthetic-password')))
    monkeypatch.setattr(session, '_sessions', {})
    monkeypatch.setattr(session, '_failures', session.OrderedDict())
    calls = []
    monkeypatch.setitem(main.app.dependency_overrides, main.get_chat_service, lambda: calls.append('factory'))
    with TestClient(main.app) as client:
        login = client.post('/api/v1/admin/login', json={'password': 'synthetic-password'})
        assert login.status_code == 200
        token = login.json()['access_token']
        limiter.admit('testclient', 1)
        for headers in ({}, {'Authorization': 'Bearer ' + token}):
            response = client.post('/api/v1/chat', json={'query': '질문'}, headers={**headers, 'Origin': 'http://localhost:5173'})
            assert response.status_code == 429 and response.json()['detail'] == 'chat_rate_limited'
            assert response.headers['retry-after'] == '60'
            assert response.headers['cache-control'] == 'no-store'
            assert response.headers['access-control-allow-origin'] == 'http://localhost:5173'
        assert client.post('/api/v1/admin/login', json={'password': 'synthetic-password'}).status_code == 200
    assert calls == []
