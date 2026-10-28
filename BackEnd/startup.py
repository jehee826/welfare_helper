"""스키마 변경·CSV 적재 없이 기존 DB를 사용한다."""

import os
import sys

from BackEnd.core.settings import get_settings
from BackEnd.rag.reranker import download_model


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
    if settings.ingest_on_startup:
        print("INGEST_ON_STARTUP은 더 이상 지원하지 않습니다. CSV 자동 적재 없이 시작합니다.")
    return 0


def main() -> int:
    if prepare():
        return 1
    try:
        download_model()
    except Exception as exc:
        print(
            f"리랭커 캐시 준비 실패 ({type(exc).__name__}). "
            "네트워크·모델/revision·캐시 쓰기 권한·디스크 공간을 확인해 주세요. 백엔드를 시작하지 않습니다.",
            file=sys.stderr,
        )
        return 1
    sys.stdout.flush()
    os.execvp("uvicorn", ["uvicorn", "BackEnd.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
