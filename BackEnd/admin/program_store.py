"""관리자가 수정하는 제도 메타데이터를 welfare_programs·departments에서 읽고 쓴다."""

from contextlib import closing, contextmanager

import psycopg2
from psycopg2 import errorcodes
from psycopg2.extras import Json, RealDictCursor

from BackEnd.core.db import connect
from BackEnd.core.settings import get_settings
from BackEnd.documents.store import SERVICE_ID

EDITABLE = ("program_name", "summary", "department_id", "external_service_id", "source_url",
            "source_updated_at", "contacts", "test_only")
LOCKED_BY_DOCUMENTS = ("program_name", "external_service_id", "test_only")
SELECT_PROGRAM = (
    "SELECT p.program_id, " + SERVICE_ID + " AS service_id, p.external_service_id, p.program_name, "
    "coalesce(p.summary, '') AS summary, p.department_id, d.department_name, d.ministry_name, p.contacts, "
    "p.source_url, p.source_updated_at, p.test_only, p.updated_at, "
    "(SELECT count(*) FROM public.rag_documents r WHERE r.program_id = p.program_id) AS document_count, "
    "(SELECT count(*) FROM public.rag_documents r WHERE r.program_id = p.program_id "
    "AND r.active_job_id IS NOT NULL) AS published_count "
    "FROM public.welfare_programs p JOIN public.departments d USING (department_id) "
)


class ProgramError(Exception):
    """제도 저장 규칙 위반. 인자는 API 응답에 그대로 쓰는 오류 코드다."""


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _db_error(exc: psycopg2.Error) -> ProgramError:
    if exc.pgcode == errorcodes.UNIQUE_VIOLATION:
        return ProgramError("duplicate_service_id")
    if exc.pgcode == errorcodes.FOREIGN_KEY_VIOLATION:
        return ProgramError("department_not_found")
    if exc.pgcode == errorcodes.CHECK_VIOLATION:
        return ProgramError("program_constraint_violation")
    raise exc


class ProgramStore:
    def __init__(self, connection_factory):
        self.connect = connection_factory

    @contextmanager
    def cursor(self):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur

    @staticmethod
    def _get(cur, program_id):
        cur.execute(SELECT_PROGRAM + "WHERE p.program_id = %s", (program_id,))
        return cur.fetchone()

    def search(self, query: str, offset: int, limit: int) -> dict:
        with self.cursor() as cur:
            cur.execute(
                SELECT_PROGRAM
                + "WHERE %(query)s = '' OR p.program_name ILIKE %(like)s ESCAPE '\\' "
                "OR d.department_name ILIKE %(like)s ESCAPE '\\' OR d.ministry_name ILIKE %(like)s ESCAPE '\\' "
                "OR coalesce(p.external_service_id, '') ILIKE %(like)s ESCAPE '\\' "
                "ORDER BY p.program_id LIMIT %(limit)s OFFSET %(offset)s",
                {"query": query, "like": _like(query), "limit": limit + 1, "offset": offset},
            )
            rows = cur.fetchall()
        return {"items": [dict(r) for r in rows[:limit]], "offset": offset, "limit": limit,
                "next_offset": offset + limit if len(rows) > limit else None}

    def departments(self) -> list[dict]:
        with self.cursor() as cur:
            cur.execute("SELECT department_id, department_name, ministry_name FROM public.departments "
                        "ORDER BY ministry_name, department_name")
            return [dict(r) for r in cur.fetchall()]

    def create(self, data: dict) -> dict:
        values = {key: data[key] for key in EDITABLE}
        values["contacts"] = Json(values["contacts"])
        try:
            with self.cursor() as cur:
                cur.execute(
                    "INSERT INTO public.welfare_programs (" + ", ".join(EDITABLE) + ") VALUES ("
                    + ", ".join(f"%({key})s" for key in EDITABLE) + ") RETURNING program_id",
                    values,
                )
                return dict(self._get(cur, cur.fetchone()["program_id"]))
        except psycopg2.Error as exc:
            raise _db_error(exc) from None

    def update(self, program_id: int, changes: dict, expected_updated_at) -> dict:
        try:
            with self.cursor() as cur:
                cur.execute("SELECT program_name, external_service_id, test_only, updated_at "
                            "FROM public.welfare_programs WHERE program_id = %s FOR UPDATE", (program_id,))
                current = cur.fetchone()
                if current is None:
                    raise ProgramError("program_not_found")
                if current["updated_at"] != expected_updated_at:
                    raise ProgramError("program_changed")
                changed = {key: value for key, value in changes.items() if key in EDITABLE}
                if any(key in changed and changed[key] != current[key] for key in LOCKED_BY_DOCUMENTS):
                    # 제도 잠금이 문서 등록과 직렬화한다. 문서까지 잠그면 게시의 역순 잠금과 교착한다.
                    cur.execute("SELECT 1 FROM public.rag_documents WHERE program_id = %s LIMIT 1", (program_id,))
                    if cur.fetchone():
                        raise ProgramError("program_has_documents")
                service_id = changed.get("external_service_id", current["external_service_id"]) or ""
                if service_id.startswith("TEST_") and not changed.get("test_only", current["test_only"]):
                    raise ProgramError("test_service_requires_test_only")
                if changed:
                    if "contacts" in changed:
                        changed["contacts"] = Json(changed["contacts"])
                    cur.execute(
                        "UPDATE public.welfare_programs SET " + ", ".join(f"{key} = %({key})s" for key in changed)
                        + " WHERE program_id = %(program_id)s",
                        changed | {"program_id": program_id},
                    )
                return dict(self._get(cur, program_id))
        except psycopg2.Error as exc:
            raise _db_error(exc) from None

    def delete(self, program_id: int) -> None:
        with self.cursor() as cur:
            cur.execute("SELECT 1 FROM public.welfare_programs WHERE program_id = %s FOR UPDATE", (program_id,))
            if cur.fetchone() is None:
                raise ProgramError("program_not_found")
            cur.execute("SELECT 1 FROM public.rag_documents WHERE program_id = %s LIMIT 1", (program_id,))
            if cur.fetchone():
                raise ProgramError("program_has_documents")
            try:
                cur.execute("DELETE FROM public.welfare_programs WHERE program_id = %s", (program_id,))
            except psycopg2.Error as exc:
                if exc.pgcode == errorcodes.FOREIGN_KEY_VIOLATION:
                    raise ProgramError("program_has_documents") from None
                raise


def get_program_store() -> ProgramStore:
    return ProgramStore(lambda: connect(get_settings()))
