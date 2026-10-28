from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from BackEnd.admin.program_store import ProgramError, get_program_store
from BackEnd.core.settings import Settings
from BackEnd.documents.auth import require_document_admin
from BackEnd.main import app

UPDATED = datetime(2026, 10, 28, 1, 2, 3, 456789, tzinfo=timezone.utc)


def program(**values):
    data = {"program_id": 7, "service_id": "WLF00000001", "external_service_id": "WLF00000001",
            "program_name": "기초연금", "summary": "노인 생활 안정", "department_id": 3,
            "department_name": "기초연금과", "ministry_name": "보건복지부",
            "contacts": [{"label": "보건복지상담센터", "phone": "129"}], "source_url": "https://www.bokjiro.go.kr/x",
            "source_updated_at": None, "test_only": False, "updated_at": UPDATED,
            "document_count": 0, "published_count": 0}
    return data | values


class RecordingStore:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def _result(self, name, *args, result=None):
        self.calls.append((name, *args))
        if self.error:
            raise ProgramError(self.error)
        return result

    def search(self, query, offset, limit):
        return self._result("search", query, offset, limit, result={"items": [program()], "offset": offset, "limit": limit, "next_offset": None})

    def departments(self):
        return self._result("departments", result=[{"department_id": 3, "department_name": "기초연금과", "ministry_name": "보건복지부"}])

    def create(self, data):
        return self._result("create", data, result=program(**{k: v for k, v in data.items() if k in program()}))

    def update(self, program_id, changes, expected_updated_at):
        return self._result("update", program_id, changes, expected_updated_at, result=program(program_id=program_id, **changes))

    def delete(self, program_id):
        return self._result("delete", program_id)


@pytest.fixture
def client():
    stores = []

    def make(error=None):
        store = RecordingStore(error)
        stores.append(store)
        app.dependency_overrides[require_document_admin] = lambda: None
        app.dependency_overrides[get_program_store] = lambda: store
        return TestClient(app), store

    yield make
    app.dependency_overrides.clear()


def valid_body(**values):
    data = {"program_name": "행복 반찬나눔", "summary": "홀로 사는 어르신께 반찬을 전달합니다.", "department_id": 3,
            "contacts": [{"label": "행복복지관", "phone": "02-123-4567"}]}
    return data | values


def test_admin_program_routes_require_admin_token(monkeypatch):
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: Settings(documents_enabled=True, documents_local_mode=False))
    app.dependency_overrides[get_program_store] = lambda: RecordingStore()
    try:
        response = TestClient(app).get("/api/v1/admin/programs")
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 401


def test_list_returns_programs_with_document_counts(client):
    http, store = client()
    response = http.get("/api/v1/admin/programs?query=연금&limit=20")
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["service_id"] == "WLF00000001"
    assert item["document_count"] == 0 and item["published_count"] == 0
    assert store.calls == [("search", "연금", 0, 20)]


def test_departments_are_listed_for_the_form(client):
    http, _ = client()
    response = http.get("/api/v1/admin/departments")
    assert response.status_code == 200
    assert response.json()[0]["department_name"] == "기초연금과"


def test_create_program_passes_validated_fields(client):
    http, store = client()
    response = http.post("/api/v1/admin/programs", json=valid_body(source_url="https://www.bokjiro.go.kr/y"))
    assert response.status_code == 201
    data = store.calls[0][1]
    assert data["program_name"] == "행복 반찬나눔"
    assert data["source_url"] == "https://www.bokjiro.go.kr/y"
    assert data["contacts"] == [{"label": "행복복지관", "phone": "02-123-4567"}]
    assert data["test_only"] is False


@pytest.mark.parametrize("body", [
    valid_body(program_name=""),
    valid_body(program_name="가" * 201),
    valid_body(external_service_id="TEST_MOCK"),
    valid_body(external_service_id="wlf 1"),
    valid_body(source_url="http://insecure.example/x"),
    valid_body(source_url="https://example.com/x?token=secret"),
    valid_body(contacts=[{"label": "", "phone": "129"}]),
    valid_body(contacts=[{"label": "기관", "phone": "<script>"}]),
    valid_body(eligibility="문서 검토 없이 넣은 자격"),
])
def test_create_rejects_invalid_or_unreviewed_fields(client, body):
    http, store = client()
    response = http.post("/api/v1/admin/programs", json=body)
    assert response.status_code == 422
    assert store.calls == []


def test_test_service_id_is_allowed_only_for_test_programs(client):
    http, store = client()
    response = http.post("/api/v1/admin/programs", json=valid_body(external_service_id="TEST_MOCK", test_only=True))
    assert response.status_code == 201
    assert store.calls[0][1]["external_service_id"] == "TEST_MOCK"


def test_update_sends_only_given_fields_with_expected_version(client):
    http, store = client()
    response = http.patch("/api/v1/admin/programs/7", json={"summary": "새 요약", "expected_updated_at": UPDATED.isoformat()})
    assert response.status_code == 200
    name, program_id, changes, expected = store.calls[0]
    assert (name, program_id, changes) == ("update", 7, {"summary": "새 요약"})
    assert expected == UPDATED


@pytest.mark.parametrize("field", ["program_name", "department_id", "contacts", "test_only"])
def test_update_rejects_clearing_required_fields(client, field):
    http, store = client()
    response = http.patch("/api/v1/admin/programs/7", json={field: None, "expected_updated_at": UPDATED.isoformat()})
    assert response.status_code == 422
    assert store.calls == []


def test_update_requires_expected_version(client):
    http, store = client()
    response = http.patch("/api/v1/admin/programs/7", json={"summary": "새 요약"})
    assert response.status_code == 422
    assert store.calls == []


@pytest.mark.parametrize("code,status", [
    ("program_not_found", 404),
    ("program_changed", 409),
    ("program_has_documents", 409),
    ("duplicate_service_id", 409),
    ("department_not_found", 422),
    ("test_service_requires_test_only", 422),
])
def test_store_errors_are_mapped_to_http_status(client, code, status):
    http, _ = client(error=code)
    response = http.patch("/api/v1/admin/programs/7", json={"program_name": "새 이름", "expected_updated_at": UPDATED.isoformat()})
    assert response.status_code == status
    assert response.json()["detail"] == code


def test_unexpected_store_failure_hides_details(client):
    http, store = client()

    def broken(*_):
        raise RuntimeError("connection string with secret")

    store.delete = broken
    response = http.delete("/api/v1/admin/programs/7")
    assert response.status_code == 503
    assert "secret" not in response.text


def test_delete_program_returns_no_content(client):
    http, store = client()
    response = http.delete("/api/v1/admin/programs/7")
    assert response.status_code == 204
    assert store.calls == [("delete", 7)]
