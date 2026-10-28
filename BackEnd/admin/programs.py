"""복지관 직원이 제도 메타데이터를 관리하는 API. 상세 근거는 문서 업로드·검토 흐름으로만 바꾼다."""

import logging
from datetime import date, datetime
from urllib.parse import parse_qsl, urlparse
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from BackEnd.admin.program_store import ProgramError, get_program_store
from BackEnd.documents.auth import require_document_admin

logger = logging.getLogger("welfare_helper")
router = APIRouter(prefix="/api/v1/admin", tags=["관리자 제도"], dependencies=[Depends(require_document_admin)])

ERROR_STATUS = {
    "program_not_found": 404,
    "program_changed": 409,
    "program_has_documents": 409,
    "duplicate_service_id": 409,
    "department_not_found": 422,
    "test_service_requires_test_only": 422,
    "program_constraint_violation": 422,
}
SERVICE_ID_PATTERN = r"^[A-Z0-9_]{3,40}$"


class ContactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=100)
    phone: str = Field(default="", max_length=30, pattern=r"^[0-9~,\- ]*$")

    @field_validator("label")
    @classmethod
    def strip_label(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("문의처 이름이 필요합니다.")
        return value.strip()


def public_url(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlparse(value)
    sensitive = any(re.search(r"token|key|secret|signature|password|credential|auth|x-amz", key, re.I)
                    for key, _ in parse_qsl(parsed.query))
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or sensitive:
        raise ValueError("출처는 인증정보·서명이 없는 공개 HTTPS 주소를 사용합니다.")
    return value


class ProgramFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("program_name", check_fields=False)
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("제도명이 필요합니다.")
        return value.strip() if value is not None else None

    @field_validator("source_url", check_fields=False)
    @classmethod
    def validate_url(cls, value: str | None) -> str | None:
        return public_url(value)


class ProgramIn(ProgramFields):
    program_name: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    department_id: int = Field(ge=1)
    external_service_id: str | None = Field(default=None, pattern=SERVICE_ID_PATTERN)
    source_url: str | None = Field(default=None, max_length=1000)
    source_updated_at: date | None = None
    contacts: list[ContactIn] = Field(default_factory=list, max_length=10)
    test_only: bool = False

    @model_validator(mode="after")
    def test_namespace(self):
        if (self.external_service_id or "").startswith("TEST_") and not self.test_only:
            raise ValueError("TEST_ 서비스 ID는 test_only 제도에만 쓸 수 있습니다.")
        return self


class ProgramPatch(ProgramFields):
    expected_updated_at: datetime
    program_name: str | None = Field(default=None, min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=2000)
    department_id: int | None = Field(default=None, ge=1)
    external_service_id: str | None = Field(default=None, pattern=SERVICE_ID_PATTERN)
    source_url: str | None = Field(default=None, max_length=1000)
    source_updated_at: date | None = None
    contacts: list[ContactIn] | None = Field(default=None, max_length=10)
    test_only: bool | None = None

    @model_validator(mode="after")
    def required_values(self):
        cleared = [key for key in ("program_name", "department_id", "contacts", "test_only")
                   if key in self.model_fields_set and getattr(self, key) is None]
        if cleared:
            raise ValueError(f"비울 수 없는 항목입니다: {', '.join(cleared)}")
        return self


def program_failure(exc: Exception):
    if isinstance(exc, ProgramError):
        code = str(exc)
        raise HTTPException(ERROR_STATUS.get(code, 409), code) from None
    logger.error("admin program request failed (%s)", type(exc).__name__)
    raise HTTPException(503, "program_service_unavailable") from None


@router.get("/programs", summary="제도 목록과 연결된 원문 문서 수")
def list_programs(query: str = Query(default="", max_length=100), offset: int = Query(default=0, ge=0),
                  limit: int = Query(default=50, ge=1, le=200), store=Depends(get_program_store)):
    try:
        return store.search(query.strip(), offset, limit)
    except Exception as exc:
        program_failure(exc)


@router.get("/departments", summary="제도에 연결할 담당 부서")
def list_departments(store=Depends(get_program_store)):
    try:
        return store.departments()
    except Exception as exc:
        program_failure(exc)


@router.post("/programs", status_code=201, summary="제도 등록")
def create_program(request: ProgramIn, store=Depends(get_program_store)):
    try:
        return store.create(request.model_dump(mode="json"))
    except Exception as exc:
        program_failure(exc)


@router.patch("/programs/{program_id}", summary="제도 일부 수정 (문서가 있으면 이름·서비스 ID 고정)")
def update_program(program_id: int, request: ProgramPatch, store=Depends(get_program_store)):
    changes = request.model_dump(mode="json", exclude_unset=True, exclude={"expected_updated_at"})
    try:
        return store.update(program_id, changes, request.expected_updated_at)
    except Exception as exc:
        program_failure(exc)


@router.delete("/programs/{program_id}", status_code=204, summary="문서가 없는 제도 삭제")
def delete_program(program_id: int, store=Depends(get_program_store)):
    try:
        store.delete(program_id)
    except Exception as exc:
        program_failure(exc)
    return Response(status_code=204)
