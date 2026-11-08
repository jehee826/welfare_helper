import os
import math
from types import SimpleNamespace

import pytest

from BackEnd.rag.reranker import LocalReranker, RerankerError


def batch_runtime(*, dynamic=True, padding=True):
    import numpy as np
    class Tokenizer:
        def token_to_id(self, token): return 1 if padding and token == '<pad>' else None
        def encode(self, text, pair=None, **_kwargs):
            ids = [ord(char) + 3 for char in text]
            if pair is not None:
                ids += [2] + [ord(char) + 3 for char in pair] + [2]
            return SimpleNamespace(ids=ids, attention_mask=[1] * len(ids), type_ids=[0] * len(ids))
    class Session:
        def __init__(self): self.calls = []
        def get_inputs(self):
            return [SimpleNamespace(name=name, shape=['batch' if dynamic else 1, 'tokens'])
                    for name in ('input_ids', 'attention_mask', 'token_type_ids')]
        def run(self, _outputs, inputs):
            self.calls.append(inputs)
            logits = ((inputs['input_ids'] * inputs['attention_mask']).sum(axis=1) % 17) - 8
            return [np.asarray(logits, dtype=float).reshape(-1, 1)]
    instance = LocalReranker('unused', 'revision', 'unused-cache')
    instance._tokenizer = instance._count_tokenizer = Tokenizer()
    instance._session = Session()
    return instance


def test_dynamic_batch_preserves_scores_order_padding_and_bounded_provider_calls():
    reranker = batch_runtime()
    passages = ['가', '나다', '라마바', '사', '아자차', '카타파하', '하나', '둘', '셋넷']
    scores, diagnostics = reranker.score_with_diagnostics('질문', passages)
    expected = []
    for passage in passages:
        ids = reranker._tokenizer.encode('질문', passage).ids
        expected.append(1 / (1 + math.exp(-((sum(ids) % 17) - 8))))
    assert scores == pytest.approx(expected)
    assert [call['input_ids'].shape[0] for call in reranker._session.calls] == [4, 4, 1]
    assert all(row['windows'] == 1 and row['truncated'] is False for row in diagnostics)
    for call in reranker._session.calls:
        mask = call['attention_mask']
        assert (call['input_ids'][mask == 0] == 1).all()
        assert (call['token_type_ids'][mask == 0] == 0).all()


@pytest.mark.parametrize(('dynamic', 'padding'), [(False, True), (True, False)])
def test_fixed_batch_or_unknown_padding_retains_single_pair_compatibility(dynamic, padding):
    reranker = batch_runtime(dynamic=dynamic, padding=padding)
    assert len(reranker.score('질문', ['원문', '다른 원문'])) == 2
    assert [call['input_ids'].shape[0] for call in reranker._session.calls] == [1, 1]


def test_batched_windows_preserve_every_original_character_and_pair_budget():
    reranker = batch_runtime()
    passages = ['가나' * 600, '별도 원문']
    _, diagnostics = reranker.score_with_diagnostics('질문', passages)
    encoded = []
    for call in reranker._session.calls:
        for ids, mask in zip(call['input_ids'], call['attention_mask']):
            tokens = ids[mask == 1].tolist()
            encoded.append(''.join(chr(value - 3) for value in tokens[3:-1]))
    offset = 0
    for passage, row in zip(passages, diagnostics):
        assert ''.join(encoded[offset:offset + row['windows']]) == passage
        offset += row['windows']
        assert row['truncated'] is False and max(row['pair_tokens']) <= 496
    assert len(reranker._session.calls) == math.ceil(offset / 4)


def test_cancellation_after_batch_does_not_start_another_or_publish_partial_scores(monkeypatch):
    import BackEnd.rag.reranker as module
    from BackEnd.core.execution import ExecutionCancelledError
    reranker = batch_runtime()
    def checkpoint():
        if reranker._session.calls:
            raise ExecutionCancelledError()
    monkeypatch.setattr(module, 'checkpoint', checkpoint)
    with pytest.raises(ExecutionCancelledError):
        reranker.score('질문', ['원문'] * 9)
    assert len(reranker._session.calls) == 1


@pytest.mark.parametrize('nonfinite', [False, True])
def test_invalid_batch_logits_fail_without_returning_partial_scores(nonfinite):
    import numpy as np
    reranker = batch_runtime()
    original = reranker._session.run
    def run(*args):
        original(*args)
        return [np.asarray([float('nan'), 0] if nonfinite else [0])]
    reranker._session.run = run
    with pytest.raises(RerankerError):
        reranker.score('질문', ['첫 원문', '두 번째 원문'])
    assert len(reranker._session.calls) == 1


def test_empty_candidates_do_not_load_model():
    assert LocalReranker("missing-model", "revision", "missing-cache").score("질문", []) == []


def test_missing_model_abstains_without_network_or_download(tmp_path):
    with pytest.raises(RerankerError) as error:
        LocalReranker("missing-model", "revision", str(tmp_path)).score("질문", ["자료"])
    assert "private/cache/location" not in str(error.value)


def test_plain_snapshot_files_are_used_without_hub_metadata(tmp_path):
    root = tmp_path / "models--owner--model" / "snapshots" / "revision"
    (root / "onnx").mkdir(parents=True)
    (root / "tokenizer.json").write_text("{}")
    (root / "onnx/model_quantized.onnx").write_bytes(b"test-only")
    files = LocalReranker("owner/model", "revision", str(tmp_path)).model_files()
    assert files[0] == root / "tokenizer.json"
    assert files[1] == root / "onnx/model_quantized.onnx"


def test_download_reuses_existing_cache_without_network(monkeypatch, tmp_path):
    import sys
    from types import SimpleNamespace

    from BackEnd.core.settings import Settings
    from BackEnd.rag.reranker import download_model

    settings = Settings(_env_file=None, rerank_cache_dir=str(tmp_path))
    monkeypatch.setattr("BackEnd.core.settings.get_settings", lambda: settings)
    monkeypatch.setattr(LocalReranker, "model_files", lambda self: (tmp_path, tmp_path))
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(
        snapshot_download=lambda *a, **kw: pytest.fail("기존 캐시를 다운로드했습니다."),
    ))
    download_model()


def test_download_does_not_report_success_when_snapshot_files_are_missing(monkeypatch, tmp_path, capsys):
    import sys
    from types import SimpleNamespace

    from BackEnd.core.settings import Settings
    from BackEnd.rag.reranker import download_model

    settings = Settings(_env_file=None, rerank_cache_dir=str(tmp_path))
    calls = []
    monkeypatch.setattr("BackEnd.core.settings.get_settings", lambda: settings)
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(
        snapshot_download=lambda *a, **kw: calls.append((a, kw)),
    ))
    with pytest.raises(RerankerError):
        download_model()
    assert calls[0][1]["revision"] == settings.rerank_revision
    assert calls[0][1]["allow_patterns"] == ["tokenizer.json", "onnx/model_quantized.onnx"]
    assert "준비 완료" not in capsys.readouterr().out


@pytest.mark.skipif(os.environ.get("RAG_TEST_RERANKER") != "1", reason="명시적으로 준비한 로컬 모델에서만 실행합니다.")
def test_real_korean_reranker_orders_relevant_service_and_rejects_unrelated_query():
    from BackEnd.core.settings import Settings

    settings = Settings(_env_file=None)
    reranker = LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir)
    passages = [
        "서비스명: 노인맞춤돌봄서비스\n요약: 일상생활 영위가 어려운 취약노인에게 적절한 돌봄서비스를 제공합니다.",
        "서비스명: 기초연금\n요약: 노인에게 기초연금을 지급하여 안정적인 소득기반을 제공합니다.",
        "서비스명: 양곡할인\n요약: 저소득층의 양곡 구매를 지원합니다.",
    ]
    scores = reranker.score("혼자 지내는 노인의 일상생활을 도와주는 돌봄이 필요해요", passages)
    assert scores[0] == max(scores)
    assert scores[0] >= settings.min_rerank_score
    assert max(reranker.score("우주여행 항공권과 반려동물 미용 예약", passages)) < settings.min_rerank_score
