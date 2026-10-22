from BackEnd.ingest import run


def test_dry_run_validates_real_csv_without_models_or_database(monkeypatch, capsys):
    def unexpected(*args, **kwargs):
        raise AssertionError("dry-run에서 외부 서비스를 호출했습니다.")

    monkeypatch.setattr(run, "get_settings", unexpected)
    monkeypatch.setattr(run, "connect", unexpected)
    assert run.main(["--dry-run"]) == 0
    assert "367건" in capsys.readouterr().out


def test_unchanged_chunks_do_not_call_embedding_and_metadata_is_still_synced(monkeypatch):
    from BackEnd.core.settings import Settings
    from BackEnd.ingest.csv_loader import chunk_text, load_csv

    records = load_csv()
    calls = {}

    class Repo:
        def __init__(self, *args, **kwargs):
            pass

        def init_schema(self):
            pass

        def indexed_chunks(self):
            return {r.service_id: (chunk_text(r), "bge-m3") for r in records}

        def sync_snapshot(self, received, chunks, *, prune):
            calls.update(records=received, chunks=chunks, prune=prune)
            return {"upserted": len(received), "embedded": len(chunks), "removed": 0, "total": len(received)}

    def unexpected(*args, **kwargs):
        raise AssertionError("변경 없는 청크를 재임베딩했습니다.")

    monkeypatch.setattr(run, "get_settings", lambda: Settings(_env_file=None))
    monkeypatch.setattr(run, "PgServiceRepository", Repo)
    monkeypatch.setattr(run.OllamaClient, "embed", unexpected)
    assert run.main([]) == 0
    assert len(calls["records"]) == 367
    assert calls["chunks"] == {}
    assert calls["prune"] is False
