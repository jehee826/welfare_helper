"""서버의 실제 화면 상담 설정을 비공개 로컬 연결 파일로 내보낸다."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from BackEnd.core.settings import get_settings


def connection_payload(settings):
    token = settings.desktop_extension_token.get_secret_value() if settings.desktop_extension_token else ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("desktop_extension_token_required")
    return {"version": 1, "token": token,
            "timeoutSeconds": settings.desktop_timeout_seconds}


def write_connection(destination, settings):
    data = connection_payload(settings)
    path = Path(destination)
    descriptor, temporary = tempfile.mkstemp(prefix=".gyeote-connection-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=True)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("연결 파일 저장 경로 하나를 지정하세요.")
    try:
        write_connection(sys.argv[1], get_settings())
    except Exception:
        raise SystemExit("연결 파일을 만들지 못했습니다. 토큰 설정과 저장 경로를 확인하세요.") from None
    print("연결 파일을 준비했습니다. 내용은 출력하지 않습니다.")
