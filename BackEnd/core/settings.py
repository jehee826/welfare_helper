from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """환경변수(.env 포함)에서 읽는 백엔드 설정."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: SecretStr | None = None
    database_password: SecretStr | None = None
    database_mode: Literal["auto", "local", "supabase"] = "auto"
    ingest_on_startup: bool = True
    db_host: str = ""
    db_port: int = 5432
    db_name: str = ""
    db_user: str = ""
    db_password: SecretStr | None = None

    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_llm: str = "gemma3:4b"
    ollama_embed: str = "bge-m3"
    ollama_timeout: float = Field(default=120.0, gt=0)
    embed_dim: int = Field(default=1024, ge=1024, le=1024)
    llm_num_ctx: int = Field(default=8192, ge=512)
    llm_temperature: float = Field(default=0.0, ge=0, le=2)
    llm_num_predict: int = Field(default=512, ge=1)
    llm_num_thread: int = Field(default=2, ge=1, le=16)

    retrieve_top_n: int = Field(default=40, ge=1, le=50)
    dense_top_k: int = Field(default=30, ge=1, le=30)
    keyword_top_k: int = Field(default=30, ge=1, le=30)
    core_evidence_k: int = Field(default=6, ge=1, le=6)
    rag_diagnostics_enabled: bool = False
    rag_diagnostics_token: SecretStr | None = None
    min_dense_sim: float = Field(default=0.52, ge=-1, le=1)
    rerank_model: str = "onnx-community/bge-reranker-v2-m3-ONNX"
    rerank_revision: str = "6f5ff65298512715a1e669753bc754d2bc8f367b"
    rerank_cache_dir: str = str(Path(__file__).resolve().parents[2] / ".reranker_cache")
    rerank_max_length: int = Field(default=512, ge=128, le=512)
    rerank_threads: int = Field(default=2, ge=1, le=8)
    min_rerank_score: float = Field(default=0.5, ge=0, le=1)
    bokjiro_service_key: SecretStr | None = None
    bokjiro_detail_url: str = "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfaredetailedV001"
    bokjiro_timeout: float = Field(default=15, gt=0, le=60)


@lru_cache
def get_settings() -> Settings:
    return Settings()
