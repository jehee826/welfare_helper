import io
from uuid import uuid4
import zipfile

import pytest
from fastapi.testclient import TestClient

from BackEnd.core.settings import Settings
from BackEnd.documents.auth import require_document_admin
from BackEnd.documents.contracts import DocumentError, DocumentMetadata, stable_hash, validate_file, validate_review
from BackEnd.documents.store import get_document_store
from BackEnd.main import app


def metadata(**values):
    return DocumentMetadata(service_id="TEST_DOCUMENT", name="가상 문서", source_url="https://example.invalid/document",
                            basis_year="2026", test_only=True, **values)


def test_test_corpus_cannot_be_attached_to_government_service():
    with pytest.raises(ValueError):
        DocumentMetadata(service_id="WLF00001164", name="가상", source_url="https://example.invalid/x", basis_year="2026", test_only=True)
    with pytest.raises(ValueError):
        DocumentMetadata(service_id="TEST_DOCUMENT", name="가상", source_url="https://example.invalid/x", basis_year="2026")


def test_secret_source_urls_are_rejected():
    with pytest.raises(ValueError):
        DocumentMetadata(service_id="TEST_DOCUMENT", name="가상", source_url="https://example.invalid/x?token=private", basis_year="2026", test_only=True)


def test_markdown_is_accepted_as_input_for_docling_not_direct_embedding():
    validate_file("# 가상 문서\n본문입니다.".encode(), "md", 1000)
    with pytest.raises(DocumentError):
        validate_file(b"![image](file:///private)", "md", 1000)
    with pytest.raises(DocumentError):
        validate_file(b"not a pdf", "pdf", 1000)
    with pytest.raises(DocumentError):
        validate_file(b"text", "txt", 1000)


@pytest.mark.parametrize("relation", ['<Relationships TargetMode="External"/>', "<Relationships TargetMode = 'External'/>"])
def test_docx_archive_external_relationship_is_rejected(relation):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<document/>")
        archive.writestr("word/_rels/document.xml.rels", relation)
    with pytest.raises(DocumentError):
        validate_file(output.getvalue(), "docx", 10000)


def test_analysis_hash_is_stable_across_json_page_key_conversion():
    assert stable_hash({"pages": {1: "가상", 10: "본문", 2: "끝"}}) == stable_hash({"pages": {"1": "가상", "10": "본문", "2": "끝"}})


def review():
    return {"sections": {key: [key] for key in ("target", "criteria", "benefit", "application")},
            "excluded_blocks": {}, "confirm_complete": True, "confirm_source_and_service": True}


def test_review_must_cover_every_block_and_preserve_quality_gates():
    analysis = {"blocks": [{"id": key, "text": "가상 원문"} for key in review()["sections"]], "blockers": []}
    validate_review(analysis, review())
    with pytest.raises(DocumentError):
        validate_review({**analysis, "blockers": ["table_grid_incomplete"]}, review())
    with pytest.raises(DocumentError):
        validate_review({**analysis, "blocks": analysis["blocks"] + [{"id": "exception", "text": "제외 조건"}]}, review())
    with pytest.raises(DocumentError):
        validate_review(analysis, {**review(), "confirm_complete": False})


def test_upload_only_saves_source_and_queues_analysis(monkeypatch):
    actor, did, jid, calls = str(uuid4()), str(uuid4()), str(uuid4()), []

    class Store:
        def register(self, meta, digest, size, suffix, user, config):
            calls.append("register")
            assert meta["test_only"] and suffix == "md" and user == actor
            return {"id": did, "object_key": "private/original", "test_only": True}

        def queue_analysis(self, document_id, user):
            calls.append("queue")
            return {"id": jid, "state": "queued"}

    class Storage:
        def put(self, key, data, content_type):
            calls.append("storage")
            assert data.startswith(b"#")

    settings = Settings(_env_file=None, documents_enabled=True)
    monkeypatch.setattr("BackEnd.documents.api.get_settings", lambda: settings)
    monkeypatch.setattr("BackEnd.documents.api.PrivateStorage", lambda _: Storage())
    app.dependency_overrides[require_document_admin] = lambda: actor
    app.dependency_overrides[get_document_store] = lambda: Store()
    try:
        response = TestClient(app).post("/api/v1/admin/documents", files={"file": ("sample.md", b"# test\nsource", "text/markdown")},
                                       data={"metadata": metadata().model_dump_json()})
        assert response.status_code == 202 and response.json()["embedding_started"] is False
        assert calls == ["register", "storage", "queue"]
    finally:
        app.dependency_overrides.clear()


def test_index_request_does_not_start_models_before_analysis(monkeypatch):
    actor, did = str(uuid4()), str(uuid4())
    settings = Settings(_env_file=None, documents_enabled=True)
    monkeypatch.setattr("BackEnd.documents.api.get_settings", lambda: settings)
    monkeypatch.setattr("BackEnd.documents.api.PrivateStorage", lambda _: object())

    class Store:
        def analysis_result(self, _):
            raise DocumentError("analysis_not_ready")

    app.dependency_overrides[require_document_admin] = lambda: actor
    app.dependency_overrides[get_document_store] = lambda: Store()
    try:
        request = {**review(), "analysis_hash": "0" * 64, "review_note": "가상 원문 대조 검토입니다."}
        response = TestClient(app).post(f"/api/v1/admin/documents/{did}/index", json=request)
        assert response.status_code == 409 and response.json()["detail"] == "analysis_not_ready"
    finally:
        app.dependency_overrides.clear()


def test_document_admin_auth_rejects_browser_key_without_user_session(monkeypatch):
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: Settings(_env_file=None, documents_enabled=True))
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        require_document_admin(None)
    assert error.value.status_code == 401


def test_user_editable_admin_metadata_does_not_grant_database_permission(monkeypatch):
    import httpx
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials

    actor = str(uuid4())
    settings = Settings(_env_file=None, documents_enabled=True, supabase_url="https://example.invalid",
                        supabase_service_key="test-only")
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: settings)
    monkeypatch.setattr(httpx, "get", lambda url, **kw: httpx.Response(200, request=httpx.Request("GET", url),
        json={"id": actor, "user_metadata": {"role": "admin"}}))

    class Store:
        def is_admin(self, user):
            assert user == actor
            return False

    monkeypatch.setattr("BackEnd.documents.store.get_document_store", lambda: Store())
    with pytest.raises(HTTPException) as error:
        require_document_admin(HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-user-token"))
    assert error.value.status_code == 403
