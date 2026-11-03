import logging
import hmac
import os
from contextlib import closing
from functools import lru_cache
from typing import Literal

import psycopg2
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from BackEnd.core.execution import InferenceBodyLimit, inference_request
from BackEnd.core.chat_rate import enforce_chat_rate_limit
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.core.privacy import redact_document, validate_document_input, sensitive_input
from BackEnd.desktop_guidance import router as desktop_guidance_router
from BackEnd.screen_guidance import router as screen_guidance_router, remote_screen_enabled
from BackEnd.rag.chat import ChatService
from BackEnd.rag.factory import build_chat_service
from BackEnd.rag.repository import PgServiceRepository
from BackEnd.rag.reranker import LocalReranker, RerankerError
from BackEnd.documents.api import DocumentBodyLimit, router as document_router
from BackEnd.documents.auth import bearer, require_document_admin
from BackEnd.admin.session import router as admin_session_router
from BackEnd.documents.qa import answer_document
from BackEnd.documents.context import ConversationContext
from BackEnd.documents.contracts import DocumentError
from BackEnd.admin.programs import router as program_router
from BackEnd.readiness import check_ready, ReadinessError

logger = logging.getLogger("welfare_helper")

app = FastAPI(title="welfare_helper")
app.include_router(desktop_guidance_router)
app.include_router(screen_guidance_router)
app.add_middleware(InferenceBodyLimit, timeout_seconds=lambda: get_settings().ollama_timeout,
                   screen_enabled=remote_screen_enabled)
app.add_middleware(DocumentBodyLimit)
app.include_router(document_router)
app.include_router(program_router)
app.include_router(admin_session_router)
app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_allowed_origins,
                   allow_credentials=False, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                   allow_headers=["Content-Type", "Authorization"])


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    if request.url.path in {"/api/v1/desktop/guide", "/api/v1/screen/guide"}:
        return JSONResponse(status_code=422, content={"detail": "invalid_screen_request" if request.url.path == "/api/v1/screen/guide" else "invalid_desktop_request"})
    if request.url.path in {"/api/v1/chat", "/debug/rag"} or (
        request.url.path.startswith("/api/v1/admin/documents/")
        and request.url.path.endswith(("/query", "/search"))
    ):
        code = "sensitive_input" if any(error["type"] == "sensitive_input" for error in exc.errors()) else "invalid_document_request"
        return JSONResponse(status_code=422, content={"detail": code})
    return await request_validation_exception_handler(request, exc)


class ProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    age: int | None = Field(default=None, ge=0, le=120, strict=True)
    income: Literal["under50", "under100", "under150", "over150", "unknown"] = "unknown"
    household: Literal["single", "couple", "withChildren", "singleParent", "grandparent", "other"] | None = None
    region: str | None = Field(default=None, max_length=20)
    disability: bool | None = Field(default=None, strict=True)

    @field_validator("region")
    @classmethod
    def validate_region_privacy(cls, value):
        if value is not None and sensitive_input(value):
            raise PydanticCustomError("sensitive_input", "개인정보를 제외하고 질문해 주세요.")
        return value


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("빈 대화 메시지는 사용할 수 없습니다.")
        return value



class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=300)
    timeout_seconds: int | None = Field(default=None, ge=1, le=1800, strict=True)
    profile: ProfileIn | None = Field(default=None, description="구형 클라이언트 호환용이며 문서 검색·생성에는 사용하지 않습니다.")
    history: list[HistoryMessage] = Field(default_factory=list, max_length=12,
                                        description="검색 의도와 답변 맥락에 참고하며 공식 근거로 취급하지 않습니다.")
    conversation_context: ConversationContext | None = None

    def qa_options(self):
        result = {}
        if self.history:
            result["history"] = [message.model_dump() for message in self.history]
        if self.conversation_context is not None:
            context = self.conversation_context
            absent = {"userMessages", "documentIds", "supportsTopicBoundary"} - context.model_fields_set
            result["conversation_context"] = context.model_dump(exclude=absent)
        return result

    @model_validator(mode="before")
    @classmethod
    def validate_privacy(cls, data):
        return validate_document_input(data)

    @model_validator(mode="after")
    def validate_history_size(self):
        if sum(len(message.content) for message in self.history) > 6000:
            raise ValueError("대화 이력은 전체 6000자 이내여야 합니다.")
        return self

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("질문을 입력해 주세요.")
        return value





@lru_cache
def get_chat_service() -> ChatService:
    settings = get_settings()
    repo = PgServiceRepository(
        lambda: connect(settings), embed_model=settings.ollama_embed, embed_dim=settings.embed_dim,
        documents_enabled=settings.documents_enabled,
    )
    return build_chat_service(repo, settings)


def document_chat_service(http_request: Request, service: ChatService,
                          credentials: HTTPAuthorizationCredentials | None) -> ChatService:
    """채팅과 진단의 검색 권한을 동일하게 선택한다. 진단 토큰은 검색 권한이 아니다."""
    if "authorization" in http_request.headers and credentials is None:
        raise HTTPException(401, "관리자 세션을 확인해 주세요.")
    if credentials is None:
        return service
    require_document_admin(http_request, credentials)
    settings = get_settings()
    repo = PgServiceRepository(lambda: connect(settings), settings.ollama_embed, settings.embed_dim,
                               documents_enabled=True, include_local_documents=True)
    return build_chat_service(repo, settings)


def document_qa_error_code(exc: DocumentError) -> str:
    code = str(exc)
    return code if code in {
        "document_scope_mismatch", "embedding_digest_changed", "document_embedding_failed",
        "document_reranker_failed", "document_generation_failed", "document_changed_during_search", "document_input_budget",
    } else "document_service_unavailable"


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/health/runtime")
def runtime_settings():
    """프로세스에 적용된 공개 설정만 반환하며 연결·준비 상태를 검사하지 않는다."""
    settings = get_settings()
    return {
        "configuration_only": True,
        "readiness_checked": False,
        "qa": {
            "mode": "document_rag", "policy": "welfare_document_evidence",
            "profile_supported": False, "history_supported": True, "conversation_summary_supported": True,
            "usage_is_request_specific": True, "strict_citation_validation_enabled": False,
            "source_span_validation_enabled": False, "semantic_entailment_verified": False,
        },
        "llm": {
            "model": settings.ollama_llm,
            "context_tokens": settings.llm_num_ctx,
            "max_output_tokens": settings.llm_num_predict,
            "temperature": settings.llm_temperature,
            "threads": settings.llm_num_thread,
        },
        "embedding": {"model": settings.ollama_embed, "dimension": settings.embed_dim},
        "retrieval": {
            "candidate_limit": min(settings.retrieve_top_n, 40),
            "dense_limit": settings.dense_top_k,
            "keyword_limit": settings.keyword_top_k,
            "core_evidence_limit": settings.core_evidence_k,
            "min_dense_similarity": settings.min_dense_sim,
            "dense_prefilter_enabled": False,
            "dense_threshold": {"configured": settings.min_dense_sim, "enabled": True,
                                "effective": settings.min_dense_sim, "stage": "hybrid_union"},
        },
        "reranker": {
            "model": settings.rerank_model,
            "revision": settings.rerank_revision,
            "min_score": settings.min_rerank_score,
            "score_threshold": {"configured": settings.min_rerank_score, "enabled": False, "effective": None},
            "max_length": settings.rerank_max_length,
            "threads": settings.rerank_threads,
        },
    }


@app.get("/health/ready")
def readiness():
    try:
        return check_ready()
    except ReadinessError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


@app.get("/health/reranker")
def reranker_health():
    settings = get_settings()
    try:
        LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir).model_files()
    except RerankerError:
        raise HTTPException(status_code=503, detail="리랭커 캐시 준비가 필요합니다.") from None
    return {"status": "ok", "reranker": "cache_ready", "inference_checked": False}


@app.get("/health/db")
def database_health():
    try:
        with closing(connect(get_settings())) as connection, connection, connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except DatabaseNotConfigured:
        raise HTTPException(status_code=503, detail="DB 연결 설정이 없습니다.") from None
    except psycopg2.Error:
        raise HTTPException(status_code=503, detail="DB 연결을 확인하지 못했습니다.") from None
    return {"status": "ok", "database": "connected"}


@app.post("/api/v1/chat", dependencies=[Depends(enforce_chat_rate_limit)])
def chat(request: ChatRequest, http_request: Request, service: ChatService = Depends(get_chat_service),
         credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    """게시 문서를 최소 근거 정책으로 질의한다. 검색 범위는 관리자 세션 유무에 따른다."""
    try:
        with inference_request(http_request, get_settings().ollama_timeout, request.timeout_seconds):
            service = document_chat_service(http_request, service, credentials)
            return redact_document(answer_document(service.repo, service, request.query.strip(), **request.qa_options())[0])
    except HTTPException:
        raise
    except DocumentError as exc:
        raise HTTPException(status_code=503, detail=document_qa_error_code(exc)) from None
    except Exception as exc:
        logger.error("chat failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="문서 검색이나 모델 실행에 실패했습니다. 서버 상태를 확인해 주세요.",
        ) from None


@app.get("/api/v1/admin/session")
def admin_session(actor=Depends(require_document_admin)):
    return {"is_admin": True, "access_mode": actor.auth_mode,
            "expires_at": actor.expires_at, "session_id": actor.session_id}


@app.middleware("http")
async def private_responses(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/api/v1/admin", "/api/v1/desktop", "/api/v1/screen")) or request.url.path in {"/api/v1/chat", "/debug/rag"}:
        response.headers["Cache-Control"] = "no-store"
    return response


def require_rag_diagnostics(x_rag_debug_token: str = Header(default="")) -> None:
    settings = get_settings()
    token = settings.rag_diagnostics_token.get_secret_value() if settings.rag_diagnostics_token else ""
    if (not settings.rag_diagnostics_enabled or os.environ.get("VERCEL")
            or len(token) < 32 or not hmac.compare_digest(token.encode(), x_rag_debug_token.encode())):
        raise HTTPException(status_code=404, detail="사용할 수 없는 경로입니다.")


@app.post("/debug/rag", dependencies=[Depends(require_rag_diagnostics)])
def rag_diagnostics(request: ChatRequest, http_request: Request, service: ChatService = Depends(get_chat_service),
                    credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    """채팅과 같은 문서 QA를 한 번 실행한다. 별도 진단 토큰은 관리자 세션을 대체하지 않는다."""
    try:
        with inference_request(http_request, get_settings().ollama_timeout, request.timeout_seconds):
            service = document_chat_service(http_request, service, credentials)
            response, diagnostics = answer_document(service.repo, service, request.query, **request.qa_options())
            return redact_document({"response": response, "diagnostics": diagnostics})
    except HTTPException as exc:
        if exc.status_code in {429, 499, 504}:
            return JSONResponse(status_code=exc.status_code, headers=exc.headers,
                                content={"detail": exc.detail, "response": None, "diagnostics": None})
        raise
    except DocumentError as exc:
        return JSONResponse(status_code=503, content={"detail": document_qa_error_code(exc),
                                                     "response": None, "diagnostics": None})
    except Exception as exc:
        logger.error("rag diagnostic failed (%s)", type(exc).__name__)
        return JSONResponse(status_code=503, content={"detail": "document_service_unavailable",
                                                     "response": None, "diagnostics": None})
