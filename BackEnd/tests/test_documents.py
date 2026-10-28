import io
import base64
import json
from uuid import uuid4
import zipfile

import pytest
from fastapi.testclient import TestClient

from BackEnd.core.settings import Settings
from BackEnd.documents.auth import require_document_admin
from BackEnd.documents.contracts import DocumentError, DocumentMetadata, stable_hash, validate_file, validate_review
from BackEnd.documents.store import get_document_store
from BackEnd.documents.storage import supabase_headers
from BackEnd.main import app


def metadata(**values):
    data = {"service_id":"TEST_DOCUMENT", "name":"가상 문서", "source_url":"https://example.invalid/document",
            "source_organization":"목업 기관", "basis_year":"2026", "test_only":True}
    return DocumentMetadata(**(data | values))


def test_test_flag_is_kept_for_real_program_ids_and_required_for_test_ids():
    flagged = DocumentMetadata(service_id="WLF00001164", name="가상", source_url="https://example.invalid/x",
                               source_organization="목업 기관", basis_year="2026", test_only=True)
    assert flagged.test_only
    with pytest.raises(ValueError):
        DocumentMetadata(service_id="TEST_DOCUMENT", name="가상", source_url="https://example.invalid/x", source_organization="목업 기관", basis_year="2026")


def test_secret_source_urls_are_rejected():
    with pytest.raises(ValueError):
        DocumentMetadata(service_id="TEST_DOCUMENT", name="가상", source_url="https://example.invalid/x?token=private", source_organization="목업 기관", basis_year="2026", test_only=True)


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


def test_legacy_review_must_cover_every_block_and_preserve_quality_gates():
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
        def register(self, meta, digest, size, suffix, user, config, original, *, document_id=None):
            calls.append("register")
            assert meta["test_only"] and suffix == "md" and user == actor
            assert original == b"# test\nsource"
            assert document_id is None and meta["source_organization"] == "목업 기관"
            return ({"document_id":did,"program_id":1,"active_job_id":None}, {"job_id":jid,"state":"queued"})

    settings = Settings(_env_file=None, documents_enabled=True)
    monkeypatch.setattr("BackEnd.documents.api.get_settings", lambda: settings)
    app.dependency_overrides[require_document_admin] = lambda: actor
    app.dependency_overrides[get_document_store] = lambda: Store()
    try:
        response = TestClient(app).post("/api/v1/admin/documents", files={"file": ("sample.md", b"# test\nsource", "text/markdown")},
                                       data={"metadata": metadata(basis_year=None).model_dump_json()})
        assert response.status_code == 202 and response.json()["embedding_started"] is False
        assert response.json()["processing_mode"] == "automatic"
        assert response.json()["human_review_required"] is False
        assert calls == ["register"]
    finally:
        app.dependency_overrides.clear()


def test_index_request_does_not_start_models_before_analysis(monkeypatch):
    actor, did = str(uuid4()), str(uuid4())
    settings = Settings(_env_file=None, documents_enabled=True)
    monkeypatch.setattr("BackEnd.documents.api.get_settings", lambda: settings)

    class Store:
        def analysis_result(self, _):
            raise DocumentError("analysis_not_ready")

    app.dependency_overrides[require_document_admin] = lambda: actor
    app.dependency_overrides[get_document_store] = lambda: Store()
    try:
        request = {**review(), "analysis_hash": "0" * 64, "review_note": "가상 원문 대조 검토입니다."}
        response = TestClient(app).post(f"/api/v1/admin/documents/{did}/index", json=request)
        assert response.status_code == 409 and response.json()["detail"] == "manual_index_disabled_upload_again"
    finally:
        app.dependency_overrides.clear()


def test_document_admin_auth_rejects_browser_key_without_user_session(monkeypatch):
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: Settings(_env_file=None, documents_enabled=True))
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        require_document_admin(None, None)
    assert error.value.status_code == 401


def test_user_editable_admin_metadata_does_not_grant_database_permission(monkeypatch):
    import httpx
    from fastapi import HTTPException
    from fastapi.security import HTTPAuthorizationCredentials

    actor = str(uuid4())
    settings = Settings(_env_file=None, documents_enabled=True, supabase_url="https://example.invalid",
                        supabase_service_key="sb_secret_test-only")
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: settings)
    monkeypatch.setattr(httpx, "get", lambda url, **kw: httpx.Response(200, request=httpx.Request("GET", url),
        json={"id": actor, "user_metadata": {"role": "admin"}}))

    class Store:
        def is_admin(self, user):
            assert user == actor
            return False

    monkeypatch.setattr("BackEnd.documents.store.get_document_store", lambda: Store())
    with pytest.raises(HTTPException) as error:
        require_document_admin(None, HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-user-token"))
    assert error.value.status_code == 403


def legacy_key(role):
    payload = base64.urlsafe_b64encode(json.dumps({"role": role}).encode()).decode().rstrip("=")
    return "eyJhbGciOiJIUzI1NiJ9." + payload + ".test-only-signature"


def test_server_secret_uses_apikey_without_bearer_and_legacy_keeps_compatibility():
    _, modern = supabase_headers(Settings(_env_file=None, supabase_url="https://example.invalid", supabase_service_key="sb_secret_test-only"))
    assert modern == {"apikey": "sb_secret_test-only"}
    key = legacy_key("service_role")
    _, legacy = supabase_headers(Settings(_env_file=None, supabase_url="https://example.invalid", supabase_service_key=key))
    assert legacy == {"apikey": key, "Authorization": "Bearer " + key}


@pytest.mark.parametrize("key", ["sb_publishable_test-only", legacy_key("anon"), "invalid-test-only"])
def test_public_keys_cannot_replace_the_server_key(key):
    with pytest.raises(DocumentError):
        supabase_headers(Settings(_env_file=None, supabase_url="https://example.invalid", supabase_service_key=key))


def test_local_gate_needs_no_cloud_key_but_blocks_other_hosts_origins_and_deployments(monkeypatch):
    from fastapi import Depends, FastAPI

    settings = Settings(_env_file=None, documents_enabled=True, documents_local_mode=True)
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: settings)
    monkeypatch.delenv("VERCEL", raising=False)
    gate = FastAPI()

    @gate.get("/gate")
    def check(actor=Depends(require_document_admin)):
        return {"local": actor is None}

    client = TestClient(gate, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000))
    assert client.get("/gate").json() == {"local": True}
    assert client.get("/gate", headers={"Origin": "https://example.invalid"}).status_code == 403
    assert client.get("/gate", headers={"Host": "example.invalid"}).status_code == 403
    assert client.get("/gate", headers={"X-Forwarded-For": "127.0.0.1"}).status_code == 403
    remote = TestClient(gate, base_url="http://127.0.0.1:8000", client=("198.51.100.7", 50000))
    assert remote.get("/gate").status_code == 403
    monkeypatch.setenv("VERCEL", "1")
    assert client.get("/gate").status_code == 403
    monkeypatch.delenv("VERCEL")
    settings.documents_local_mode = False
    assert client.get("/gate").status_code == 401


@pytest.mark.parametrize("key", ["sb_publishable_test-only"])
def test_public_mode_sends_user_jwt_as_bearer_without_replacing_it_with_server_key(monkeypatch, key):
    import httpx
    from fastapi.security import HTTPAuthorizationCredentials

    actor = str(uuid4())
    settings = Settings(_env_file=None, documents_enabled=True, supabase_url="https://example.invalid", supabase_publishable_key=key)
    monkeypatch.setattr("BackEnd.documents.auth.get_settings", lambda: settings)

    def user_request(url, **kwargs):
        assert kwargs["headers"] == {"apikey": key, "Authorization": "Bearer test-user-session"}
        return httpx.Response(200, request=httpx.Request("GET", url), json={"id": actor, "is_anonymous": False})

    class Store:
        def is_admin(self, user):
            return user == actor

    monkeypatch.setattr(httpx, "get", user_request)
    monkeypatch.setattr("BackEnd.documents.store.get_document_store", lambda: Store())
    assert require_document_admin(None, HTTPAuthorizationCredentials(scheme="Bearer", credentials="test-user-session")) == actor


def test_program_lookup_is_available_before_document_id_routes(monkeypatch):
    settings = Settings(_env_file=None, documents_enabled=True)
    monkeypatch.setattr("BackEnd.documents.api.get_settings", lambda: settings)

    class Store:
        def programs(self, test_only, offset, limit):
            assert test_only is True and offset == 0 and limit == 50
            return {"items":[{"program_id":1,"service_id":"TEST_MOCK_LIVING","test_only":True}],"next_offset":None}

    app.dependency_overrides[require_document_admin] = lambda: None
    app.dependency_overrides[get_document_store] = lambda: Store()
    try:
        response = TestClient(app).get("/api/v1/admin/documents/programs?test_only=true")
        assert response.status_code == 200
        assert response.json()["items"][0]["service_id"] == "TEST_MOCK_LIVING"
    finally:
        app.dependency_overrides.clear()


def test_unpublished_document_cannot_launch_scoped_models(monkeypatch):
    from BackEnd.documents.api import scoped_repository

    monkeypatch.setattr("BackEnd.documents.api.get_settings", lambda: Settings(_env_file=None))

    class Store:
        def status(self, _):
            return {"active_job_id":None}, []

    with pytest.raises(DocumentError, match="document_not_published"):
        scoped_repository(Store(), str(uuid4()))


def test_table_mapping_uses_original_cells_instead_of_html_annotation():
    from BackEnd.documents.analysis import attach_markdown_ranges
    from BackEnd.ingest.official import plain_text

    markdown = "| 항목 | 수량 |\n| --- | --- |\n| 가상 카드 | 7장 |\n"
    cells = [{"text":text,"start_row_offset_idx":r,"start_col_offset_idx":c}
             for r,row in enumerate((("항목","수량"),("가상 카드","7장"))) for c,text in enumerate(row)]
    block = {"id":"table-0","label":"table","table":{"table_cells":cells},
             "text":plain_text("<table><tr><th>항목</th><th>수량</th></tr><tr><td>가상 카드</td><td>7장</td></tr></table>")}
    assert "표 시작" in block["text"] and "열1" in block["text"]
    blockers = []
    attach_markdown_ranges([block],markdown,blockers)
    assert blockers == []
    assert block["markdown_text"] == markdown.rstrip("\n")
    assert markdown[block["char_start"]:block["char_end"]] == block["markdown_text"]


def test_missing_table_is_blocked_instead_of_pointing_to_similar_prose():
    from BackEnd.documents.analysis import attach_markdown_ranges

    block = {"id":"table-0","label":"table","text":"가상 카드 7장",
             "table":{"table_cells":[{"text":"가상 카드 7장","start_row_offset_idx":0,"start_col_offset_idx":0}]}}
    blockers = []
    attach_markdown_ranges([block],"가상 카드 7장",blockers)
    assert blockers == ["markdown_table_range_missing"] and "char_start" not in block


def test_markdown_range_keeps_numeric_signs_and_units():
    from BackEnd.documents.analysis import attach_markdown_ranges

    source = "# 가상 조건\n- 기준값 -1.5 이상이면 적용.\n"
    block = {"id":"text-0","label":"text","text":"기준값 -1.5 이상이면 적용."}
    blockers = []
    attach_markdown_ranges([block],source,blockers)
    assert blockers == [] and "-1.5" in block["markdown_text"]
    assert source[block["char_start"]:block["char_end"]] == block["markdown_text"]


def test_legacy_status_preserves_analysis_without_enabling_manual_approval(monkeypatch):
    from BackEnd.documents.contracts import PARSER_VERSION

    did,jid = str(uuid4()),str(uuid4())
    analysis={"blocks":[{"id":k,"text":"가상 원문","markdown_text":"가상 원문"} for k in review()["sections"]],
              "blockers":[],"warnings":[],"pages":[],"markdown":"가상 원문"}
    job={"job_id":jid,"state":"awaiting_review","attempts":1,"error_code":None,
         "created_at":"2026-10-27T00:00:00+00:00","finished_at":None,"reviewed_at":None,
         "parser_version":PARSER_VERSION,"embedding_model":None,"embedding_digest":None}

    class Store:
        def status(self,_):
            return {"document_id":did,"program_id":1,"document_name":"가상 원문","service_id":"TEST_DOCUMENT",
                    "source_url":"https://example.invalid/document","source_organization":"목업 기관",
                    "basis_year":2026,"source_updated_at":None,"active_job_id":None,
                    "test_only":True,"program_test_only":True,"local_ingestion":True},[job]

        def policy(self,_):
            return {"hash":"","years":[]}

        def analysis_result(self,_):
            return {**job,"analysis":analysis,"analysis_hash":stable_hash(analysis)}

    monkeypatch.setattr("BackEnd.documents.api.get_settings",lambda:Settings(_env_file=None,documents_enabled=True))
    app.dependency_overrides[require_document_admin]=lambda:None
    app.dependency_overrides[get_document_store]=lambda:Store()
    try:
        response=TestClient(app).get(f"/api/v1/admin/documents/{did}")
        assert response.status_code==200
        result=response.json()
        assert "review_template" not in result["analysis"]
        assert result["analysis"]["human_review_required"] is False
        assert result["analysis"]["processing_mode"] == "manual"
        assert "다시 업로드" in result["analysis"]["instruction"]
        assert result["jobs"][0]["state"] == "awaiting_review"
        assert result["jobs"][0]["reviewed_at"] is None
    finally:
        app.dependency_overrides.clear()


def test_processing_readiness_is_not_shadowed_by_document_uuid_routes():
    class Store:
        def automatic_ready(self):
            return False

    app.dependency_overrides[require_document_admin] = lambda: None
    app.dependency_overrides[get_document_store] = lambda: Store()
    try:
        response = TestClient(app).get("/api/v1/admin/documents/processing")
        assert response.status_code == 200
        assert response.json() == {"mode":"automatic", "ready":False, "human_review_required":False}
    finally:
        app.dependency_overrides.clear()


def test_old_schema_rejects_upload_with_actionable_code(monkeypatch):
    class Store:
        def register(self, *args, **kwargs):
            raise DocumentError("automatic_processing_schema_required")

    monkeypatch.setattr("BackEnd.documents.api.get_settings", lambda: Settings(_env_file=None, documents_enabled=True))
    app.dependency_overrides[require_document_admin] = lambda: None
    app.dependency_overrides[get_document_store] = lambda: Store()
    try:
        response = TestClient(app).post("/api/v1/admin/documents", files={"file":("sample.md",b"source","text/markdown")},
                                       data={"metadata":metadata(basis_year=None).model_dump_json()})
        assert response.status_code == 503
        assert response.json()["detail"] == "automatic_processing_schema_required"
    finally:
        app.dependency_overrides.clear()
