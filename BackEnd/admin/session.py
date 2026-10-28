"""공통 비밀번호와 단일 프로세스의 8시간 관리자 세션을 관리한다."""

from collections import OrderedDict
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import math
import secrets
from threading import Lock
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from BackEnd.core.settings import get_settings

router = APIRouter(prefix="/api/v1/admin", tags=["관리자 인증"])
bearer = HTTPBearer(auto_error=False)
SESSION_SECONDS = 8 * 60 * 60
MAX_SESSIONS = 256
FAILURE_WINDOW = 60
MAX_FAILURES = 5
_lock = Lock()
_sessions = {}
_failures = OrderedDict()


@dataclass(frozen=True)
class AdminSession:
    session_id: str
    expires_at: int
    token_hash: str = field(repr=False)
    auth_mode: str = "shared_password"


def configured_password():
    value = get_settings().admin_password
    password = value.get_secret_value() if value else ""
    if not password:
        raise HTTPException(503, "관리자 비밀번호 서버 설정이 필요합니다.")
    return password


def _purge_sessions(now):
    for token_hash, session in list(_sessions.items()):
        if session.expires_at <= now:
            del _sessions[token_hash]


def create_session(password: str, peer: str):
    expected = configured_password()
    now = time.time()
    with _lock:
        attempts, started = _failures.get(peer, (0, now))
        if now - started >= FAILURE_WINDOW:
            attempts, started = 0, now
        if attempts >= MAX_FAILURES:
            raise HTTPException(429, "로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.",
                                headers={"Retry-After": str(max(1, math.ceil(FAILURE_WINDOW - (now - started))))})
        if not hmac.compare_digest(password.encode("utf-8"), expected.encode("utf-8")):
            _failures[peer] = (attempts + 1, started)
            _failures.move_to_end(peer)
            if len(_failures) > 1024:
                _failures.popitem(last=False)
            raise HTTPException(401, "관리자 비밀번호가 일치하지 않습니다.")
        _failures.pop(peer, None)
        _purge_sessions(now)
        if len(_sessions) >= MAX_SESSIONS:
            raise HTTPException(503, "관리자 세션 한도에 도달했습니다. 기존 세션을 종료한 뒤 다시 로그인해 주세요.")
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        session = AdminSession(secrets.token_urlsafe(18), int(now) + SESSION_SECONDS, token_hash)
        _sessions[token_hash] = session
    return {"access_token": token, "expires_at": session.expires_at, "session_id": session.session_id, "token_type": "bearer"}


def require_admin_session(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    configured_password()
    if credentials is None or credentials.scheme.lower() != "bearer" or len(credentials.credentials) > 256:
        raise HTTPException(401, "관리자 로그인이 필요합니다.", headers={"WWW-Authenticate": "Bearer"})
    token_hash = hashlib.sha256(credentials.credentials.encode()).hexdigest()
    with _lock:
        _purge_sessions(time.time())
        session = _sessions.get(token_hash)
    if session is None:
        raise HTTPException(401, "관리자 세션이 없거나 만료되었습니다.")
    return session


@router.post("/login")
async def login(request: Request):
    configured_password()
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "JSON 로그인 요청이 필요합니다.")
    # 검증 오류에 비밀번호 원문이 포함되지 않도록 로그인 본문만 직접 제한·검사한다.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2048:
            raise HTTPException(413, "로그인 요청이 너무 큽니다.")
    try:
        payload = json.loads(body)
        password = payload.get("password") if isinstance(payload, dict) else None
        if not isinstance(password, str) or not 1 <= len(password) <= 256:
            raise ValueError
    except (ValueError, TypeError):
        raise HTTPException(400, "비밀번호 요청 형식이 올바르지 않습니다.") from None
    return create_session(password, request.client.host if request.client else "unknown")


@router.post("/logout", status_code=204)
def logout(session: AdminSession = Depends(require_admin_session)):
    with _lock:
        _sessions.pop(session.token_hash, None)
