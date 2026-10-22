import json

import pytest

from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.chat import ChatService
from BackEnd.rag.ollama import OllamaError
from BackEnd.rag.reranker import RerankerError

PENSION = ServiceRecord(
    service_id="WLF00001164",
    name="기초연금",
    summary="노인에게 기초연금을 지급하여 안정적인 소득기반을 제공합니다.",
    ministry="보건복지부",
    department="기초연금과",
    url="https://www.bokjiro.go.kr/x?wlfareInfoId=WLF00001164",
    contacts=[{"label": "국민연금공단", "phone": "1355"}, {"label": "보건복지상담센터", "phone": "129"}],
    updated_at="2025-03-25",
)
CARE = ServiceRecord(
    service_id="WLF00003191",
    name="노인맞춤돌봄서비스",
    summary="일상생활 영위가 어려운 취약노인에게 적절한 돌봄서비스를 제공합니다.",
    ministry="보건복지부",
    department="노인정책과",
    url="https://www.bokjiro.go.kr/x?wlfareInfoId=WLF00003191",
    contacts=[{"label": "보건복지상담센터", "phone": "129"}],
    updated_at="2025-03-25",
)


class FakeRepo:
    def __init__(self, dense=None, fail=False):
        self.dense = dense or []
        self.fail = fail

    def all_services(self):
        if self.fail:
            raise RuntimeError("db down")
        return [PENSION, CARE]

    def dense_search(self, embedding, k):
        return self.dense[:k]


class FakeOllama:
    def __init__(self, reply=None, embed_fail=False, chat_fail=False):
        self.reply = reply
        self.embed_fail = embed_fail
        self.chat_fail = chat_fail
        self.chat_calls = 0

    def embed(self, texts):
        if self.embed_fail:
            raise OllamaError("embed down")
        return [[0.1] * 4 for _ in texts]

    def chat(self, system, user):
        self.chat_calls += 1
        if self.chat_fail:
            raise OllamaError("llm down")
        if self.reply is not None:
            return self.reply
        context = user.split("[참고 자료]\n")[1].split("\n\n[질문]")[0]
        return {"service_ids": [r["service_id"] for r in json.loads(context)]}


class FakeReranker:
    def __init__(self, scores=None, fail=False):
        self.scores = scores
        self.fail = fail
        self.calls = []

    def score(self, query, passages):
        self.calls.append((query, passages))
        if self.fail:
            raise RerankerError("reranker down")
        return self.scores if self.scores is not None else [0.9] * len(passages)


def make(dense=None, **ollama_kwargs):
    ollama = FakeOllama(**ollama_kwargs)
    return ChatService(FakeRepo(dense=dense), ollama, min_similarity=0.45, top_n=5,
                       reranker=FakeReranker()), ollama


def test_relevant_question_returns_llm_answer_with_db_cards():
    service, ollama = make(dense=[("WLF00001164", 0.71), ("WLF00003191", 0.52)])
    result = service.answer("어르신 연금이 궁금해요", None)
    assert result["kind"] == "answer"
    assert result["text"].startswith("기초연금:")
    assert PENSION.summary in result["text"]
    assert [s["name"] for s in result["services"]] == ["기초연금", "노인맞춤돌봄서비스"]
    assert result["services"][0]["contacts"][0] == {"label": "국민연금공단", "phone": "1355"}
    assert "기초연금 신청 방법" in result["suggestions"]
    assert ollama.chat_calls == 1


def test_low_similarity_returns_contacts_without_calling_llm():
    service, ollama = make(dense=[("WLF00001164", 0.2)])
    result = service.answer("반려동물 미용 할인", None)
    assert result["kind"] == "fallback"
    assert {"label": "보건복지상담센터", "phone": "129"} in result["contacts"]
    assert ollama.chat_calls == 0


def test_apply_question_for_named_service_routes_to_its_contacts():
    service, ollama = make(dense=[("WLF00001164", 0.8)])
    result = service.answer("기초연금 신청 방법", None)
    assert result["kind"] == "fallback"
    assert result["contacts"][0] == {"label": "국민연금공단", "phone": "1355"}
    assert ollama.chat_calls == 0


def test_contact_question_lists_db_contacts():
    service, _ = make(dense=[])
    result = service.answer("기초연금 문의처", None)
    assert result["kind"] == "answer"
    assert "국민연금공단 1355" in result["text"]


def test_llm_failure_abstains():
    service, _ = make(dense=[("WLF00001164", 0.7)], chat_fail=True)
    result = service.answer("어르신 연금", None)
    assert result["kind"] == "fallback"
    assert "services" not in result


def test_invented_phone_number_in_llm_reply_is_rejected():
    service, _ = make(dense=[("WLF00001164", 0.7)], reply="1588-0000으로 전화하면 바로 받을 수 있어요.")
    result = service.answer("어르신 연금", None)
    assert "1588-0000" not in result["text"]


def test_invented_age_or_amount_in_llm_reply_is_rejected():
    service, _ = make(dense=[("WLF00001164", 0.7)], reply="기초연금은 만 65세 이상에게 월 30만원을 드려요.")
    result = service.answer("어르신 연금", None)
    assert "65세" not in result["text"]
    assert result["kind"] == "fallback"


def test_free_form_llm_claim_about_profile_is_not_published():
    reply = "70세이시고 혼자 사신다면 기초연금을 확인해 보세요. 실제 대상 여부는 담당 기관에서 확인해 주세요."
    service, _ = make(dense=[("WLF00001164", 0.7)], reply=reply)
    profile = {"age": 70, "income": "under50", "household": "single", "region": "서울특별시", "disability": False}
    assert service.answer("받을 수 있는 연금", profile)["kind"] == "fallback"


def test_free_form_llm_reply_is_not_evidence():
    service, _ = make(dense=[("WLF00001164", 0.7)], reply="첫 문장이에요.\n\n둘째 문장이에요.")
    assert service.answer("어르신 연금", None)["kind"] == "fallback"


def test_truncated_free_form_llm_reply_is_not_published():
    service, _ = make(dense=[("WLF00001164", 0.7)], reply="기초연금을 확인해 보세요. 담당 기관에서 대상 여부를")
    assert service.answer("어르신 연금", None)["kind"] == "fallback"


def test_embedding_failure_uses_keyword_search():
    service, _ = make(embed_fail=True)
    result = service.answer("노인 돌봄 서비스가 필요해요", None)
    assert result["kind"] == "answer"
    assert result["services"][0]["name"] == "노인맞춤돌봄서비스"


def test_profile_is_passed_to_llm_prompt():
    captured = {}

    class Capture(FakeOllama):
        def chat(self, system, user):
            captured["user"] = user
            return super().chat(system, user)

    service = ChatService(FakeRepo(dense=[("WLF00001164", 0.7)]), Capture(), min_similarity=0.45, top_n=5,
                          reranker=FakeReranker())
    profile = {"age": 70, "income": "under50", "household": "single", "region": "서울특별시", "disability": False}
    service.answer("받을 수 있는 연금", profile)
    assert "70세" in captured["user"] and "혼자 살아요" in captured["user"]


def test_database_failure_raises():
    service = ChatService(FakeRepo(fail=True), FakeOllama(), min_similarity=0.45, top_n=5)
    with pytest.raises(RuntimeError):
        service.answer("연금", None)


def test_keyword_search_still_runs_when_dense_results_are_below_threshold():
    service, _ = make(dense=[("WLF00001164", 0.1)])
    result = service.answer("노인 돌봄 서비스가 필요해요", None)
    assert result["kind"] == "answer"
    assert result["services"][0]["id"] == CARE.service_id


def test_hybrid_search_promotes_results_found_by_both_methods():
    service, _ = make(dense=[(CARE.service_id, 0.8), (PENSION.service_id, 0.7)])
    result = service.answer("연금 지원이 궁금해요", None)
    assert result["services"][0]["id"] == PENSION.service_id


def test_repeated_dense_chunks_do_not_consume_multiple_cards():
    service, _ = make(dense=[
        (PENSION.service_id, 0.8), (PENSION.service_id, 0.7), (CARE.service_id, 0.6),
    ])
    result = service.answer("노후에 필요한 도움", None)
    assert [item["id"] for item in result["services"]] == [PENSION.service_id, CARE.service_id]


@pytest.mark.parametrize("reply", [
    "기초연금은 30만원을 지원합니다.",
    "기초연금은 65세 이상이면 받을 수 있어요.",
    "기초연금은 1588로 문의하세요.",
    "기초연금은 https://example.com/apply 에서 신청해요.",
])
def test_query_is_not_a_source_for_invented_conditions_contacts_or_links(reply):
    service, _ = make(dense=[(PENSION.service_id, 0.8)], reply=reply)
    result = service.answer("65세에게 30만원인가요? 1588 또는 https://example.com/apply 맞나요?", None)
    assert result["kind"] == "fallback"


def test_profile_age_is_not_evidence_of_an_eligibility_threshold():
    service, _ = make(dense=[(PENSION.service_id, 0.8)], reply="기초연금은 70세 이상이면 받을 수 있어요.")
    result = service.answer("연금 지원", {"age": 70})
    assert "70세 이상" not in result["text"]


def test_empty_catalog_is_cached_and_does_not_call_models():
    class EmptyRepo:
        calls = 0

        def all_services(self):
            self.calls += 1
            return []

    repo = EmptyRepo()
    model = FakeOllama()
    service = ChatService(repo, model, 0.5, 5)
    assert service.answer("연금", None)["kind"] == "fallback"
    assert service.answer("주거", None)["kind"] == "fallback"
    assert repo.calls == 1
    assert model.chat_calls == 0


def test_reranker_reorders_candidates_before_source_selection():
    model = FakeOllama()
    reranker = FakeReranker(scores=[0.6, 0.95])
    service = ChatService(FakeRepo(dense=[(PENSION.service_id, 0.9), (CARE.service_id, 0.8)]),
                          model, 0.45, 12, reranker=reranker)
    result = service.answer("노후에 필요한 도움", None)
    assert [r["id"] for r in result["services"]] == [CARE.service_id, PENSION.service_id]
    assert CARE.summary in result["text"]
    assert reranker.calls[0][0] == "노후에 필요한 도움"


@pytest.mark.parametrize("scores", [[0.49], [float("nan")], [], [1.1]])
def test_irrelevant_or_invalid_rerank_scores_abstain_without_generation(scores):
    model = FakeOllama()
    service = ChatService(FakeRepo(dense=[(PENSION.service_id, 0.99)]), model, 0.45, 12,
                          reranker=FakeReranker(scores))
    assert service.answer("우주 여행 지원", None)["kind"] == "fallback"
    assert model.chat_calls == 0


def test_unavailable_reranker_does_not_publish_retrieval_candidates():
    service = ChatService(FakeRepo(dense=[(PENSION.service_id, 0.99)]), FakeOllama(), 0.45, 12,
                          reranker=FakeReranker(fail=True))
    assert service.answer("연금 지원", None)["kind"] == "fallback"


@pytest.mark.parametrize("selection", [
    {"service_ids": []}, {"service_ids": ["unknown"]}, {"service_ids": "WLF00001164"},
    {"service_ids": [PENSION.service_id, PENSION.service_id]}, {}, {"service_ids": [None]},
])
def test_invalid_or_empty_source_selection_abstains(selection):
    service, _ = make(dense=[(PENSION.service_id, 0.9)], reply=selection)
    assert service.answer("어르신 연금", None)["kind"] == "fallback"


def test_only_database_facts_are_published_even_if_model_adds_invented_text():
    service, _ = make(dense=[(PENSION.service_id, 0.9)], reply={
        "service_ids": [PENSION.service_id], "text": "65세면 100만원, 1588-0000, https://invented.invalid",
    })
    result = service.answer("65세면 100만원인가요?", None)
    assert result["kind"] == "answer"
    assert result["text"] == f"{PENSION.name}: {PENSION.summary} 자료의 기준일과 실제 대상 여부는 담당 기관에서 확인해 주세요."
    assert result["services"][0]["url"] == PENSION.url
    assert result["services"][0]["contacts"] == PENSION.contacts


def test_generic_discount_word_alone_does_not_make_unrelated_service_relevant():
    from dataclasses import replace

    class DiscountRepo(FakeRepo):
        def all_services(self):
            return [replace(PENSION, name="양곡할인", summary="저소득층의 양곡 구매를 지원합니다.")]

    model = FakeOllama()
    service = ChatService(DiscountRepo(dense=[]), model, 0.52, 5)
    assert service.answer("반려동물 미용 할인", None)["kind"] == "fallback"
    assert model.chat_calls == 0
