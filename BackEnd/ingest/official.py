"""공식 중앙부처복지서비스 상세조회 XML을 제한된 명시적 요청으로 수집한다."""

import re
import unicodedata
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree

import httpx

from BackEnd.core.settings import Settings
from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.evidence import EvidenceChunk

SECTION_FIELDS = {"target": "tgtrDtlCn", "criteria": "slctCritCn", "benefit": "alwServCn"}


class OfficialDataError(RuntimeError):
    """설정·권한·쿼터·원문 형식을 확인하지 못했을 때 발생한다."""


class _StructureText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip = 0
        self.table = False
        self.row = []
        self.cell = None
        self.headers = []
        self.cell_header = False
        self.spans = ""
        self.complex_table = False

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.skip += 1
        if self.skip:
            return
        if tag == "table":
            if self.table:
                raise OfficialDataError("중첩 표는 원문 구조를 별도로 확인해야 합니다.")
            self.table, self.headers = True, []
            self.complex_table = False
            self.parts.append("\n[표 시작]\n")
        elif tag == "tr":
            if self.row or self.cell is not None:
                raise OfficialDataError("닫히지 않은 표 행은 반영하지 않습니다.")
            self.row = []
        elif tag in {"td", "th"}:
            if self.cell is not None:
                raise OfficialDataError("닫히지 않은 표 셀은 반영하지 않습니다.")
            self.cell, self.cell_header = [], tag == "th"
            self.spans = " ".join(f"{k}={v}" for k, v in attrs if k in {"rowspan", "colspan"} and v != "1")
            self.complex_table = self.complex_table or bool(self.spans)
        elif tag in {"br", "p", "li", "div", "caption"}:
            (self.cell if self.cell is not None else self.parts).append("\n")
        elif re.fullmatch(r"h[1-6]", tag):
            (self.cell if self.cell is not None else self.parts).append(f"\n[제목{tag[1]}] ")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag in {"td", "th"} and self.cell is not None:
            value = " ".join("".join(self.cell).split())
            self.row.append((value, self.cell_header, self.spans))
            self.cell = None
        elif tag == "tr" and self.row:
            if all(header and not spans for _, header, spans in self.row):
                self.headers = [value for value, _, _ in self.row]
            simple = not self.complex_table and len(self.headers) == len(self.row)
            values = [f"{self.headers[i]}: {v}" if simple and not h else f"열{i + 1}: {v} {s}".strip()
                      for i, (v, h, s) in enumerate(self.row)]
            self.parts.append(" | ".join(values) + "\n")
            self.row = []
        elif tag == "table":
            self.table = False
            self.parts.append("[표 끝]\n")
        elif tag in {"p", "li", "div", "caption"} or re.fullmatch(r"h[1-6]", tag):
            (self.cell if self.cell is not None else self.parts).append("\n")

    def handle_data(self, data):
        if not self.skip:
            (self.cell if self.cell is not None else self.parts).append(data)


def plain_text(value: str) -> str:
    parser = _StructureText()
    parser.feed(unescape(value))
    parser.close()
    if parser.table or parser.cell is not None or parser.row:
        raise OfficialDataError("닫히지 않은 표는 반영하지 않습니다.")
    value = unicodedata.normalize("NFC", "".join(parser.parts))
    return "\n".join(re.sub(r"[^\S\n]+", " ", line).strip()
                     for line in value.splitlines() if line.strip())


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
    if not re.fullmatch(r"(?:19|20)\d{2}", year):
        raise OfficialDataError("자료 기준연도를 확인하지 못했습니다.")
    try:
        if datetime.fromisoformat(collected_at).tzinfo is None:
            raise ValueError
    except ValueError:
        raise OfficialDataError("수집 시각의 시간대가 필요합니다.") from None
    sections = {section: plain_text(node.findtext(field, "")) for section, field in SECTION_FIELDS.items()}
    methods = []
    for item in node.findall("applmetList"):
        name = plain_text(item.findtext("servSeDetailNm", ""))
        procedure = plain_text(item.findtext("servSeDetailLink", ""))
        methods.append("\n".join(value for value in (name, procedure) if value))
    sections["application"] = "\n".join(text for text in methods if text)
    if any(not text.strip() for text in sections.values()):
        raise OfficialDataError("필수 상세 섹션이 누락되어 기존 활성본을 유지합니다.")
    conditions = "\n".join(sections[section] for section in ("target", "criteria") if sections[section])
    chunks = [EvidenceChunk(
        chunk_id=f"{record.service_id}:official:{section}", service_id=record.service_id,
        section=section, text=text, source_url=record.url, basis_year=year,
        collected_at=collected_at, source_kind="official_detail",
        conditions=conditions if section in ("benefit", "application") else "",
    ) for section, text in sections.items() if text]
    if any(not chunk.official for chunk in chunks):
        raise OfficialDataError("공식 출처·서비스 ID·자료 기준을 검증하지 못했습니다.")
    return chunks


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
