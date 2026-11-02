import pytest


@pytest.fixture(autouse=True)
def isolate_chat_rate_limiter(monkeypatch):
    from BackEnd.core import chat_rate
    monkeypatch.setattr(chat_rate, 'chat_rate_limiter', chat_rate.ChatRateLimiter())
