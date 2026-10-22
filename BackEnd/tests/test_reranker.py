import os

import pytest

from BackEnd.rag.reranker import LocalReranker, RerankerError


def test_empty_candidates_do_not_load_model():
    assert LocalReranker("missing-model", "revision", "missing-cache").score("질문", []) == []


def test_missing_model_abstains_without_network_or_download(tmp_path, monkeypatch):
    calls = []

    def missing(*args, **kwargs):
        calls.append(kwargs)
        raise FileNotFoundError("private/cache/location")

    monkeypatch.setattr("huggingface_hub.hf_hub_download", missing)
    with pytest.raises(RerankerError) as error:
        LocalReranker("missing-model", "revision", str(tmp_path)).score("질문", ["자료"])
    assert calls[0]["local_files_only"] is True
    assert "private/cache/location" not in str(error.value)


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
