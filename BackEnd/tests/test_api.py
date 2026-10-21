from fastapi.testclient import TestClient

from BackEnd.main import app, get_chat_service


class StubChat:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def answer(self, query, profile):
        self.calls.append((query, profile))
        if self.error:
            raise self.error
        return self.result


def client_with(stub):
    app.dependency_overrides[get_chat_service] = lambda: stub
    return TestClient(app)


def teardown_function():
    app.dependency_overrides.clear()


def test_chat_returns_service_result():
    stub = StubChat(result={"kind": "fallback", "text": "확인 필요", "contacts": [], "suggestions": []})
    response = client_with(stub).post(
        "/api/v1/chat",
        json={"query": "연금", "profile": {"age": 70, "income": "under50", "household": "single", "region": "서울특별시", "disability": False}},
    )
    assert response.status_code == 200
    assert response.json()["kind"] == "fallback"
    assert stub.calls[0][1]["age"] == 70


def test_chat_accepts_missing_profile():
    stub = StubChat(result={"kind": "fallback", "text": "", "contacts": [], "suggestions": []})
    response = client_with(stub).post("/api/v1/chat", json={"query": "연금", "profile": None})
    assert response.status_code == 200
    assert stub.calls[0][1] is None


def test_chat_rejects_empty_query():
    response = client_with(StubChat()).post("/api/v1/chat", json={"query": "", "profile": None})
    assert response.status_code == 422


def test_chat_returns_503_when_data_unavailable():
    response = client_with(StubChat(error=RuntimeError("db down"))).post("/api/v1/chat", json={"query": "연금"})
    assert response.status_code == 503
    assert "129" in response.json()["detail"]


def test_health():
    assert TestClient(app).get("/health").json() == {"status": "ok"}
