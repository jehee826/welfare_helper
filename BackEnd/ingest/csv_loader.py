import csv
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from BackEnd.rag.text import clean_text, parse_contacts

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CSV = REPO_ROOT / "docs" / "한국사회보장정보원_복지서비스정보_20250722.csv"
COLUMNS = ["서비스아이디", "서비스명", "서비스URL", "서비스요약", "사이트", "대표문의", "소관부처명", "소관조직명", "기준연도", "최종수정일"]
REQUIRED = ["서비스아이디", "서비스명", "서비스URL", "서비스요약", "소관부처명"]


class CsvFormatError(ValueError):
    """CSV 헤더나 값이 기대한 형식과 다를 때 발생한다."""


@dataclass(frozen=True)
class ServiceRecord:
    service_id: str
    name: str
    summary: str
    ministry: str
    department: str
    url: str
    contacts: list[dict[str, str]] = field(default_factory=list)
    updated_at: str = ""


def _row_to_record(row: dict[str, str], line: int) -> ServiceRecord:
    values = {col: clean_text(row.get(col)) for col in COLUMNS}
    missing = [col for col in REQUIRED if not values[col]]
    if missing:
        raise CsvFormatError(f"{line}행: 필수 값 없음 {missing}")
    service_id = values["서비스아이디"]
    url_id = parse_qs(urlparse(values["서비스URL"]).query).get("wlfareInfoId", [None])[0]
    if url_id != service_id:
        raise CsvFormatError(f"{line}행: 서비스URL의 ID({url_id})가 서비스아이디({service_id})와 다름")
    updated_at = values["최종수정일"] or ""
    if updated_at:
        try:
            date.fromisoformat(updated_at)
        except ValueError as exc:
            raise CsvFormatError(f"{line}행: 최종수정일 형식 오류 {updated_at}") from exc
    return ServiceRecord(
        service_id=service_id,
        name=values["서비스명"],
        summary=values["서비스요약"],
        ministry=values["소관부처명"],
        department=values["소관조직명"] or "",
        url=values["서비스URL"],
        contacts=parse_contacts(row.get("대표문의")),
        updated_at=updated_at,
    )


def load_csv(path: Path | str = DEFAULT_CSV, encoding: str = "cp949") -> list[ServiceRecord]:
    """복지로 중앙부처 복지서비스 CSV를 읽어 정제·검증된 레코드 목록을 돌려준다."""
    with open(path, encoding=encoding, newline="") as file:
        reader = csv.DictReader(file)
        header = [h.strip() for h in reader.fieldnames or []]
        absent = [col for col in COLUMNS if col not in header]
        if absent:
            raise CsvFormatError(f"헤더에 없는 컬럼: {absent}")
        records = [_row_to_record(row, line) for line, row in enumerate(reader, start=2)]
    ids = [r.service_id for r in records]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise CsvFormatError(f"서비스아이디 중복: {duplicates}")
    return records


def chunk_text(record: ServiceRecord) -> str:
    """임베딩할 overview 청크. 요약이 같은 서비스도 구분되도록 서비스명을 함께 넣는다."""
    category = " > ".join(p for p in [record.ministry, record.department] if p)
    return f"서비스명: {record.name}\n분류: {category}\n요약: {record.summary}"
