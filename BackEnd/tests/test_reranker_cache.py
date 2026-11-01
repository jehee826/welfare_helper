from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import BackEnd.rag.reranker as reranker


@pytest.fixture
def cache(monkeypatch):
    monkeypatch.setattr(reranker, "_cache", OrderedDict())
    constructor = Mock(side_effect=lambda *key: SimpleNamespace(key=key))
    monkeypatch.setattr(reranker, "LocalReranker", constructor)
    return constructor


def test_cache_normalizes_path_and_serializes_first_construction(cache, tmp_path):
    def get(_):
        return reranker.cached_reranker("model", "rev", str(tmp_path / "x" / ".."), 512, 2)
    with ThreadPoolExecutor(max_workers=4) as pool:
        instances = list(pool.map(get, range(8)))
    assert all(value is instances[0] for value in instances)
    assert reranker.cached_reranker("model", "rev", str(tmp_path), 512, 2) is instances[0]
    cache.assert_called_once()


def test_different_settings_and_bounded_eviction(cache, tmp_path):
    base = ("model", "rev", str(tmp_path), 512, 2)
    first = reranker.cached_reranker(*base)
    for index, value in [(0, "other-model"), (1, "other-revision"), (2, str(tmp_path / "other")), (3, 256), (4, 1)]:
        key = list(base)
        key[index] = value
        assert reranker.cached_reranker(*key) is not first
    assert len(reranker._cache) == 4
    assert reranker.cached_reranker(*base) is not first


def test_failed_construction_does_not_poison_cache(cache, tmp_path):
    instance = SimpleNamespace()
    cache.side_effect = [RuntimeError("가상 초기화 실패"), instance]
    with pytest.raises(RuntimeError):
        reranker.cached_reranker("model", "rev", str(tmp_path), 512, 2)
    assert not reranker._cache
    assert reranker.cached_reranker("model", "rev", str(tmp_path), 512, 2) is instance
    assert cache.call_count == 2


def test_failed_session_load_is_retried_on_the_same_cached_object(monkeypatch, tmp_path):
    import sys
    import numpy as np
    monkeypatch.setattr(reranker, "_cache", OrderedDict())
    class Tokenizer:
        def no_truncation(self): pass
        def encode(self, text, pair=None, **_kwargs):
            length = len(text) + len(pair or "") + (2 if pair is not None else 0)
            return SimpleNamespace(ids=[1] * length, attention_mask=[1] * length, type_ids=[0] * length)
    tokenizer = Tokenizer()
    session = SimpleNamespace(get_inputs=lambda: [], run=lambda *_: [np.array([.5])])
    load = Mock(side_effect=[RuntimeError("가상 세션 실패"), session])
    monkeypatch.setitem(sys.modules, "tokenizers", SimpleNamespace(Tokenizer=SimpleNamespace(from_file=lambda *_: tokenizer)))
    monkeypatch.setitem(sys.modules, "onnxruntime", SimpleNamespace(SessionOptions=SimpleNamespace, InferenceSession=load,
                        GraphOptimizationLevel=SimpleNamespace(ORT_ENABLE_EXTENDED=1)))
    instance = reranker.cached_reranker("model", "rev", str(tmp_path), 512, 2)
    monkeypatch.setattr(instance, "model_files", lambda: (tmp_path / "virtual-tokenizer", tmp_path / "virtual-model"))
    with pytest.raises(reranker.RerankerError):
        instance.score("질문", ["가상 자료"])
    assert instance._session is None
    assert reranker.cached_reranker("model", "rev", str(tmp_path), 512, 2) is instance
    assert len(instance.score("질문", ["가상 자료"])) == 1
    assert load.call_count == 2
