"""동의한 저장 정보는 검색·준비와 분리해 최종 생성에만 제공한다."""

import json
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from BackEnd.core.settings import Settings
from BackEnd.documents.context import PREPARE_SYSTEM
from BackEnd.documents.qa import answer_document
from BackEnd.profile_context import ProfileContext
from BackEnd.tests.test_api import api  # noqa: F401
from BackEnd.tests.test_document_qa import components


PROFILE = {"age": 72, "income": "under50", "household": "single", "region": "부산광역시", "disability": False}
CONSENT = {"enabled": True, "consent_revision": 3, "profile_revision": 5, "profile": PROFILE}


def test_saved_profile_is_absent_from_preparation_search_and_off_final_prompt():
    prompts, searches = [], []
    for consent in (None, CONSENT):
        repo, service, calls = components()
        original = service.llm.chat
        def chat(system, user, **kwargs):
            if system == PREPARE_SYSTEM:
                payload = json.loads(user)
                return {"relation": "followup", "search_query": payload["current_question"],
                        "source_ids": [item["id"] for item in payload["sources"]], "document_ids": [], "needs_clarification": False}
            return original(system, user, **kwargs)
        service.llm.chat = Mock(side_effect=chat)
        service.llm.embed = Mock(wraps=service.llm.embed)
        result, trace = answer_document(repo, service, "지원 조건을 알려주세요", profile=PROFILE,
                                       history=[{"role": "user", "content": "어머니 상담입니다"}], profile_context=consent)
        assert result["kind"] == "answer"
        assert service.llm.chat.call_count == 2
        preparation = service.llm.chat.call_args_list[0]
        assert preparation.args[0] == PREPARE_SYSTEM
        assert "부산광역시" not in preparation.args[1] and "saved_profile" not in preparation.args[1]
        final = service.llm.chat.call_args_list[1].args[1]
        intent = json.loads(final.split("비근거 상담 맥락(JSON):\n")[1].split("\n\n문서 근거(JSON):")[0])
        if consent:
            assert intent["saved_profile"] == {**PROFILE, "income": "기준중위소득 50% 이하", "household": "혼자 살아요"}
            assert "어머니 상담입니다" in intent["user_sources"]
        else:
            assert "saved_profile" not in intent and "부산광역시" not in final
        assert "부산광역시" not in json.dumps(trace, ensure_ascii=False)
        prompts.append(preparation.args[1]);searches.append(service.llm.embed.call_args)
    assert prompts[0] == prompts[1] and searches[0] == searches[1]


@pytest.mark.parametrize("change", [{"enabled": False}, {"enabled": 1}, {"consent_revision": -1}, {"profile_revision": True},
                                  {"profile": None}, {"extra": "unexpected"}, {"profile": {**PROFILE, "region": "상세주소"}},
                                  {"profile": {**PROFILE, "name": "이름"}}])
def test_invalid_or_missing_consent_never_reaches_search_or_model(change):
    repo, service, _ = components()
    repo.snapshot = Mock(wraps=repo.snapshot)
    service.llm.embed = Mock(wraps=service.llm.embed)
    with pytest.raises(ValidationError):
        answer_document(repo, service, "질문", profile_context={**CONSENT, **change})
    repo.snapshot.assert_not_called();service.llm.embed.assert_not_called()


@pytest.mark.parametrize("code,label", [
    ("under50", "기준중위소득 50% 이하"), ("under100", "기준중위소득 50~100%"),
    ("under150", "기준중위소득 100~150%"), ("over150", "기준중위소득 150% 초과"),
    ("unknown", "소득 구간 모름"),
])
def test_final_profile_income_keeps_percentage_unit_and_unknown_instead_of_cash_amount(code, label):
    repo, service, _ = components()
    service.llm.chat = Mock(wraps=service.llm.chat)
    submitted = {**PROFILE, "income": code}
    answer_document(repo, service, "지원 조건을 알려주세요", profile_context={**CONSENT, "profile": submitted})
    final = service.llm.chat.call_args.args[1]
    intent = json.loads(final.split("비근거 상담 맥락(JSON):\n")[1].split("\n\n문서 근거(JSON):")[0])
    assert intent["saved_profile"] == {**submitted, "income": label, "household": "혼자 살아요"}
    assert submitted["income"] == code and PROFILE["income"] == "under50"


def test_consent_revision_and_profile_are_required():
    for field in CONSENT:
        with pytest.raises(ValidationError):
            ProfileContext.model_validate({key: value for key, value in CONSENT.items() if key != field})


def test_http_old_client_defaults_off_and_new_consent_is_explicit(api, monkeypatch):
    response = api.client.post("/api/v1/chat", json={"query": "공개 상담", "profile": PROFILE})
    assert response.status_code == 200
    assert "profile_context" not in api.main.answer_document.call_args.kwargs
    response = api.client.post("/api/v1/chat", json={"query": "공개 상담", "profile_context": CONSENT})
    assert response.status_code == 200
    assert api.main.answer_document.call_args.kwargs["profile_context"] == CONSENT
    api.main.answer_document.reset_mock()
    response = api.client.post("/api/v1/chat", json={"query": "공개 상담", "profile_context": {**CONSENT, "enabled": False}})
    assert response.status_code == 422 and response.json() == {"detail": "invalid_document_request"}
    api.main.answer_document.assert_not_called()
    monkeypatch.setattr(api.main, "get_settings", lambda: Settings(_env_file=None, documents_enabled=True))
    capability = api.client.get("/api/v1/chat/capabilities")
    assert capability.json() == {"profile_context_supported": True, "referral_records_enabled": False}
    assert capability.headers["cache-control"] == "no-store"
