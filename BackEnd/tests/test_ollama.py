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


def test_request_specific_schema_replaces_previous_generation_grammar(client, monkeypatch):
    formats = []

    def invoke(model, *args, **kwargs):
        formats.append(model.format)
        return AIMessage(content='{"facts": []}', response_metadata={"done_reason": "stop"})

    monkeypatch.setattr(ChatOllama, "invoke", invoke)
    first = {"type": "object", "properties": {"facts": {"type": "array", "maxItems": 1}}}
    second = {"type": "object", "properties": {"facts": {"type": "array", "maxItems": 2}}}
    client.chat("문장 선택", "첫 요청", schema=first)
    client.chat("문장 선택", "다음 요청", schema=second)
    assert formats == [first, second]


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


def test_vision_message_and_schema_reach_shared_langchain_model(client, monkeypatch):
    from BackEnd.tests.test_desktop_guidance import png
    image=png()
    client._effective_context=16384
    monkeypatch.setattr(client,'_post',lambda *a:{'capabilities':['completion','vision']})
    captured={}
    schema={'type':'object','properties':{'ok':{'type':'boolean'}}}
    def invoke(model,messages,**kwargs):
        captured.update(model=model.model,format=model.format,messages=messages)
        # 설치된 어댑터가 URL로 오인하지 않고 base64 images 배열로 직렬화하는지도 확인한다.
        serialized=model._convert_messages_to_ollama_messages(messages)
        assert serialized[1]['images']==[image]
        return AIMessage(content='{"ok":true}',response_metadata={'prompt_eval_count':2000,'done_reason':'stop'})
    monkeypatch.setattr(ChatOllama,'invoke',invoke)
    assert client.chat('규칙','질문',schema=schema,images=[image])=={'ok':True}
    assert captured['model']==client.llm_model and captured['format']==schema
    assert captured['messages'][1].content[0]['text']=='질문'


def test_image_is_not_silently_ignored_and_has_separate_context_budget(client, monkeypatch):
    from BackEnd.tests.test_desktop_guidance import png
    from BackEnd.rag.ollama import VisionUnsupportedError, ContextBudgetError
    image=png()
    monkeypatch.setattr(ChatOllama,'invoke',lambda *a,**k:pytest.fail('거부된 입력은 추론하지 않는다.'))
    monkeypatch.setattr(client,'_post',lambda *a:{'capabilities':['completion']})
    with pytest.raises(VisionUnsupportedError):client.chat('규칙','질문',images=[image])
    monkeypatch.setattr(client,'_post',lambda *a:{'capabilities':['completion','vision']})
    client._effective_context=4096
    with pytest.raises(ContextBudgetError):client.chat('규칙','질문',images=[image])
