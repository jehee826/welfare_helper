from uuid import UUID
import os
import ipaddress
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from BackEnd.core.settings import get_settings

bearer = HTTPBearer(auto_error=False)


def local_peer(request: Request) -> bool:
    if not request.client:
        return False
    try:
        peer = ipaddress.ip_address(request.client.host)
        if peer.is_loopback:
            return True
        # Docker의 호스트 포트 전달 주소만 허용한다. 사설망 전체를 신뢰하지 않는다.
        if Path("/.dockerenv").is_file():
            for line in Path("/proc/net/route").read_text().splitlines()[1:]:
                fields = line.split()
                if fields[1] == "00000000" and str(peer) == str(ipaddress.ip_address(bytes.fromhex(fields[2])[::-1])):
                    return True
    except (OSError, ValueError, IndexError):
        pass
    return False


def require_local_document_admin(request: Request, settings) -> None:
    if settings.documents_local_mode:
        # Compose의 루프백 포트 공개와 함께 쓰는 개발 경계다. 공개 배포는 기존 인증을 사용한다.
        if (os.getenv("VERCEL") or not local_peer(request) or request.url.hostname not in {"localhost", "127.0.0.1", "::1"}
                or any(header in request.headers for header in ("forwarded", "x-forwarded-for", "x-forwarded-host"))):
            raise HTTPException(403, "로컬 문서 접수는 루프백 주소에서만 사용합니다.")
        origin = request.headers.get("origin")
        if origin:
            parsed = urlsplit(origin)
            if (parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)) != (request.url.scheme, request.url.hostname, request.url.port or (443 if request.url.scheme == "https" else 80)):
                raise HTTPException(403, "다른 출처의 문서 요청은 허용하지 않습니다.")
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, "다른 출처의 문서 요청은 허용하지 않습니다.")
        return None
    raise HTTPException(403, "로컬 문서 접수가 비활성입니다.")


def auth_headers(settings):
    base = settings.supabase_url.rstrip("/")
    parsed = urlsplit(base)
    key = settings.supabase_publishable_key.get_secret_value() if settings.supabase_publishable_key else ""
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment or not key.startswith("sb_publishable_")
            or len(key) <= len("sb_publishable_")):
        raise ValueError("Supabase Auth 공개 설정이 필요합니다.")
    return base, {"apikey": key}


def require_document_admin(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str | None:
    settings = get_settings()
    if not settings.documents_enabled:
        raise HTTPException(503, "문서 기능과 DB 마이그레이션 설정이 필요합니다.")
    if request is not None and "authorization" in request.headers and credentials is None:
        raise HTTPException(401, "Supabase 사용자 access token을 확인해 주세요.")
    if credentials is None and settings.documents_local_mode:
        return require_local_document_admin(request, settings)
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "Supabase 사용자 access token이 필요합니다.", headers={"WWW-Authenticate": "Bearer"})
    try:
        base, headers = auth_headers(settings)
        response = httpx.get(base + "/auth/v1/user", headers={**headers, "Authorization": "Bearer " + credentials.credentials},
                             timeout=15, follow_redirects=False)
        if response.status_code in {401, 403}:
            raise HTTPException(401, "인증 토큰을 확인해 주세요.")
        response.raise_for_status()
        user = response.json()
        if user.get("is_anonymous"):
            raise HTTPException(403, "관리자 권한이 필요합니다.")
        user_id = str(UUID(user["id"]))
        from BackEnd.documents.store import get_document_store

        if not get_document_store().is_admin(user_id):
            raise HTTPException(403, "관리자 권한이 필요합니다.")
        return user_id
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, "서버 인증 설정이나 Supabase 연결을 확인해 주세요.") from None
