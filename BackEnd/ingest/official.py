"""공식 중앙부처복지서비스 상세조회 XML을 제한된 명시적 요청으로 수집한다."""

import re
from datetime import datetime, timezone
from html import unescape
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree

import httpx

from BackEnd.core.settings import Settings
from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.evidence import EvidenceChunk

SECTION_FIELDS = {"target": "tgtrDtlCn", "criteria": "slctCritCn", "benefit": "alwServCn"}


class OfficialDataError(RuntimeError):
    """설정·권한·쿼터·원문 형식을 확인하지 못했을 때 발생한다."""


def plain_text(value: str) -> str:
    value = unescape(value)
    value = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", "", value, flags=re.I | re.S)
    value = re.sub(r"<\s*(?:br\b[^>]*|/p|/li|/div)\s*/?>", "\n", value, flags=re.I)
    value = re.sub(r"<[^>]*>", "", value)
    return "\n".join(re.sub(r"[ \t\r]+", " ", line).strip()
                     for line in value.splitlines() if line.strip()).strip()


def parse_detail(xml: bytes, record: ServiceRecord, collected_at: str) -> list[EvidenceChunk]:
    if len(xml) > 1_000_000 or b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
        raise OfficialDataError("공식 상세 응답의 크기 또는 XML 형식이 허용 범위를 벗어났습니다.")
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        raise OfficialDataError("공식 상세 응답을 해석하지 못했습니다.") from None
    node = root if root.tag == "wantedDtl" else root.find(".//wantedDtl")
    if node is None or node.findtext("resultCode", "") not in ("0", "00"):
        raise OfficialDataError("공식 API의 권한·쿼터 또는 서비스 응답을 확인해 주세요.")
    if node.findtext("servId") != record.service_id:
        raise OfficialDataError("공식 응답의 서비스 ID가 요청과 다릅니다.")
    year = node.findtext("crtrYr", "").strip()
    sections = {section: plain_text(node.findtext(field, "")) for section, field in SECTION_FIELDS.items()}
    methods = []
    for item in node.findall("applmetList"):
        name = plain_text(item.findtext("servSeDetailNm", ""))
        procedure = plain_text(item.findtext("servSeDetailLink", ""))
        methods.append("\n".join(value for value in (name, procedure) if value))
    sections["application"] = "\n".join(text for text in methods if text)
    conditions = "\n".join(sections[section] for section in ("target", "criteria") if sections[section])
    return [EvidenceChunk(
        chunk_id=f"{record.service_id}:official:{section}", service_id=record.service_id,
        section=section, text=text, source_url=record.url, basis_year=year,
        collected_at=collected_at, source_kind="official_detail",
        conditions=conditions if section in ("benefit", "application") else "",
    ) for section, text in sections.items() if text]


def fetch_detail(settings: Settings, record: ServiceRecord) -> list[EvidenceChunk]:
    key = settings.bokjiro_service_key.get_secret_value() if settings.bokjiro_service_key else ""
    url = urlparse(settings.bokjiro_detail_url)
    if not key:
        raise OfficialDataError("BOKJIRO_SERVICE_KEY를 런타임에 주입해 주세요.")
    if url.scheme != "https" or url.hostname != "apis.data.go.kr":
        raise OfficialDataError("공식 HTTPS API 주소만 사용할 수 있습니다.")
    if not re.fullmatch(r"WLF\d{8}", record.service_id):
        raise OfficialDataError("공식 서비스 ID 형식이 아닙니다.")
    try:
        response = httpx.get(settings.bokjiro_detail_url, params={
            "serviceKey": unquote(key), "callTp": "D", "servId": record.service_id,
        }, timeout=settings.bokjiro_timeout, follow_redirects=False)
        response.raise_for_status()
    except httpx.HTTPError:
        # 요청 URL에는 인증키가 있으므로 원래 예외와 응답 본문을 출력하지 않는다.
        raise OfficialDataError("공식 API 연결·권한·쿼터를 확인하지 못했습니다.") from None
    return parse_detail(response.content, record, datetime.now(timezone.utc).isoformat())
