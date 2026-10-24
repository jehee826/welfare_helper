import pytest

from BackEnd.core.settings import Settings
from BackEnd import startup
from BackEnd.ingest import run


def test_shared_startup_never_ingests_or_changes_schema(monkeypatch):
    settings = Settings(_env_file=None, database_url="postgresql://placeholder.invalid/db")
    monkeypatch.setattr(startup, "get_settings", lambda: settings)
    monkeypatch.setattr(startup, "ingest", lambda *a: pytest.fail("공용 DB 시작 시 적재했습니다."))
    monkeypatch.setattr(startup, "connect", lambda *a: pytest.fail("시작 처리에서 공용 DB를 변경했습니다."))
    assert startup.prepare() == 0


def test_supabase_mode_without_connection_does_not_fall_back_to_local(monkeypatch):
    settings = Settings(_env_file=None, database_url=None, database_mode="supabase")
    monkeypatch.setattr(startup, "get_settings", lambda: settings)
    assert startup.prepare() == 1


def test_shared_csv_ingest_requires_explicit_write_before_database_access(monkeypatch):
    settings = Settings(_env_file=None, database_url="postgresql://placeholder.invalid/db")
    monkeypatch.setattr(run, "get_settings", lambda: settings)
    monkeypatch.setattr(run, "PgServiceRepository", lambda *a, **kw: pytest.fail("승인 없이 DB에 접근했습니다."))
    assert run.main([]) == 1


def test_local_initial_ingest_convenience_is_preserved(monkeypatch):
    from unittest.mock import MagicMock

    monkeypatch.setattr(startup, "get_settings", lambda: Settings(_env_file=None, database_url=None, database_mode="local"))
    connection = MagicMock()
    calls = []
    monkeypatch.setattr(startup, "connect", lambda settings: connection)
    monkeypatch.setattr(startup, "ingest", lambda args: calls.append(args) or 0)
    assert startup.prepare() == 0 and calls == [[]]
    connection.close.assert_called_once()
