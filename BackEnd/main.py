import logging
import hmac
import os
from contextlib import closing
from functools import lru_cache
from typing import Literal

import psycopg2
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.rag.chat import ChatService, RagExecutionError
from BackEnd.rag.factory import build_chat_service
from BackEnd.rag.repository import PgServiceRepository
from BackEnd.rag.reranker import LocalReranker, RerankerError
from BackEnd.documents.api import DocumentBodyLimit, router as document_router
from BackEnd.documents.auth import require_document_admin
from BackEnd.documents.qa import answer_document
from BackEnd.documents.contracts import DocumentError
from BackEnd.admin.programs import router as program_router

logger = logging.getLogger("welfare_helper")

app = FastAPI(title="welfare_helper")
app.add_middleware(DocumentBodyLimit)
app.include_router(document_router)
app.include_router(program_router)


class ProfileIn(BaseModel):
    age: int = Field(ge=0, le=120)
    income: Literal["under50", "under100", "under150", "over150", "unknown"]
    household: Literal["single", "couple", "withChildren", "singleParent", "grandparent", "other"]
    region: str = Field(max_length=20)
    disability: bool


class HistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)

    @field_validator("content")
    @classmethod
    def validate_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("빈 대화 메시지는 사용할 수 없습니다.")
        return value



class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=300)
    profile: ProfileIn | None = None
    history: list[HistoryMessage] = Field(default_factory=list, max_length=12)

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
        },
        "reranker": {
            "model": settings.rerank_model,
            "revision": settings.rerank_revision,
            "min_score": settings.min_rerank_score,
            "max_length": settings.rerank_max_length,
            "threads": settings.rerank_threads,
        },
    }


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


@app.post("/api/v1/chat")
def chat(request: ChatRequest, http_request: Request, service: ChatService = Depends(get_chat_service)):
    settings = get_settings()
    if settings.documents_local_mode:
        # 기존 로컬 접근 검사를 통과한 요청만 등록된 검증용 문서까지 조회한다.
        require_document_admin(http_request, credentials=None)
        repo = PgServiceRepository(lambda: connect(settings), settings.ollama_embed, settings.embed_dim,
                                   documents_enabled=True, include_local_documents=True)
        service = build_chat_service(repo, settings)
    try:
        return answer_document(service.repo, service, request.query.strip())[0]
    except DocumentError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    except Exception as exc:
        logger.error("chat failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="문서 검색이나 모델 실행에 실패했습니다. 서버 상태를 확인해 주세요.",
        ) from None


def require_rag_diagnostics(x_rag_debug_token: str = Header(default="")) -> None:
    settings = get_settings()
    token = settings.rag_diagnostics_token.get_secret_value() if settings.rag_diagnostics_token else ""
    if (not settings.rag_diagnostics_enabled or os.environ.get("VERCEL")
            or len(token) < 32 or not hmac.compare_digest(token.encode(), x_rag_debug_token.encode())):
        raise HTTPException(status_code=404, detail="사용할 수 없는 경로입니다.")


@app.post("/debug/rag", dependencies=[Depends(require_rag_diagnostics)])
def rag_diagnostics(request: ChatRequest, service: ChatService = Depends(get_chat_service)):
    try:
        response, diagnostics = service.answer_with_diagnostics(
            request.query, request.profile.model_dump() if request.profile else None,
            [message.model_dump() for message in request.history],
        )
        return {"response": response, "diagnostics": diagnostics}
    except RagExecutionError as exc:
        return JSONResponse(status_code=503, content={"response": None, "diagnostics": exc.diagnostics})
    except Exception as exc:
        logger.error("rag diagnostic failed (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail="진단 실행 중 오류가 발생했습니다. DB·검색기·모델 상태를 확인해 주세요.") from None
