from contextlib import contextmanager
from datetime import datetime, timezone

import pytest

from BackEnd.admin.program_store import ProgramError, ProgramStore


UPDATED = datetime(2026, 10, 28, tzinfo=timezone.utc)


class RecordingCursor:
    def __init__(self, *, documents, test_only=False):
        self.documents = documents
        self.current = {
            "program_name": "등록된 제도", "external_service_id": "WLF123", "test_only": test_only,
            "updated_at": UPDATED,
        }
        self.calls = []
        self.row = None

    def execute(self, sql, params):
        self.calls.append((sql, params))
        if sql.startswith("SELECT p.program_id"):
            self.row = {"program_id": 7, **self.current}
        elif "FROM public.welfare_programs WHERE" in sql:
            self.row = self.current
        elif "FROM public.rag_documents" in sql:
            self.row = {"exists": 1} if self.documents else None
        else:
            self.row = None

    def fetchone(self):
        return self.row


class IsolatedProgramStore(ProgramStore):
    def __init__(self, cursor):
        super().__init__(None)
        self.recording = cursor

    @contextmanager
    def cursor(self):
        yield self.recording


@pytest.mark.parametrize("before,after", [(False, True), (True, False)])
def test_connected_document_blocks_test_only_change_without_document_row_lock(before, after):
    cursor = RecordingCursor(documents=True, test_only=before)
    with pytest.raises(ProgramError, match="^program_has_documents$"):
        IsolatedProgramStore(cursor).update(7, {"test_only": after}, UPDATED)
    statements = [sql for sql, _ in cursor.calls]
    assert statements[0].endswith("FOR UPDATE")
    assert "public.welfare_programs" in statements[0]
    assert "public.rag_documents" in statements[1]
    assert "FOR SHARE" not in statements[1] and "FOR UPDATE" not in statements[1]
    assert not any(sql.startswith("UPDATE") for sql in statements)


def test_same_test_only_value_remains_allowed_with_documents():
    cursor = RecordingCursor(documents=True)
    result = IsolatedProgramStore(cursor).update(7, {"test_only": False, "summary": "새 요약"}, UPDATED)
    assert result["program_id"] == 7
    assert not any(sql.startswith("SELECT 1 FROM public.rag_documents") for sql, _ in cursor.calls)
    assert cursor.calls[1][0].startswith("UPDATE public.welfare_programs")
    assert cursor.calls[1][1]["summary"] == "새 요약"


def test_program_without_documents_can_change_test_only():
    cursor = RecordingCursor(documents=False)
    IsolatedProgramStore(cursor).update(7, {"test_only": True}, UPDATED)
    assert "FOR UPDATE" in cursor.calls[0][0]
    assert "FROM public.rag_documents" in cursor.calls[1][0]
    assert "FOR SHARE" not in cursor.calls[1][0]
    assert cursor.calls[2][0].startswith("UPDATE public.welfare_programs")
    assert cursor.calls[2][1]["test_only"] is True


@pytest.mark.parametrize("documents", [False, True])
def test_delete_serializes_with_registration_without_locking_documents(documents):
    cursor = RecordingCursor(documents=documents)
    store = IsolatedProgramStore(cursor)
    if documents:
        with pytest.raises(ProgramError, match="^program_has_documents$"):
            store.delete(7)
    else:
        store.delete(7)
    assert cursor.calls[0][0].endswith("FOR UPDATE")
    assert "public.welfare_programs" in cursor.calls[0][0]
    assert "FROM public.rag_documents" in cursor.calls[1][0]
    assert "FOR SHARE" not in cursor.calls[1][0] and "FOR UPDATE" not in cursor.calls[1][0]
    assert any(sql.startswith("DELETE") for sql, _ in cursor.calls) is not documents
