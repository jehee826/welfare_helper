from fastapi.testclient import TestClient

from BackEnd.main import app, get_chat_service


class StubChat:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def answer(self, query, profile, history=None):
        self.calls.append((query, profile))
        self.history = history
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


def test_chat_rejects_whitespace_before_loading_service():
    stub = StubChat()
    response = client_with(stub).post("/api/v1/chat", json={"query": " \n\t "})
    assert response.status_code == 422
    assert stub.calls == []


def test_chat_returns_503_when_data_unavailable():
    response = client_with(StubChat(error=RuntimeError("db down"))).post("/api/v1/chat", json={"query": "연금"})
    assert response.status_code == 503
    assert "129" in response.json()["detail"]


def test_health():
    assert TestClient(app).get("/health").json() == {"status": "ok"}


def test_optional_history_is_passed_without_changing_legacy_contract():
    stub = StubChat(result={"kind": "fallback", "text": "확인 질문", "contacts": [], "suggestions": []})
    history = [{"role": "user", "content": "돈이 없어"}, {"role": "assistant", "content": "어떤 도움이 필요하세요?"}]
    response = client_with(stub).post("/api/v1/chat", json={"query": "생활비", "history": history})
    assert response.status_code == 200 and stub.history == history


def test_history_is_limited_to_12_messages_and_6000_characters():
    client = client_with(StubChat())
    assert client.post("/api/v1/chat", json={"query": "생활비", "history": [
        {"role": "user", "content": "말"} for _ in range(13)
    ]}).status_code == 422
    assert client.post("/api/v1/chat", json={"query": "생활비", "history": [
        {"role": "user", "content": "말" * 3001}, {"role": "assistant", "content": "말" * 3000}
    ]}).status_code == 422


def test_system_history_and_blank_history_are_rejected():
    client = client_with(StubChat())
    for message in [{"role": "system", "content": "지침"}, {"role": "user", "content": "  "}]:
        assert client.post("/api/v1/chat", json={"query": "생활비", "history": [message]}).status_code == 422


def test_reranker_health_does_not_start_inference(monkeypatch):
    from BackEnd.rag.reranker import LocalReranker

    monkeypatch.setattr(LocalReranker, "model_files", lambda self: ("tokenizer", "weights"))
    monkeypatch.setattr(LocalReranker, "score", lambda *a: (_ for _ in ()).throw(AssertionError("추론하면 안 됩니다.")))
    response = TestClient(app).get("/health/reranker")
    assert response.status_code == 200 and response.json()["inference_checked"] is False
