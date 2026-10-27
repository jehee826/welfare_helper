import pytest

from BackEnd.ingest import run
from BackEnd.ingest.csv_loader import CsvFormatError


def test_dry_run_counts_metadata_without_a_model_or_database(capsys, monkeypatch):
    monkeypatch.setattr(run, "load_csv", lambda *args, **kwargs: [object(),object()])
    assert run.main(["--dry-run"]) == 0
    assert "2건" in capsys.readouterr().out


@pytest.mark.parametrize("arguments", [[], ["--prune"], ["--allow-shared-write"], ["--check-embeddings"],
                                       ["--dry-run","--prune"]])
def test_removed_write_modes_are_rejected_before_reading_input(monkeypatch, arguments):
    monkeypatch.setattr(run, "load_csv", lambda *a, **kw: pytest.fail("차단한 쓰기 경로가 입력을 읽었습니다."))
    assert run.main(arguments) == 1


def test_invalid_csv_cannot_look_like_a_completed_import(monkeypatch,capsys):
    def fail(*args,**kwargs):
        raise CsvFormatError("필수 컬럼이 없습니다.")

    monkeypatch.setattr(run,"load_csv",fail)
    assert run.main(["--dry-run"]) == 1
    assert "확인 실패" in capsys.readouterr().err
