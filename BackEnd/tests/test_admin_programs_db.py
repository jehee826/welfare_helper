"""로컬 PostgreSQL에서 제도 관리 저장소와 채팅 반영을 확인한다.

WELFARE_TEST_DATABASE_URL에 버려도 되는 로컬 DB 주소를 넣을 때만 실행한다. public 스키마를 지우고 다시 만든다.
"""

import os
from pathlib import Path
from urllib.parse import urlsplit

import psycopg2
import pytest

from BackEnd.admin.program_store import ProgramError, ProgramStore
from BackEnd.rag.chat import ChatService
from BackEnd.rag.repository import PgServiceRepository

DATABASE_URL = os.environ.get("WELFARE_TEST_DATABASE_URL", "")
SCHEMA = Path(__file__).parent / "fixtures" / "admin_programs_schema.sql"

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="WELFARE_TEST_DATABASE_URL이 없으면 DB 통합 테스트를 건너뛴다.")


def connect():
    return psycopg2.connect(DATABASE_URL)


@pytest.fixture
def store():
    assert urlsplit(DATABASE_URL).hostname in {"localhost", "127.0.0.1"}, "로컬 테스트 DB에서만 실행한다."
    with connect() as conn, conn.cursor() as cur:
        cur.execute(SCHEMA.read_text(encoding="utf-8"))
        cur.execute("INSERT INTO public.departments (department_name, ministry_name) VALUES "
                    "('기초연금과', '보건복지부'), ('복지정책과', '행복복지관')")
    conn.close()
    return ProgramStore(connect)


def department_ids(store):
    return {d["department_name"]: d["department_id"] for d in store.departments()}


def new_program(store, **values):
    data = {"program_name": "행복 반찬나눔", "summary": "홀로 사는 어르신께 반찬을 전달합니다.",
            "department_id": department_ids(store)["복지정책과"], "external_service_id": None,
            "source_url": None, "source_updated_at": None,
            "contacts": [{"label": "행복복지관", "phone": "02-123-4567"}], "test_only": False}
    return store.create(data | values)


def attach_document(program_id):
    with connect() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO public.rag_documents (program_id, document_name, source_url, source_organization) "
                    "VALUES (%s, '반찬나눔 안내문', 'https://example.invalid/doc', '행복복지관')", (program_id,))
    conn.close()


def test_created_program_gets_internal_service_id_and_counts(store):
    created = new_program(store)
    assert created["service_id"] == f"PROGRAM_{created['program_id']}"
    assert created["department_name"] == "복지정책과" and created["ministry_name"] == "행복복지관"
    assert created["document_count"] == 0 and created["published_count"] == 0
    assert created["contacts"] == [{"label": "행복복지관", "phone": "02-123-4567"}]


def test_duplicate_external_id_and_unknown_department_are_reported(store):
    new_program(store, external_service_id="WLF00009999")
    with pytest.raises(ProgramError, match="duplicate_service_id"):
        new_program(store, program_name="다른 제도", external_service_id="WLF00009999")
    with pytest.raises(ProgramError, match="department_not_found"):
        new_program(store, department_id=999999)


def test_list_filters_by_name_department_or_id_and_escapes_wildcards(store):
    new_program(store)
    new_program(store, program_name="기초연금", external_service_id="WLF00001", department_id=department_ids(store)["기초연금과"])
    assert [p["program_name"] for p in store.search("연금", 0, 50)["items"]] == ["기초연금"]
    assert [p["program_name"] for p in store.search("복지정책", 0, 50)["items"]] == ["행복 반찬나눔"]
    assert [p["program_name"] for p in store.search("wlf00001", 0, 50)["items"]] == ["기초연금"]
    assert store.search("%", 0, 50)["items"] == []
    page = store.search("", 0, 1)
    assert len(page["items"]) == 1 and page["next_offset"] == 1


def test_update_changes_fields_and_rejects_stale_version(store):
    created = new_program(store)
    updated = store.update(created["program_id"], {"summary": "주 2회 반찬을 전달합니다."}, created["updated_at"])
    assert updated["summary"] == "주 2회 반찬을 전달합니다."
    assert updated["updated_at"] > created["updated_at"]
    with pytest.raises(ProgramError, match="program_changed"):
        store.update(created["program_id"], {"summary": "늦게 저장한 요약"}, created["updated_at"])
    with pytest.raises(ProgramError, match="program_not_found"):
        store.update(999999, {"summary": "없음"}, created["updated_at"])


def test_name_and_service_id_are_locked_once_a_document_exists(store):
    created = new_program(store)
    attach_document(created["program_id"])
    with pytest.raises(ProgramError, match="program_has_documents"):
        store.update(created["program_id"], {"program_name": "새 이름"}, created["updated_at"])
    with pytest.raises(ProgramError, match="program_has_documents"):
        store.update(created["program_id"], {"external_service_id": "WLF00000077"}, created["updated_at"])
    unchanged_name = store.update(created["program_id"], {"program_name": created["program_name"], "summary": "요약만 수정"},
                                  created["updated_at"])
    assert unchanged_name["summary"] == "요약만 수정" and unchanged_name["document_count"] == 1


def test_test_service_id_cannot_become_a_public_program(store):
    created = new_program(store, external_service_id="TEST_SIDE_DISH", test_only=True)
    with pytest.raises(ProgramError, match="test_service_requires_test_only"):
        store.update(created["program_id"], {"test_only": False}, created["updated_at"])


def test_delete_is_blocked_while_documents_exist(store):
    kept = new_program(store)
    attach_document(kept["program_id"])
    with pytest.raises(ProgramError, match="program_has_documents"):
        store.delete(kept["program_id"])
    removed = new_program(store, program_name="삭제할 제도")
    store.delete(removed["program_id"])
    assert [p["program_name"] for p in store.search("", 0, 50)["items"]] == ["행복 반찬나눔"]
    with pytest.raises(ProgramError, match="program_not_found"):
        store.delete(removed["program_id"])


def test_admin_edit_is_reflected_in_the_next_chat_answer(store):
    created = new_program(store)
    chat = ChatService(PgServiceRepository(connect), llm=None, min_similarity=0.52, top_n=40)
    before = chat.answer("행복 반찬나눔 문의처", None)
    assert before["services"][0]["summary"] == "홀로 사는 어르신께 반찬을 전달합니다."

    store.update(created["program_id"], {"summary": "주 2회 반찬을 전달합니다.",
                                         "contacts": [{"label": "행복복지관 상담실", "phone": "02-555-0000"}]},
                 created["updated_at"])
    after = chat.answer("행복 반찬나눔 문의처", None)
    assert after["services"][0]["summary"] == "주 2회 반찬을 전달합니다."
    assert "02-555-0000" in after["text"]


def test_test_only_program_is_hidden_from_public_chat(store):
    new_program(store, program_name="가상 반찬나눔", external_service_id="TEST_SIDE_DISH", test_only=True)
    chat = ChatService(PgServiceRepository(connect), llm=None, min_similarity=0.52, top_n=40)
    assert chat.answer("가상 반찬나눔 문의처", None)["kind"] == "fallback"
