"""기존 청크 TEXT 안에서 원문과 출처·기준일·수집일을 함께 보존한다."""

import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from urllib.parse import parse_qs, urlparse


@dataclass(frozen=True)
class EvidenceChunk:
    chunk_id: str
    service_id: str
    section: str
    text: str
    source_url: str
    source_updated_at: str = ""
    basis_year: str = ""
    collected_at: str = ""
    source_kind: str = "csv_summary"
    conditions: str = ""
    score: float = 0.0

    @property
    def official(self) -> bool:
        url = urlparse(self.source_url)
        host = url.hostname or ""
        try:
            collected = datetime.fromisoformat(self.collected_at)
        except ValueError:
            return False
        dated = bool(re.fullmatch(r"\d{4}", self.basis_year) or
                     re.fullmatch(r"\d{4}-\d{2}-\d{2}", self.source_updated_at))
        return (self.source_kind == "official_detail" and collected.tzinfo is not None and dated
                and url.scheme == "https" and parse_qs(url.query).get("wlfareInfoId") == [self.service_id]
                and (host == "bokjiro.go.kr" or host.endswith(".bokjiro.go.kr")))

    def embedding_text(self) -> str:
        return f"섹션: {self.section}\n{self.text}\n적용 조건과 예외: {self.conditions}".strip()

    def storage(self) -> str:
        values = asdict(self)
        values.pop("score")
        return json.dumps({"format": "welfare-evidence-v1", **values}, ensure_ascii=False)


def read_chunk(chunk_id: str, service_id: str, content: str, url: str,
               updated_at: str = "", score: float = 0.0) -> EvidenceChunk:
    try:
        data = json.loads(content)
    except (ValueError, TypeError):
        data = None
    if isinstance(data, dict) and data.get("format") == "welfare-evidence-v1":
        fields = {name: data.get(name, "") for name in (
            "section", "text", "source_url", "source_updated_at", "basis_year", "collected_at",
            "source_kind", "conditions",
        )}
        if (data.get("service_id") == service_id and data.get("chunk_id") == chunk_id
                and all(isinstance(value, str) for value in fields.values())):
            return EvidenceChunk(chunk_id, service_id, **fields, score=score)
        return EvidenceChunk(chunk_id, service_id, "invalid", "", url, source_kind="invalid", score=score)
    # 기존 CSV 청크를 공식 상세 원문으로 승격하지 않는다.
    return EvidenceChunk(chunk_id, service_id, "summary", content, url, updated_at, score=score)
