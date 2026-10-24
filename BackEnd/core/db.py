import psycopg2

from BackEnd.core.settings import Settings


class DatabaseNotConfigured(RuntimeError):
    """DATABASE_URL도 DB_* 값도 없을 때 발생한다."""


def connection_options(settings: Settings) -> dict:
    """Supabase 접속 문자열(DATABASE_URL)을 우선 쓰고 TLS를 요구한다. 없으면 DB_* 값을 쓴다."""
    options: dict = {"connect_timeout": 5}
    database_url = settings.database_url.get_secret_value() if settings.database_url else ""
    password = settings.db_password.get_secret_value() if settings.db_password else ""
    if settings.database_mode == "supabase" and not database_url:
        raise DatabaseNotConfigured("Supabase 모드에는 런타임 DATABASE_URL이 필요합니다.")
    if database_url:
        options.update(dsn=database_url, sslmode="require")
        # 비밀번호를 URI에 삽입하지 않아 예약 문자도 드라이버에 그대로 전달한다.
        if settings.database_password and settings.database_password.get_secret_value():
            options["password"] = settings.database_password.get_secret_value()
    elif settings.db_host and settings.db_name and settings.db_user and password:
        options.update(
            host=settings.db_host,
            port=settings.db_port,
            dbname=settings.db_name,
            user=settings.db_user,
            password=password,
        )
    else:
        raise DatabaseNotConfigured("DB 연결 설정이 없습니다.")
    return options


def connect(settings: Settings):
    return psycopg2.connect(**connection_options(settings))
