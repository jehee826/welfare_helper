"""기존 청크 TEXT 안에서 원문과 출처·기준일·수집일을 함께 보존한다."""

import json
import re
from dataclasses import asdict, dataclass, fields as dataclass_fields
from hashlib import sha256
from datetime import date, datetime
from urllib.parse import parse_qs, urlparse
from uuid import UUID


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
    service_name: str = ""
    version: str = ""
    source_hash: str = ""
    clean_version: str = ""
    split_version: str = ""
    embed_digest: str = ""
    parent_id: str = ""
    parent_text: str = ""
    ordinal: int = 0
    start: int = 0
    end: int = 0
    complete: bool = True
    active: bool = True
    required_parents: tuple[str, ...] = ()
    heading_context: str = ""
    document_id: str = ""
    document_name: str = ""
    analysis_hash: str = ""
    review_hash: str = ""
    reviewed_by: str = ""
    reviewed_at: str = ""
    page_refs: tuple[int, ...] = ()
    source_blocks: tuple[str, ...] = ()
    test_only: bool = False

    @property
    def official(self) -> bool:
        url = urlparse(self.source_url)
        host = url.hostname or ""
        try:
            collected = datetime.fromisoformat(self.collected_at)
        except ValueError:
            return False
        try:
            dated = bool(re.fullmatch(r"(?:19|20)\d{2}", self.basis_year))
            if self.source_updated_at:
                if date.fromisoformat(self.source_updated_at).isoformat() != self.source_updated_at:
                    return False
                dated = True
        except ValueError:
            return False
        return (self.source_kind == "official_detail" and collected.tzinfo is not None and dated
                and url.scheme == "https" and parse_qs(url.query).get("wlfareInfoId") == [self.service_id]
                and (host == "bokjiro.go.kr" or host.endswith(".bokjiro.go.kr")))

    def embedding_text(self) -> str:
        if self.version:
            heading = self.heading_context + "\n" if self.heading_context else ""
            return f"서비스명: {self.service_name}\n섹션: {self.section}\n{heading}{self.text}"
        return f"섹션: {self.section}\n{self.text}\n적용 조건과 예외: {self.conditions}".strip()

    @property
    def usable_detail(self) -> bool:
        if self.official:
            return True
        if self.source_kind != "reviewed_document":
            return False
        try:
            UUID(self.document_id)
            UUID(self.reviewed_by)
            dated = datetime.fromisoformat(self.reviewed_at).tzinfo is not None
            collected = datetime.fromisoformat(self.collected_at).tzinfo is not None
            url = urlparse(self.source_url)
            return bool(dated and collected and self.document_name and self.source_blocks
                        and re.fullmatch(r"(?:19|20)\d{2}", self.basis_year)
                        and re.fullmatch(r"[0-9a-f]{64}", self.analysis_hash)
                        and re.fullmatch(r"[0-9a-f]{64}", self.review_hash)
                        and url.scheme == "https" and url.hostname and not url.username and not url.password)
        except (ValueError, TypeError):
            return False

    def storage(self) -> str:
        values = asdict(self)
        values.pop("score")
        return json.dumps({"format": "welfare-evidence-v2" if self.version else "welfare-evidence-v1", **values}, ensure_ascii=False)


def read_chunk(chunk_id: str, service_id: str, content: str, url: str,
               updated_at: str = "", score: float = 0.0) -> EvidenceChunk:
    try:
        data = json.loads(content)
    except (ValueError, TypeError):
        data = None
    if isinstance(data, dict) and data.get("format") == "welfare-evidence-v2":
        try:
            if not isinstance(data.get("required_parents"), list):
                raise ValueError("필수 연결 형식 오류")
            names = {field.name for field in dataclass_fields(EvidenceChunk)} - {"score"}
            values = {key: value for key, value in data.items() if key in names}
            values["required_parents"] = tuple(values.get("required_parents", ()))
            for key in ("page_refs", "source_blocks"):
                if not isinstance(values.get(key, []), (list, tuple)):
                    raise ValueError("문서 출처 연결 형식 오류")
                values[key] = tuple(values.get(key, ()))
            chunk = EvidenceChunk(**values, score=score)
            strings = names - {"ordinal", "start", "end", "complete", "active", "required_parents", "page_refs", "source_blocks", "test_only"}
            if (chunk.chunk_id != chunk_id or chunk.service_id != service_id or not chunk.version
                    or any(not isinstance(getattr(chunk, key), str) for key in strings)
                    or any(type(getattr(chunk, key)) is not int for key in ("ordinal", "start", "end"))
                    or type(chunk.complete) is not bool or type(chunk.active) is not bool
                    or type(chunk.test_only) is not bool
                    or any(type(page) is not int or page < 1 for page in chunk.page_refs)
                    or any(not isinstance(key, str) for key in chunk.required_parents + chunk.source_blocks)):
                raise ValueError("청크 메타데이터 형식 오류")
            return chunk
        except (TypeError, ValueError):
            return EvidenceChunk(chunk_id, service_id, "invalid", "", url, source_kind="invalid")
    if isinstance(data, dict) and data.get("format") == "welfare-evidence-v1":
        fields = {name: data.get(name, "") for name in (
            "section", "text", "source_url", "source_updated_at", "basis_year", "collected_at",
            "source_kind", "conditions",
        )}
        if (data.get("service_id") == service_id and data.get("chunk_id") == chunk_id
                and all(isinstance(value, str) for value in fields.values())):
            return EvidenceChunk(chunk_id, service_id, **fields, score=score)
        return EvidenceChunk(chunk_id, service_id, "invalid", "", url, source_kind="invalid", score=score)
    if isinstance(data, dict) and str(data.get("format", "")).startswith("welfare-evidence"):
        return EvidenceChunk(chunk_id, service_id, "invalid", "", url, source_kind="invalid")
    # 기존 CSV 청크를 공식 상세 원문으로 승격하지 않는다.
    return EvidenceChunk(chunk_id, service_id, "summary", content, url, updated_at, score=score)


class EvidenceConsistencyError(ValueError):
    """활성 원문과 자식·부모·임베딩 버전을 일관되게 복원할 수 없다."""


SECTIONS = {"target", "criteria", "benefit", "application"}


def fingerprint(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


def validate_version(chunks: list[EvidenceChunk]) -> None:
    if not chunks or len({(c.service_id, c.version, c.source_hash, c.embed_digest, c.basis_year,
                           c.source_updated_at, c.source_url, c.clean_version, c.split_version, c.service_name,
                           c.source_kind, c.document_id, c.analysis_hash, c.review_hash)
                          for c in chunks}) != 1:
        raise EvidenceConsistencyError("서비스 원문 버전이 섞였습니다.")
    if {c.section for c in chunks} != SECTIONS or len({c.chunk_id for c in chunks}) != len(chunks):
        raise EvidenceConsistencyError("필수 섹션 누락 또는 중복 청크입니다.")
    parents = {c.chunk_id: c for c in chunks if c.parent_text}
    if len(parents) != 4:
        raise EvidenceConsistencyError("부모 원문이 완전하지 않습니다.")
    source_hash = fingerprint("\n".join(
        f"{c.section}|{c.basis_year}|{c.source_updated_at}|{c.source_url}|{c.parent_text}"
        for c in sorted(parents.values(), key=lambda c: c.section)))
    if source_hash != chunks[0].source_hash:
        raise EvidenceConsistencyError("부모 원문 해시가 다릅니다.")
    first = chunks[0]
    if fingerprint(source_hash + first.clean_version + first.split_version + first.service_name + first.embed_digest + first.document_id)[:24] != first.version:
        raise EvidenceConsistencyError("원문 버전 식별자가 일치하지 않습니다.")
    condition_parents = {c.chunk_id for c in parents.values() if c.section in {"target", "criteria"}}
    for section in SECTIONS:
        children = sorted((c for c in chunks if c.section == section), key=lambda c: c.ordinal)
        parent = parents.get(children[0].parent_id)
        if (not parent or parent.section != section or parent.ordinal != 0
                or [c.ordinal for c in children] != list(range(len(children)))):
            raise EvidenceConsistencyError("부모·자식 순번이 일치하지 않습니다.")
        covered = 0
        for child in children:
            namespace = "document:" + child.document_id if child.document_id else "official"
            if (not child.usable_detail or not child.embed_digest or not child.active
                    or not child.clean_version or not child.split_version or not child.service_name
                    or child.chunk_id != f"{child.service_id}:{namespace}:{child.version}:{child.section}:{child.ordinal}"
                    or child.parent_id != parent.chunk_id or child.start < 0
                    or len(child.text) > 800
                    or not child.start < child.end <= len(parent.parent_text)
                    or parent.parent_text[child.start:child.end] != child.text
                    or any(line not in parent.parent_text for line in child.heading_context.splitlines())
                    or parent.parent_text[covered:child.start].strip()
                    or not set(child.required_parents).issubset(parents)
                    or not condition_parents.issubset(child.required_parents)
                    or parent.chunk_id not in child.required_parents):
                raise EvidenceConsistencyError("원문 범위 또는 필수 연결이 누락되었습니다.")
            covered = max(covered, child.end)
        if parent.parent_text[covered:].strip():
            raise EvidenceConsistencyError("부모 원문 끝이 유실되었습니다.")


def active_chunks(chunks: list[EvidenceChunk]) -> list[EvidenceChunk]:
    result = []
    groups: dict[str, list[EvidenceChunk]] = {}
    for chunk in chunks:
        groups.setdefault(chunk.service_id, []).append(chunk)
    for rows in groups.values():
        if any(c.source_kind == "invalid" for c in rows):
            raise EvidenceConsistencyError("손상된 청크를 확인해 주세요.")
        current = [c for c in rows if c.version and c.active]
        if current:
            validate_version(current)
            result.extend(current)
            result.extend(c for c in rows if c.source_kind == "csv_summary")
        elif any(c.version for c in rows):
            result.extend(c for c in rows if c.source_kind == "csv_summary")
        else:
            legacy = [c for c in rows if not c.version]
            dates = {(c.basis_year, c.source_updated_at, c.collected_at) for c in legacy if c.source_kind == "official_detail"}
            if len(dates) > 1:
                raise EvidenceConsistencyError("기존 공식 원문의 기준 시점이 충돌합니다.")
            result.extend(legacy)
    return result
