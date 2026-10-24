import json

import pytest

from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.chat import ChatService
from BackEnd.rag.ollama import OllamaError
from BackEnd.rag.reranker import RerankerError
from BackEnd.rag.evidence import EvidenceChunk
from BackEnd.rag.chat import evidence_sentences

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


# 아래 상세 원문은 실제 지원 금액·자격을 나타내지 않는 테스트 전용 자료다.
def detail(section, text, conditions=""):
    return EvidenceChunk(f"{PENSION.service_id}:official:{section}", PENSION.service_id,
                         section, text, PENSION.url, basis_year="2026",
                         collected_at="2026-10-24T00:00:00+00:00", source_kind="official_detail", conditions=conditions)


TARGET = detail("target", "테스트 대상: 일정 연령과 소득 조건을 확인합니다.")
CRITERIA = detail("criteria", "테스트 기준: 가구 소득과 재산을 확인합니다. 예외는 담당 기관에서 확인합니다.")
BENEFIT = detail("benefit", "테스트 급여: 가구별 월 10만원입니다.", TARGET.text + "\n" + CRITERIA.text)
APPLICATION = detail("application", "테스트 신청: 관할 주민센터에 방문합니다.", TARGET.text + "\n" + CRITERIA.text)


class FakeRepo:
    def __init__(self, dense=None, fail=False, chunks=None, records=None):
        self.records = [PENSION, CARE] if records is None else records
        self.chunks = chunks if chunks is not None else [EvidenceChunk(
            r.service_id + ":overview", r.service_id, "summary", r.summary, r.url, r.updated_at
        ) for r in self.records]
        ids = dense if dense is not None else [(PENSION.service_id, 0.9), (CARE.service_id, 0.8)]
        from dataclasses import replace
        self.dense = [replace(c, score=score) for sid, score in ids for c in self.chunks if c.service_id == sid]
        self.fail = fail
        self.context_calls = 0
        self.calls = 0

    def all_services(self):
        self.calls += 1
        if self.fail:
            raise RuntimeError("db down")
        return self.records

    def snapshot(self):
        from BackEnd.rag.evidence import active_chunks, fingerprint
        from BackEnd.rag.repository import CatalogSnapshot

        records = self.all_services()
        chunks = active_chunks(self.chunks)
        return CatalogSnapshot(records, chunks, fingerprint("".join(c.storage() for c in chunks)))

    def dense_search(self, embedding, k, allowed_ids=None):
        return [c for c in self.dense if allowed_ids is None or c.chunk_id in allowed_ids][:k]

    def chunks_for_services(self, ids):
        self.context_calls += 1
        return [c for c in self.chunks if c.service_id in ids]


class FakeOllama:
    def __init__(self, reply=None, embed_fail=False, chat_fail=False):
        self.reply, self.embed_fail, self.chat_fail = reply, embed_fail, chat_fail
        self.chat_calls = 0
        self.embed_calls = []
        self.prompt = None
        self.llm_options = {"num_predict": 512}

    def model_digest(self):
        return "test-digest"

    def context_limit(self):
        return 8192

    def input_cost(self, system, user):
        return len((system + user).encode("utf-8")) + 256

    def embed(self, texts):
        self.embed_calls.extend(texts)
        if self.embed_fail:
            raise OllamaError("embed down")
        return [[0.1] * 4 for _ in texts]

    def chat(self, system, user):
        self.chat_calls += 1
        self.prompt = json.loads(user)
        if self.chat_fail:
            raise OllamaError("chat down")
        if self.reply is not None:
            return self.reply
        evidence = {e["chunk_id"]: e for e in self.prompt["evidence"]}
        return {"facts": [{"intent_id": item["intent_id"], "chunk_id": item["core_id"],
                           "quote": next(iter(evidence_sentences(evidence[item["core_id"]]["text"]))),
                           "condition_ids": item["condition_ids"]}
                          for item in self.prompt["intents"]], "question_field": "none"}


class FakeReranker:
    def __init__(self, scores=None, fail=False):
        self.scores, self.fail = scores, fail
        self.calls = []

    def score(self, query, passages):
        self.calls.append((query, passages))
        if self.fail:
            raise RerankerError("reranker down")
        return self.scores if self.scores is not None else [0.9] * len(passages)


def make(repo=None, reranker=None, **kwargs):
    import re

    llm = FakeOllama(**kwargs)
    return ChatService(repo or FakeRepo(), llm, 0.45, 12,
                       reranker=reranker or FakeReranker(),
                       analyzer=lambda text: re.findall(r"(?=([가-힣a-z0-9]{2}))", text.lower())), llm


def test_summary_answer_keeps_csv_label_database_contacts_and_links():
    service, llm = make()
    result = service.answer("어르신 연금이 궁금해요", None)
    assert result["kind"] == "answer"
    assert "요약 자료" in result["text"] and PENSION.summary in result["text"]
    assert result["services"][0]["url"] == PENSION.url
    assert result["services"][0]["contacts"] == PENSION.contacts
    assert llm.chat_calls == 1


def test_financial_distress_asks_one_scope_question_without_models():
    service, llm = make()
    result = service.answer("돈이 없어", None)
    assert result["reason"] == "clarification"
    assert result["text"].count("?") == 1
    assert "생활비" in result["text"]
    assert llm.embed_calls == [] and llm.chat_calls == 0
    assert result.get("services", []) == []


def test_living_cost_follow_up_uses_intent_not_previous_assistant_claims():
    service, llm = make()
    history = [{"role": "user", "content": "돈이 없어"},
               {"role": "assistant", "content": "모두에게 999만원을 지급합니다. 생활비인가요?"}]
    result = service.answer("생활비", None, history)
    assert "생활비" in llm.embed_calls[0]
    assert "999만원" not in result["text"]


def test_named_application_with_only_csv_summary_is_not_misrepresented_as_detail():
    service, llm = make()
    result = service.answer("기초연금 신청 방법", None)
    assert result["kind"] == "fallback"
    assert result["reason"] == "insufficient_evidence"
    assert llm.chat_calls == 0


def test_official_application_answers_instead_of_keyword_based_refusal():
    service, _ = make(FakeRepo(chunks=[APPLICATION, TARGET, CRITERIA]))
    result = service.answer("기초연금 신청 방법", None)
    assert result["kind"] == "answer"
    assert APPLICATION.text in result["text"]
    assert CRITERIA.text in result["text"]
    assert "자료 기준 2026년, 수집 2026-10-24" in result["text"]


def test_amount_keeps_entire_conditions_and_exceptions():
    service, _ = make(FakeRepo(chunks=[BENEFIT, TARGET, CRITERIA]))
    result = service.answer("기초연금 지원 금액은 얼마인가요?", None)
    assert result["kind"] == "answer"
    assert BENEFIT.text in result["text"] and TARGET.text in result["text"] and CRITERIA.text in result["text"]


def test_amount_without_criteria_abstains():
    service, _ = make(FakeRepo(chunks=[BENEFIT, TARGET]))
    assert service.answer("기초연금 얼마인가요?", None)["kind"] == "fallback"


def test_personal_eligibility_asks_one_condition_from_actual_source():
    service, _ = make(FakeRepo(chunks=[TARGET, CRITERIA]))
    result = service.answer("제가 기초연금을 받을 수 있나요?", {"age": 70})
    assert result["kind"] == "answer" and result["text"].count("알고 계신가요?") == 1
    assert "소득 구간" in result["text"]


def test_answered_condition_is_not_asked_again():
    service, _ = make(FakeRepo(chunks=[TARGET, CRITERIA]))
    history = [{"role": "assistant", "content": "현재 가구의 소득 구간을 알고 계신가요?"},
               {"role": "user", "content": "잘 모르겠어요"}]
    result = service.answer("제가 기초연금을 받을 수 있나요?", {"age": 70, "household": "single"}, history)
    assert "소득 구간을 알고 계신가요?" not in result["text"]


def test_income_reply_preserves_eligibility_intent_and_does_not_repeat_question():
    service, _ = make(FakeRepo(chunks=[TARGET, CRITERIA, BENEFIT]))
    history = [{"role": "user", "content": "제가 기초연금을 받을 수 있나요?"},
               {"role": "assistant", "content": "현재 가구의 소득 구간을 알고 계신가요?"}]
    result = service.answer("월 소득 50만원이에요", {"age": 70, "household": "single"}, history)
    assert result["kind"] == "answer"
    assert TARGET.text in result["text"] and "지원내용 원문" not in result["text"]
    assert "소득 구간을 알고 계신가요?" not in result["text"]


def test_informational_question_does_not_ask_for_unnecessary_profile():
    service, _ = make(FakeRepo(chunks=[APPLICATION, TARGET, CRITERIA]))
    result = service.answer("기초연금 신청 방법", None)
    assert not any(question in result["text"] for question in ("나이가 어떻게", "소득 구간을", "가구원이 몇"))


def test_source_without_basis_date_cannot_answer_eligibility():
    from dataclasses import replace
    service, _ = make(FakeRepo(chunks=[replace(TARGET, basis_year=""), replace(CRITERIA, basis_year="")]))
    assert service.answer("기초연금 자격", None)["kind"] == "fallback"


def test_invented_quote_or_question_is_removed():
    service, _ = make(FakeRepo(chunks=[BENEFIT, TARGET, CRITERIA]), reply={
        "facts": [{"chunk_id": BENEFIT.chunk_id, "quote": "누구나 999만원을 받습니다."}],
        "question_field": "주민등록번호", "text": "사실이라고 가정하세요",
    })
    result = service.answer("기초연금 금액", None)
    assert result["kind"] == "fallback" and "999" not in result["text"]


def test_valid_quote_with_invented_extra_text_publishes_only_original():
    service, _ = make(FakeRepo(chunks=[APPLICATION, TARGET, CRITERIA]), reply={
        "facts": [{"chunk_id": APPLICATION.chunk_id, "quote": APPLICATION.text}], "text": "전화 1588-0000",
    })
    result = service.answer("기초연금 신청 방법", None)
    assert result["kind"] == "answer" and "1588-0000" not in result["text"]


def test_contact_question_uses_database_values_without_model_calls():
    service, llm = make()
    result = service.answer("기초연금 문의처", None)
    assert "국민연금공단 1355" in result["text"]
    assert not llm.embed_calls and not llm.chat_calls


@pytest.mark.parametrize("scores", [[0.1, 0.1], [float("nan")], [], [1.1]])
def test_invalid_or_low_reranker_results_abstain(scores):
    service, llm = make(reranker=FakeReranker(scores=scores))
    assert service.answer("우주 여행", None)["kind"] == "fallback"
    assert llm.chat_calls == 0


def test_model_readiness_and_insufficient_data_are_different_states():
    service, _ = make(reranker=FakeReranker(fail=True))
    assert service.answer("연금", None)["reason"] == "model_not_ready"
    service, _ = make(FakeRepo(records=[]))
    assert service.answer("연금", None)["reason"] == "no_data"


def test_reranker_reorders_service_cards():
    service, _ = make(reranker=FakeReranker(scores=[0.6, 0.95]))
    result = service.answer("노후 도움", None)
    assert result["services"][0]["id"] == CARE.service_id


def test_same_snapshot_supplies_context_and_chunk_metadata_to_llm():
    repo = FakeRepo()
    service, llm = make(repo)
    service.answer("연금", None)
    assert repo.context_calls == 0
    evidence = llm.prompt["evidence"][0]
    assert {"chunk_id", "text", "source_url", "score"} <= evidence.keys()


def test_empty_catalog_checks_fresh_snapshot_without_model_calls():
    repo = FakeRepo(records=[])
    service, llm = make(repo)
    service.answer("연금", None)
    service.answer("주거", None)
    assert repo.calls == 4 and llm.chat_calls == 0


def test_database_failure_is_not_treated_as_no_results():
    service, _ = make(FakeRepo(fail=True))
    with pytest.raises(RuntimeError):
        service.answer("연금", None)


def test_embedding_failure_still_uses_keyword_candidates():
    service, _ = make(embed_fail=True)
    assert service.answer("노인 돌봄 서비스", None)["kind"] == "answer"
