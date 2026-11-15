import os

import pytest

from BackEnd.rag.reranker import LocalReranker, RerankerError


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


class _Encoded:
    def __init__(self, ids):
        self.ids, self.attention_mask, self.type_ids = ids, [1] * len(ids), [0] * len(ids)


class _Tokenizer:
    def encode(self, first, second=None, add_special_tokens=True):
        size = len(first.split()) + (len((second or "").split()) if second is not None else 0)
        return _Encoded(list(range(size + (2 if add_special_tokens else 0))))


class _Session:
    def __init__(self, fail_on=None):
        import threading

        self.fail_on, self.threads, self.lock = fail_on, set(), threading.Lock()

    def get_inputs(self):
        from types import SimpleNamespace

        return [SimpleNamespace(name=name) for name in ("input_ids", "attention_mask", "token_type_ids")]

    def run(self, _outputs, inputs):
        import threading

        import numpy as np

        with self.lock:
            self.threads.add(threading.get_ident())
        assert inputs["input_ids"].shape[0] == 1
        size = inputs["input_ids"].shape[1]
        if size == self.fail_on:
            raise RuntimeError("실패")
        return [np.asarray([[size / 10 - 2]], dtype=np.float32)]


def _fake(threads, session):
    reranker = LocalReranker("model", "revision", "cache", threads=threads)
    reranker._session, reranker._tokenizer, reranker._count_tokenizer = session, _Tokenizer(), _Tokenizer()
    return reranker


def test_parallel_pairs_keep_sequential_scores_and_order():
    passages = ["가 " * 5, "가 " * 30, "가 " * 12, "가"]
    sequential = _fake(1, _Session()).score_with_diagnostics("질문 하나", passages)
    session = _Session()
    parallel = _fake(4, session).score_with_diagnostics("질문 하나", passages)
    assert parallel == sequential
    assert sequential[0].index(max(sequential[0])) == 1


def test_parallel_pair_failure_becomes_reranker_error():
    with pytest.raises(RerankerError):
        _fake(4, _Session(fail_on=16)).score("질문 하나", ["가 " * 5, "가 " * 12])


def test_parallel_pairs_keep_request_deadline(monkeypatch):
    from BackEnd.core import execution

    calls = []

    def expired():
        calls.append(True)
        if len(calls) > 3:
            raise execution.ExecutionTimeoutError("시간 초과")

    monkeypatch.setattr("BackEnd.rag.reranker.checkpoint", expired)
    with pytest.raises(execution.ExecutionTimeoutError):
        _fake(4, _Session()).score("질문 하나", ["가 " * 5, "가 " * 12, "가 " * 8])
