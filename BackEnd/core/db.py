import psycopg2
from math import ceil

from BackEnd.core.settings import Settings
from BackEnd.core.execution import current_budget, checkpoint, ExecutionTimeoutError


class RequestCursor:
    """요청의 남은 예산을 각 읽기 SQL에 적용하고 원래 커서의 자료 형식을 유지한다."""
    def __init__(self, cursor):
        self.cursor = cursor

    def __getattr__(self, name):
        return getattr(self.cursor, name)

    def execute(self, query, params=None):
        budget = current_budget()
        try:
            if budget is not None:
                milliseconds = max(1, int(budget.remaining() * 1000))
                self.cursor.execute("SELECT set_config('statement_timeout', %s, true)", (str(milliseconds),))
                checkpoint()
            result = self.cursor.execute(query, params)
        except psycopg2.errors.QueryCanceled:
            if budget is not None:
                checkpoint()
                raise ExecutionTimeoutError() from None
            raise
        checkpoint()
        return result


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
    options = connection_options(settings)
    budget = current_budget()
    if budget is not None:
        remaining = budget.remaining()
        options["connect_timeout"] = max(1, min(5, ceil(remaining)))
    connection = psycopg2.connect(**options)
    try:
        checkpoint()
        return connection
    except Exception:
        connection.close()
        raise
