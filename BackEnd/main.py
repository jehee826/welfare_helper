from contextlib import closing

import psycopg2
from fastapi import FastAPI, HTTPException
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: SecretStr | None = None
    db_host: str = ""
    db_port: int = 5432
    db_name: str = ""
    db_user: str = ""
    db_password: SecretStr | None = None


database_settings = DatabaseSettings()

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/health/db")
def database_health():
    database_url = (
        database_settings.database_url.get_secret_value()
        if database_settings.database_url
        else ""
    )
    password = (
        database_settings.db_password.get_secret_value()
        if database_settings.db_password
        else ""
    )
    connection_options = {"connect_timeout": 5}

    # Supabase 접속 문자열을 우선 사용하고 TLS 연결을 요구한다.
    if database_url:
        connection_options.update(dsn=database_url, sslmode="require")
    elif (
        database_settings.db_host
        and database_settings.db_name
        and database_settings.db_user
        and password
    ):
        connection_options.update(
            host=database_settings.db_host,
            port=database_settings.db_port,
            dbname=database_settings.db_name,
            user=database_settings.db_user,
            password=password,
        )
    else:
        raise HTTPException(status_code=503, detail="DB 연결 설정이 없습니다.")

    try:
        # 연결 확인 후 트랜잭션과 접속을 모두 종료해 서버리스 연결을 남기지 않는다.
        with closing(psycopg2.connect(**connection_options)) as connection:
            with connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
                    cursor.fetchone()
    except psycopg2.Error:
        raise HTTPException(
            status_code=503, detail="DB 연결을 확인하지 못했습니다."
        ) from None

    return {"status": "ok", "database": "connected"}
