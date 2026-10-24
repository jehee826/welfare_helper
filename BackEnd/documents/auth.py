from uuid import UUID

import httpx
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from BackEnd.core.settings import get_settings
from BackEnd.documents.storage import supabase_headers

bearer = HTTPBearer(auto_error=False)


def require_document_admin(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    settings = get_settings()
    if not settings.documents_enabled:
        raise HTTPException(503, "문서 기능의 마이그레이션·인증·비공개 버킷 설정이 필요합니다.")
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "Supabase 사용자 access token이 필요합니다.", headers={"WWW-Authenticate": "Bearer"})
    try:
        base, headers = supabase_headers(settings)
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
