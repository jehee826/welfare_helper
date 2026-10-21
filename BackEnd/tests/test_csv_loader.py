from pathlib import Path

import pytest

from BackEnd.ingest.csv_loader import DEFAULT_CSV, CsvFormatError, chunk_text, load_csv


def test_default_csv_loads_all_rows():
    records = load_csv(DEFAULT_CSV)
    assert len(records) == 367
    assert len({r.service_id for r in records}) == 367


def test_records_are_cleaned_and_parsed():
    by_id = {r.service_id: r for r in load_csv(DEFAULT_CSV)}
    pension = next(r for r in by_id.values() if r.name == "기초연금")
    assert pension.ministry == "보건복지부"
    assert pension.url.endswith(pension.service_id + "&wlfareInfoReldBztpCd=01")
    assert {"label": "보건복지상담센터", "phone": "129"} in pension.contacts
    assert "&middot;" not in by_id["WLF00000087"].summary


def test_chunk_text_includes_name_category_and_summary():
    record = next(r for r in load_csv(DEFAULT_CSV) if r.name == "기초연금")
    text = chunk_text(record)
    assert text.startswith("서비스명: 기초연금\n")
    assert "분류: 보건복지부 > " in text
    assert record.summary in text


def test_missing_column_raises(tmp_path: Path):
    bad = tmp_path / "bad.csv"
    bad.write_text("서비스아이디,서비스명\nWLF1,테스트\n", encoding="cp949")
    with pytest.raises(CsvFormatError):
        load_csv(bad)
