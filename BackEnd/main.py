import logging
from contextlib import closing
from functools import lru_cache
from typing import Literal

import psycopg2
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.rag.chat import ChatService
from BackEnd.rag.ollama import OllamaClient
from BackEnd.rag.repository import PgServiceRepository

logger = logging.getLogger("welfare_helper")

app = FastAPI(title="welfare_helper")


class ProfileIn(BaseModel):
    age: int = Field(ge=0, le=120)
    income: Literal["under50", "under100", "under150", "over150", "unknown"]
    household: Literal["single", "couple", "withChildren", "singleParent", "grandparent", "other"]
    region: str = Field(max_length=20)
    disability: bool


class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=300)
    profile: ProfileIn | None = None


@lru_cache
def get_chat_service() -> ChatService:
    settings = get_settings()
    llm = OllamaClient(
        settings.ollama_base_url,
        settings.ollama_embed,
        settings.ollama_llm,
        settings.ollama_timeout,
        {"temperature": settings.llm_temperature, "num_ctx": settings.llm_num_ctx, "num_predict": settings.llm_num_predict},
    )
    repo = PgServiceRepository(lambda: connect(settings))
    return ChatService(repo, llm, min_similarity=settings.min_dense_sim, top_n=settings.retrieve_top_n)


@app.get("/health")
def health():
    return {"status": "ok"}


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
        return service.answer(request.query.strip(), profile)
    except Exception:
        logger.exception("chat failed")
        raise HTTPException(
            status_code=503,
            detail="상담 데이터를 불러오지 못했어요. 잠시 후 다시 시도하거나 보건복지상담센터 129로 문의해 주세요.",
        ) from None
