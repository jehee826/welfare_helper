from functools import lru_cache

from pydantic import SecretStr
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
    ollama_timeout: float = 120.0
    embed_dim: int = 1024
    llm_num_ctx: int = 8192
    llm_temperature: float = 0.2
    llm_num_predict: int = 250

    retrieve_top_n: int = 5
    min_dense_sim: float = 0.52


@lru_cache
def get_settings() -> Settings:
    return Settings()
