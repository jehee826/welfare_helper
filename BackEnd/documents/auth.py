from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials

from BackEnd.core.settings import get_settings
from BackEnd.admin.session import AdminSession, bearer, require_admin_session


def require_document_admin(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> AdminSession:
    if not get_settings().documents_enabled:
        raise HTTPException(503, "문서 기능과 DB 마이그레이션 설정이 필요합니다.")
    return require_admin_session(request, credentials)
