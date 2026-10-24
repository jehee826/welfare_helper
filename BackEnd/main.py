import logging
from contextlib import closing
from functools import lru_cache
from typing import Literal

import psycopg2
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.rag.chat import ChatService
from BackEnd.rag.ollama import OllamaClient
from BackEnd.rag.repository import PgServiceRepository
from BackEnd.rag.reranker import LocalReranker, RerankerError

logger = logging.getLogger("welfare_helper")

app = FastAPI(title="welfare_helper")


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
    llm = OllamaClient(
        settings.ollama_base_url,
        settings.ollama_embed,
        settings.ollama_llm,
        settings.ollama_timeout,
        {"temperature": settings.llm_temperature, "num_ctx": settings.llm_num_ctx,
         "num_predict": settings.llm_num_predict, "num_thread": settings.llm_num_thread},
        embed_dim=settings.embed_dim,
    )
    repo = PgServiceRepository(
        lambda: connect(settings), embed_model=settings.ollama_embed, embed_dim=settings.embed_dim
    )
    reranker = LocalReranker(
        settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir,
        settings.rerank_max_length, settings.rerank_threads,
    )
    return ChatService(
        repo, llm, min_similarity=settings.min_dense_sim, top_n=settings.retrieve_top_n,
        reranker=reranker, min_rerank_score=settings.min_rerank_score,
    )


@app.get("/health")
def health():
    return {"status": "ok"}


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
def chat(request: ChatRequest, service: ChatService = Depends(get_chat_service)):
    profile = request.profile.model_dump() if request.profile else None
    try:
        if request.history:
            return service.answer(request.query.strip(), profile,
                                  [message.model_dump() for message in request.history])
        return service.answer(request.query.strip(), profile)
    except Exception as exc:
        logger.error("chat failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="상담 데이터를 불러오지 못했어요. 잠시 후 다시 시도하거나 보건복지상담센터 129로 문의해 주세요.",
        ) from None
