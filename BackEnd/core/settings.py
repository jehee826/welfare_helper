from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """환경변수(.env 포함)에서 읽는 백엔드 설정."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: SecretStr | None = None
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
    llm_temperature: float = Field(default=0.2, ge=0, le=2)
    llm_num_predict: int = Field(default=250, ge=1)

    retrieve_top_n: int = Field(default=5, ge=1, le=50)
    min_dense_sim: float = Field(default=0.52, ge=-1, le=1)


@lru_cache
def get_settings() -> Settings:
    return Settings()
