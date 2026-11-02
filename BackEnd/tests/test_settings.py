import pytest
from pydantic import ValidationError

from BackEnd.core.settings import Settings


def test_embedding_dimension_can_be_read_from_environment(monkeypatch):
    monkeypatch.setenv("EMBED_DIM", "1024")
    assert Settings(_env_file=None).embed_dim == 1024


def test_dimension_incompatible_with_existing_schema_is_rejected():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, embed_dim=768)


@pytest.mark.parametrize('values', [
    {'ollama_llm': ' '}, {'ollama_embed': 'bad model'},
    {'ollama_base_url': 'http://a:b@localhost:11434'},
    {'ollama_base_url': 'http://localhost:11434/?x=1'},
    {'ollama_base_url': 'http://localhost:'},
    {'ollama_base_url': 'http://localhost:abc'},
    {'ollama_base_url': 'http://localhost:0'},
    {'ollama_base_url': 'ftp://localhost'},
    {'llm_num_ctx': 512, 'llm_num_predict': 512},
])
def test_invalid_ollama_settings_are_rejected(values):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **values)


@pytest.mark.parametrize('values', [
    {'ollama_base_url': 'http://localhost'},
    {'ollama_llm': 'registry.example:5000/team/model:tag'},
    {'ollama_embed': 'model@sha256:abc'},
    {'llm_num_ctx': 8192, 'llm_num_predict': 512},
])
def test_valid_ollama_settings_are_accepted(values):
    Settings(_env_file=None, **values)


def test_document_and_screen_use_the_same_model_settings(monkeypatch):
    from BackEnd import desktop_guidance as guide
    from BackEnd.rag import factory

    settings = Settings(_env_file=None, desktop_guidance_enabled=True,
                        ollama_llm='qwen3:30b-a3b-instruct-2507-q4_K_M',
                        ollama_timeout=900, llm_num_ctx=8192,
                        llm_num_predict=512, llm_num_thread=8, llm_temperature=0)
    captured = []
    reranker_args = []

    def client(*args, **kwargs):
        captured.append((args, kwargs))
        return object()

    monkeypatch.setattr(factory, 'OllamaClient', client)
    monkeypatch.setattr(factory, 'cached_reranker', lambda *args: reranker_args.append(args) or object())
    monkeypatch.setattr(factory, 'ChatService', lambda *args, **kwargs: object())
    factory.build_chat_service(object(), settings)
    monkeypatch.setattr(guide, 'get_settings', lambda: settings)
    monkeypatch.setattr(guide, 'OllamaClient', client)
    monkeypatch.setattr(guide, 'generate_step', lambda *_: guide.GuideStep(
        target_id=None, action='설명', instruction='공개 화면입니다.', expect_label=None))
    guide.desktop_guide(guide.GuideRequest(goal='화면 설명', candidates=[]))

    document, screen = captured
    assert document[0] == screen[0] == (
        settings.ollama_base_url, 'bge-m3', settings.ollama_llm, 900,
        {'temperature': 0, 'num_ctx': 8192, 'num_predict': 512, 'num_thread': 8})
    assert document[1]['embed_dim'] == screen[1]['embed_dim'] == 1024
    assert reranker_args[0][:2] == (
        'onnx-community/bge-reranker-v2-m3-ONNX',
        '6f5ff65298512715a1e669753bc754d2bc8f367b')
