import pytest

from BackEnd.tests.test_api import api  # noqa: F401


LEGACY = {"age": 70, "income": "under50", "household": "single", "region": "서울특별시", "disability": False}
UNKNOWN = {"age": None, "income": "unknown", "household": None, "region": None, "disability": None}


@pytest.mark.parametrize("profile", [LEGACY, UNKNOWN, {}, None, {**LEGACY, "region": "서울"}])
def test_existing_and_unknown_profile_contract_is_accepted_but_not_forwarded_to_qa(api, profile):
    response = api.client.post("/api/v1/chat", json={"query": "가상 문서 질문", "profile": profile})
    assert response.status_code == 200 and response.json() == api.result
    parsed = api.main.ChatRequest(query="질문", profile=profile)
    api.rag.assert_called_once_with(api.service.repo, api.service, "가상 문서 질문")
    assert parsed.profile is None if profile is None else parsed.profile.model_dump() == (UNKNOWN if profile == {} else profile)


@pytest.mark.parametrize("changes", [{"age": -1}, {"age": 121}, {"age": 1.5}, {"age": True}, {"income": "invented"},
                                      {"household": "invented"}, {"disability": "false"}, {"region": "x" * 21}, {"name": "가상 실명"}])
def test_invalid_profile_is_rejected_without_external_calls_or_input_echo(api, changes):
    response = api.client.post("/api/v1/chat", json={"query": "가상 질문", "profile": {**LEGACY, **changes}})
    assert response.status_code == 422 and response.json() == {"detail": "invalid_document_request"}
    api.rag.assert_not_called()
    assert "가상 실명" not in response.text


@pytest.mark.parametrize("region", ["010-0000-0000", "991399-1234567", "계좌 123456789"])
def test_free_text_legacy_region_keeps_privacy_boundary(api, region, caplog):
    response = api.client.post("/api/v1/chat", json={"query": "가상 질문", "profile": {**LEGACY, "region": region}})
    assert response.status_code == 422 and response.json() == {"detail": "sensitive_input"}
    assert region not in response.text + caplog.text
    api.rag.assert_not_called()
