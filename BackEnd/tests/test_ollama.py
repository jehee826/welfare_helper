import httpx
import pytest
from langchain_core.messages import AIMessage
from langchain_ollama import ChatOllama

from BackEnd.rag.ollama import OllamaClient, OllamaError


@pytest.fixture
def client():
    client = OllamaClient("http://127.0.0.1:11434", "bge-m3", "gemma3:4b", embed_dim=4)
    client._effective_context = 8192
    return client


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


@pytest.mark.parametrize("content,metadata", [
    ("[]", {}), ("", {}), ("자유 형식 답변입니다.", {}),
    ('{"service_ids": []}', {"done_reason": "length"}),
])
def test_invalid_or_incomplete_chat_responses_are_rejected(client, monkeypatch, content, metadata):
    monkeypatch.setattr(ChatOllama, "invoke", lambda *a, **kw: AIMessage(
        content=content, response_metadata=metadata,
    ))
    with pytest.raises(OllamaError):
        client.chat("규칙", "질문")


def test_langchain_prompt_and_json_parser_use_configured_ollama(client, monkeypatch):
    captured = {}

    def invoke(model, prompt, config=None, **kwargs):
        captured.update(model=model.model, base_url=model.base_url, format=model.format,
                        messages=prompt.to_messages())
        return AIMessage(content='{"service_ids": ["WLF1"]}', response_metadata={"done_reason": "stop"})

    monkeypatch.setattr(ChatOllama, "invoke", invoke)
    assert client.chat("자료만 선택", '질문 {지시 아님}') == {"service_ids": ["WLF1"]}
    assert captured["model"] == "gemma3:4b"
    assert captured["format"] == "json"
    assert captured["messages"][0].content == "자료만 선택"
    assert captured["messages"][1].content == '질문 {지시 아님}'


def test_transport_errors_do_not_expose_url_credentials(client, monkeypatch):
    def post(*args, **kwargs):
        raise httpx.ConnectError("http://user:secret@private-host")

    monkeypatch.setattr(httpx, "post", post)
    with pytest.raises(OllamaError) as error:
        client.embed(["질문"])
    assert "secret" not in str(error.value)


def test_context_uses_supported_model_limit_and_resets_chain(client, monkeypatch):
    respond(monkeypatch, {"model_info": {"test.context_length": 4096}, "template": "test"})
    client._chat_chain = object()
    assert client.context_limit() == 4096
    assert client._chat_chain is None


def test_missing_context_metadata_does_not_assume_model_capacity(client, monkeypatch):
    respond(monkeypatch, {"model_info": {}})
    with pytest.raises(OllamaError):
        client.context_limit()


def test_chat_abstains_when_prompt_evaluation_reaches_context_limit(client, monkeypatch):
    monkeypatch.setattr(ChatOllama, "invoke", lambda *a, **kw: AIMessage(
        content='{"facts": []}', response_metadata={"done_reason": "stop", "prompt_eval_count": 8192},
    ))
    with pytest.raises(OllamaError):
        client.chat("규칙", "질문")


def test_same_tag_digest_is_obtained_from_model_metadata(client, monkeypatch):
    def get(url, **kwargs):
        return httpx.Response(200, json={"models": [{"name": "bge-m3:latest", "digest": "test-digest"}]},
                              request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", get)
    assert client.model_digest() == "test-digest"
