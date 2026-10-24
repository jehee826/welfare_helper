"""공용 DB는 읽기 모드로 시작하고 로컬 DB에서만 초기 CSV 적재를 수행한다."""

import os
import sys
import time
from contextlib import closing

import psycopg2

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.ingest.run import main as ingest


def prepare() -> int:
    settings = get_settings()
    shared = settings.database_mode == "supabase" or bool(
        settings.database_url and settings.database_url.get_secret_value()
    )
    if shared:
        if not settings.database_url or not settings.database_url.get_secret_value():
            print("Supabase 모드의 DATABASE_URL을 런타임에 주입해 주세요.", file=sys.stderr)
            return 1
        print("공용 DB의 기존 자료를 사용합니다. 시작 시 적재·스키마 변경을 하지 않습니다.")
        return 0
    if not settings.ingest_on_startup:
        return 0
    # 로컬 프로필에서는 DB 컨테이너의 준비 시간을 기다린다.
    for attempt in range(15):
        try:
            with closing(connect(settings)) as connection, connection, connection.cursor() as cursor:
                cursor.execute("SELECT 1")
            return ingest([])
        except DatabaseNotConfigured:
            print("로컬 DB 설정이 없습니다.", file=sys.stderr)
            return 1
        except psycopg2.Error:
            if attempt < 14:
                time.sleep(2)
    print("로컬 DB가 준비되지 않았습니다.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    if prepare():
        raise SystemExit(1)
    os.execvp("uvicorn", ["uvicorn", "BackEnd.main:app", "--host", "0.0.0.0", "--port", "8000"])
