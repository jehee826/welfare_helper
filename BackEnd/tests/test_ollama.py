import httpx
import pytest

from BackEnd.rag.ollama import OllamaClient, OllamaError


@pytest.fixture
def client():
    return OllamaClient("http://127.0.0.1:11434", "bge-m3", "gemma3:4b", embed_dim=4)


def respond(monkeypatch, payload):
    monkeypatch.setattr(
        httpx, "post",
        lambda url, **kwargs: httpx.Response(200, json=payload, request=httpx.Request("POST", url)),
    )


@pytest.mark.parametrize("vectors", [
    [], [[1.0, 0.0]], [[0.0] * 4], [[float("nan"), 0, 0, 0]],
    [[float("inf"), 0, 0, 0]], [["invalid", 0, 0, 0]], [[True, 0, 0, 0]],
])
def test_invalid_embeddings_are_rejected_before_database_use(client, monkeypatch, vectors):
    respond(monkeypatch, {"embeddings": vectors})
    with pytest.raises(OllamaError):
        client.embed(["검색할 문장"])


def test_embed_returns_valid_vectors_and_disables_silent_truncation(client, monkeypatch):
    captured = {}

    def post(url, **kwargs):
        captured.update(kwargs["json"])
        return httpx.Response(
            200, json={"embeddings": [[1.0, 0, 0, 0]]}, request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx, "post", post)
    assert client.embed(["검색 문장"]) == [[1.0, 0, 0, 0]]
    assert captured["truncate"] is False


@pytest.mark.parametrize("payload", [
    [], {"message": []}, {"message": {"content": ""}},
    {"message": {"content": "완성되지 않은 답변."}, "done": False},
    {"message": {"content": "완성되지 않은 답변."}, "done_reason": "length"},
])
def test_invalid_or_incomplete_chat_responses_are_rejected(client, monkeypatch, payload):
    respond(monkeypatch, payload)
    with pytest.raises(OllamaError):
        client.chat("규칙", "질문")


def test_transport_errors_do_not_expose_url_credentials(client, monkeypatch):
    def post(*args, **kwargs):
        raise httpx.ConnectError("http://user:secret@private-host")

    monkeypatch.setattr(httpx, "post", post)
    with pytest.raises(OllamaError) as error:
        client.embed(["질문"])
    assert "secret" not in str(error.value)
