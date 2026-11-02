from functools import lru_cache
from math import ceil
from pathlib import Path
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """환경변수(.env 포함)에서 읽는 백엔드 설정."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    database_url: SecretStr | None = None
    database_password: SecretStr | None = None
    database_mode: Literal["auto", "local", "supabase"] = "auto"
    ingest_on_startup: bool = False
    db_host: str = ""
    db_port: int = 5432
    db_name: str = ""
    db_user: str = ""
    db_password: SecretStr | None = None

    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_llm: str = "qwen2.5:1.5b-instruct"
    ollama_embed: str = "bge-m3"
    ollama_timeout: float = Field(default=120.0, gt=0, allow_inf_nan=False)
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

    desktop_guidance_enabled: bool = False
    desktop_image_enabled: bool = False
    desktop_extension_token: SecretStr | None = None

    documents_enabled: bool = False
    admin_password: SecretStr | None = None
    documents_max_file_mb: int = Field(default=20, ge=1, le=50)
    documents_max_pages: int = Field(default=100, ge=1, le=300)
    documents_max_characters: int = Field(default=500000, ge=1000, le=2000000)
    documents_max_chunks: int = Field(default=2000, ge=4, le=5000)
    documents_parse_timeout: int = Field(default=300, ge=30, le=1800)
    documents_index_timeout: int = Field(default=600, ge=30, le=3600)
    documents_download_timeout: int = Field(default=7200, ge=300, le=86400)
    documents_poll_seconds: int = Field(default=10, ge=2, le=60)
    documents_lease_seconds: int = Field(default=90, ge=60, le=300)
    docling_cache_dir: str = "/app/.docling_cache"
    docling_ocr: bool = False

    cors_allowed_origins: list[str] = Field(default_factory=lambda: [
        "https://welfare-helper-iota.vercel.app",
        "http://localhost:5173", "http://127.0.0.1:5173",
    ])

    @property
    def desktop_timeout_seconds(self) -> int:
        return max(1, min(1800, ceil(self.ollama_timeout)))

    @field_validator("ollama_llm", "ollama_embed")
    @classmethod
    def validate_model_name(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_./:@-]*", value) or "//" in value:
            raise ValueError("Ollama 모델 이름은 공백 없는 모델명·태그로 지정하세요.")
        return value

    @field_validator("ollama_base_url")
    @classmethod
    def validate_ollama_url(cls, value: str) -> str:
        try:
            parsed = urlsplit(value)
            valid = (not re.search(r"\s", value) and parsed.scheme in {"http", "https"}
                     and bool(parsed.hostname) and parsed.username is None and parsed.password is None
                     and "?" not in value and "#" not in value
                     and not parsed.netloc.endswith(":") and parsed.port != 0)
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("Ollama 주소는 인증정보·쿼리·조각 없는 HTTP(S) 기본 주소여야 합니다.")
        return value.rstrip("/")

    @model_validator(mode="after")
    def validate_generation_budget(self):
        if self.llm_num_predict >= self.llm_num_ctx:
            raise ValueError("LLM_NUM_PREDICT는 LLM_NUM_CTX보다 작아야 합니다.")
        return self

    @field_validator("cors_allowed_origins")
    @classmethod
    def validate_cors_origins(cls, values: list[str]) -> list[str]:
        allowed = {"https://welfare-helper-iota.vercel.app", "http://localhost:5173", "http://127.0.0.1:5173"}
        if any(value not in allowed and not re.fullmatch(r"chrome-extension://[a-p]{32}", value) for value in values):
            raise ValueError("CORS는 공식 프런트·지정된 로컬 개발 Origin·명시한 Chrome 확장 ID만 허용합니다.")
        return list(dict.fromkeys(values))


@lru_cache
def get_settings() -> Settings:
    return Settings()
