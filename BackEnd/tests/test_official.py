"""실제 지원 조건을 나타내지 않는 테스트 XML로 공식 상세 수집 계약을 검증한다."""

import pytest

from BackEnd.core.settings import Settings
from BackEnd.ingest.official import OfficialDataError, fetch_detail, parse_detail
from BackEnd.rag.evidence import read_chunk
from BackEnd.tests.test_chat import PENSION

XML = f"""<wantedDtl><resultCode>0</resultCode><servId>{PENSION.service_id}</servId>
<crtrYr>2026</crtrYr><tgtrDtlCn>테스트 대상입니다.</tgtrDtlCn>
<slctCritCn>테스트 소득 조건입니다. 다만 예외가 있습니다.</slctCritCn>
<alwServCn>테스트 급여 10만원입니다.</alwServCn>
<applmetList><servSeDetailNm>관할 기관 방문입니다.</servSeDetailNm></applmetList></wantedDtl>""".encode()


def test_official_sections_keep_conditions_and_distinct_date_metadata():
    chunks = parse_detail(XML, PENSION, "2026-10-24T00:00:00+00:00")
    assert {chunk.section for chunk in chunks} == {"target", "criteria", "benefit", "application"}
    benefit = next(chunk for chunk in chunks if chunk.section == "benefit")
    assert "다만 예외" in benefit.conditions
    assert benefit.basis_year == "2026" and benefit.source_updated_at == ""
    assert benefit.official
    restored = read_chunk(benefit.chunk_id, benefit.service_id, benefit.storage(), PENSION.url)
    assert restored == benefit


def test_csv_overview_never_becomes_official_detail():
    chunk = read_chunk("overview", PENSION.service_id, PENSION.summary, PENSION.url, "2025-03-25")
    assert chunk.source_kind == "csv_summary" and not chunk.official


@pytest.mark.parametrize("payload", [b"not xml", b"<!DOCTYPE x><wantedDtl/>", b"<wantedDtl><resultCode>22</resultCode></wantedDtl>"])
def test_invalid_or_failed_official_response_is_not_ingested(payload):
    with pytest.raises(OfficialDataError):
        parse_detail(payload, PENSION, "2026-10-24T00:00:00+00:00")


def test_source_id_mismatch_is_rejected():
    with pytest.raises(OfficialDataError):
        parse_detail(XML.replace(PENSION.service_id.encode(), b"WLF99999999"), PENSION, "2026-10-24T00:00:00+00:00")


def test_missing_api_key_does_not_call_network(monkeypatch):
    monkeypatch.setattr("httpx.get", lambda *a, **kw: pytest.fail("인증키 없이 요청했습니다."))
    with pytest.raises(OfficialDataError):
        fetch_detail(Settings(_env_file=None, bokjiro_service_key=None), PENSION)
