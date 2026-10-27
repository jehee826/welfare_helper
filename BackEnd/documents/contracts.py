import hashlib
import io
import json
import re
import zipfile
from datetime import date
from urllib.parse import parse_qsl, urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PARSER_VERSION = "docling-2.141.0-heron8f39ad3-tablefc0f2d4-review-v1"


class DocumentError(RuntimeError):
    """외부 예외·원문 대신 공개 가능한 오류 코드만 전달한다."""


def stable_hash(value) -> str:
    normalized = value if isinstance(value, bytes) else json.loads(json.dumps(value, ensure_ascii=False, default=str, allow_nan=False))
    data = normalized if isinstance(normalized, bytes) else json.dumps(normalized, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
    return hashlib.sha256(data).hexdigest()


class DocumentMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    service_id: str = Field(min_length=1, max_length=200, description="제도 조회 응답의 service_id를 그대로 사용합니다.")
    name: str = Field(min_length=1, max_length=160)
    source_url: str = Field(max_length=1000)
    source_organization: str = Field(min_length=1, max_length=300)
    basis_year: str | None = Field(default=None, pattern=r"^(19|20)\d{2}$")
    source_updated_at: date | None = None
    valid_from: date | None = None
    valid_until: date | None = None
    region_scope: str | None = Field(default=None, max_length=300)
    edition: str = Field(default="", max_length=80)
    test_only: bool = False

    @model_validator(mode="after")
    def test_namespace(self):
        if self.service_id.startswith("TEST_") and not self.test_only:
            raise ValueError("가상 문서는 test_only와 TEST_ 전용 서비스 연결이 필요합니다.")
        if not self.source_organization.strip():
            raise ValueError("원문 발행 기관이 필요합니다.")
        if self.valid_from and self.valid_until and self.valid_from > self.valid_until:
            raise ValueError("효력 시작일이 종료일보다 늦을 수 없습니다.")
        return self

    @field_validator("source_url")
    @classmethod
    def validate_url(cls, value):
        parsed = urlparse(value)
        sensitive = any(re.search(r"token|key|secret|signature|password|credential|auth|x-amz", key, re.I)
                        for key, _ in parse_qsl(parsed.query))
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or sensitive or parsed.fragment:
            raise ValueError("출처는 인증정보·서명·fragment 없는 공개 원본 HTTPS 주소를 사용합니다.")
        return value

    @field_validator("service_id", "source_organization")
    @classmethod
    def validate_reference(cls, value):
        if not value.strip() or value != value.strip() or any(ord(c) < 32 for c in value):
            raise ValueError("식별자와 발행 기관에는 공백 여백·제어 문자를 넣지 않습니다.")
        return value

    @field_validator("name", "edition")
    @classmethod
    def validate_label(cls, value, info):
        if (info.field_name == "name" and not value.strip()) or any(ord(c) < 32 for c in value) or "/" in value or "\\" in value:
            raise ValueError("문서 표시에 사용할 이름을 입력합니다.")
        return value.strip()


class IndexRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    analysis_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    sections: dict[str, list[str]] = Field(max_length=4)
    excluded_blocks: dict[str, str] = Field(default_factory=dict, max_length=10000)
    confirm_complete: bool
    confirm_source_and_service: bool
    review_note: str = Field(min_length=10, max_length=1000)
    reconciled_api_version: str = Field(default="", max_length=64)
    reconciliation_note: str = Field(default="", max_length=1000)
    reindex_revision: str = Field(default="", max_length=80)

    @field_validator("review_note")
    @classmethod
    def validate_review_note(cls, value):
        if len(value.strip()) < 10:
            raise ValueError("10자 이상의 실제 검토 메모를 작성합니다.")
        return value.strip()


def validate_file(data: bytes, suffix: str, max_bytes: int) -> None:
    if not data or len(data) > max_bytes:
        raise DocumentError("file_size_limit")
    if suffix == "pdf":
        if not data.startswith(b"%PDF-"):
            raise DocumentError("invalid_pdf")
        return
    if suffix == "md":
        try:
            text = data.decode("utf-8-sig")
        except UnicodeError:
            raise DocumentError("markdown_utf8_required") from None
        if not text.strip() or "\x00" in text:
            raise DocumentError("invalid_markdown")
        if re.search(r"!\[|<(?:img|iframe|object|video|audio)\b", text, re.I):
            raise DocumentError("markdown_external_media_not_supported")
        return
    if suffix != "docx" or not data.startswith(b"PK"):
        raise DocumentError("unsupported_format")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            items = archive.infolist()
            if len(items) > 2000 or sum(i.file_size for i in items) > 100 * 1024 * 1024:
                raise DocumentError("docx_archive_limit")
            names = {i.filename for i in items}
            if "word/document.xml" not in names or "[Content_Types].xml" not in names:
                raise DocumentError("invalid_docx")
            for item in items:
                if (item.flag_bits & 1 or item.filename.startswith(("/", "\\"))
                        or ".." in item.filename.replace("\\", "/").split("/")
                        or re.search(r"vbaProject|embeddings/", item.filename, re.I)):
                    raise DocumentError("unsafe_docx_member")
                if item.filename.endswith((".xml", ".rels")):
                    content = archive.read(item)
                    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
                        raise DocumentError("unsafe_docx_xml")
                    if item.filename.endswith(".rels") and re.search(rb"\bTargetMode\s*=\s*['\"]External['\"]", content, re.I):
                        # 외부 참조의 처리 차이를 추측하지 않고 분석 전에 차단한다.
                        raise DocumentError("docx_external_relationship")
    except (zipfile.BadZipFile, RuntimeError, OSError):
        raise DocumentError("invalid_docx") from None


def validate_review(analysis: dict, request: dict) -> None:
    if analysis.get("blockers") or not analysis.get("blocks"):
        raise DocumentError("analysis_quality_blocked")
    if not request.get("confirm_complete") or not request.get("confirm_source_and_service"):
        raise DocumentError("explicit_review_required")
    sections = request.get("sections", {})
    if set(sections) != {"target", "criteria", "benefit", "application"} or any(not v for v in sections.values()):
        raise DocumentError("four_sections_required")
    ids = {block["id"] for block in analysis["blocks"]}
    chosen = [bid for values in sections.values() for bid in values]
    excluded = request.get("excluded_blocks", {})
    if (any(not isinstance(bid, str) for bid in chosen) or len(chosen) != len(set(chosen))
            or set(chosen) & set(excluded) or set(chosen) | set(excluded) != ids
            or any(not isinstance(reason, str) or len(reason.strip()) < 10 for reason in excluded.values())):
        raise DocumentError("all_blocks_must_be_reviewed_once")
    order = {block["id"]: i for i, block in enumerate(analysis["blocks"])}
    if any(values != sorted(values, key=order.get) for values in sections.values()):
        raise DocumentError("preserve_source_order")
    by_id = {block["id"]: block for block in analysis["blocks"]}
    if any(not by_id[bid]["text"].strip() for bid in chosen):
        raise DocumentError("empty_block_cannot_be_indexed")
