import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from BackEnd.core.privacy import mask_text, redact_document, sensitive_input
from BackEnd.documents.auth import require_document_admin
from BackEnd.documents.store import get_document_store
from BackEnd.tests.test_api import api  # noqa: F401


CASES = json.loads((Path(__file__).parent / "fixtures/document_privacy_cases.json").read_text(encoding="utf-8"))
DOC = "00000000-0000-0000-0000-000000000001"
PATHS = ["/api/v1/chat", f"/api/v1/admin/documents/{DOC}/query", f"/api/v1/admin/documents/{DOC}/search"]


def test_source_metadata_is_display_text_and_original_is_preserved():
    original = {'region_scope':'서울특별시 991399-1234567', 'source_organization':'기관 개인 연락처: 010-1234-5678'}
    result = redact_document(original)
    assert '991399-1234567' not in result['region_scope']
    assert '010-1234-5678' not in result['source_organization']
    assert original['region_scope'].endswith('991399-1234567')


@pytest.mark.parametrize("case", CASES)
def test_shared_input_policy(case):
    assert sensitive_input(case["text"]) is case["sensitive"]


@pytest.fixture
def guarded_api(api, monkeypatch):
    import BackEnd.documents.api as documents
    forbidden = Mock(side_effect=AssertionError("입력 차단 전에 저장소·모델에 접근했습니다."))
    monkeypatch.setattr(documents, "scoped_repository", forbidden)
    monkeypatch.setitem(api.main.app.dependency_overrides, require_document_admin, lambda: "test-actor")
    monkeypatch.setitem(api.main.app.dependency_overrides, get_document_store, lambda: object())
    api.scoped = forbidden
    return api


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("case", [case for case in CASES if case["sensitive"]])
def test_all_query_routes_reject_before_rag_without_input_in_error_or_log(guarded_api, path, case, caplog):
    response = guarded_api.client.post(path, json={"query": case["text"]})
    assert response.status_code == 422
    assert response.json() == {"detail": "sensitive_input"}
    assert case["text"] not in response.text + caplog.text
    guarded_api.rag.assert_not_called()
    guarded_api.scoped.assert_not_called()


@pytest.mark.parametrize("role", ["user", "assistant"])
def test_history_is_checked_even_when_not_consumed(api, role, caplog):
    raw = "991399-1234567"
    response = api.client.post(PATHS[0], json={"query": "정상 질문", "history": [{"role": role, "content": raw}]})
    assert response.status_code == 422 and response.json() == {"detail": "sensitive_input"}
    assert raw not in response.text + caplog.text
    api.rag.assert_not_called()


@pytest.mark.parametrize("path", PATHS)
def test_malformed_and_shape_errors_do_not_echo_input(guarded_api, path, caplog):
    raw = "991399-1234567"
    for kwargs in [dict(json={"query": {"nested": raw}}), dict(content='{"query":"' + raw, headers={"Content-Type": "application/json"})]:
        response = guarded_api.client.post(path, **kwargs)
        assert response.status_code == 422
        assert response.json() == {"detail": "invalid_document_request"}
        assert raw not in response.text + caplog.text


@pytest.mark.parametrize("case", [case for case in CASES if not case["sensitive"]])
def test_normal_numeric_questions_reach_existing_chat(api, case):
    assert api.client.post(PATHS[0], json={"query": case["text"]}).status_code == 200
    api.rag.assert_called_once_with(api.service.repo, api.service, case["text"])


def sensitive_answer():
    return {"kind": "answer", "text": "가상 991399-1234567, 계좌번호: 321-00-000001. 2026년 129/1355 안내",
            "services": [], "suggestions": [], "contacts": [{"label": "공공기관", "phone": "010-0000-0000"}],
            "evidence": [{"chunk_id": "chunk", "quote": "991399-1234567", "context": "계좌번호: 321-00-000001", "pages": [1]}]}


def test_response_and_evidence_masking_does_not_mutate_source_or_public_contacts(api):
    original = sensitive_answer()
    before = copy.deepcopy(original)
    api.rag.return_value = original, {}
    response = api.client.post(PATHS[0], json={"query": "문서 내용"}).json()
    assert "991399-1234567" not in json.dumps(response, ensure_ascii=False)
    assert "321-00-000001" not in json.dumps(response, ensure_ascii=False)
    assert response["evidence"][0]["redacted"] is True
    assert response["contacts"] == before["contacts"] and "2026년 129/1355" in response["text"]
    assert original == before


def test_admin_query_and_search_mask_only_response_copies(guarded_api, monkeypatch):
    import BackEnd.documents.api as documents
    answer = sensitive_answer()
    before = copy.deepcopy(answer)
    store = SimpleNamespace(status=lambda _id: ({"test_only": False, "program_test_only": False}, None))
    monkeypatch.setitem(guarded_api.main.app.dependency_overrides, get_document_store, lambda: store)
    snapshot = SimpleNamespace(stamp="stamp", chunks=[SimpleNamespace(chunk_id="chunk", embed_digest="digest")])
    chunk = SimpleNamespace(chunk_id="chunk", section="content", text=answer["text"], score=.5, start=0, end=30, page_refs=[1], source_blocks=["b1"])
    repo = SimpleNamespace(snapshot=lambda: snapshot, dense_search=Mock(return_value=[chunk]))
    service = SimpleNamespace(llm=SimpleNamespace(model_digest=lambda: "digest", embed=Mock(return_value=[[0.0]])))
    service.llm.for_request = lambda *_: service.llm
    monkeypatch.setattr(documents, "scoped_repository", lambda *_: repo)
    monkeypatch.setattr("BackEnd.rag.factory.build_chat_service", lambda *_: service)
    monkeypatch.setattr("BackEnd.documents.qa.answer_document", lambda *_: (answer, {}))
    for path in PATHS[1:]:
        response = guarded_api.client.post(path, json={"query": "2026년 129 연락처"})
        assert response.status_code == 200
        assert "991399-1234567" not in response.text and "321-00-000001" not in response.text
        item = response.json().get("chunks", response.json().get("response", {}).get("evidence"))[0]
        assert item["redacted"] is True
    assert answer == before and chunk.text == before["text"]


def test_personal_output_phone_and_conservative_history_have_distinct_boundaries():
    assert "010-0000-0000" not in mask_text("개인 연락처: 010-0000-0000")
    assert "010-0000-0000" not in mask_text("신청자의 휴대전화번호는 010-0000-0000")
    assert mask_text("공공기관 연락처 010-0000-0000") == "공공기관 연락처 010-0000-0000"
    assert "010-0000-0000" not in mask_text("공공기관 연락처 010-0000-0000", user_history=True)
    assert redact_document({"contacts": [{"phone": "129"}, {"phone": "1355"}]}) == {"contacts": [{"phone": "129"}, {"phone": "1355"}]}


def test_redaction_preserves_machine_references_and_original_ranges():
    token = "prefix-9913991234567-suffix"
    metadata = {key: token for key in ("chunk_id", "document_id", "model_digest", "hash", "snapshot", "section")}
    metadata.update(source_blocks=[token], required_by=[token], start=9913991234567, end=9913991234599, pages=[1])
    original = {**metadata, "text": "가상 9913991234567", "quote": "9913991234567", "context": "계좌번호: 321-00-000001",
                "source_url": "https://example.invalid/source?value=9913991234567"}
    before = copy.deepcopy(original)
    safe = redact_document(original)
    assert {key: safe[key] for key in metadata} == metadata
    for key in ("text", "quote", "context", "source_url"):
        assert "[개인정보 가림]" in safe[key]
    assert safe["redacted"] is True and original == before
    url_only = redact_document({**metadata, "text": "안전한 본문", "source_url": original["source_url"]})
    assert url_only["redacted"] is True and url_only["text"] == "안전한 본문"
    unchanged = {**metadata, "text": "2026년 129/1355 안내"}
    assert redact_document(unchanged) == unchanged
