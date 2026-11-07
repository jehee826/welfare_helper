"""공통 비밀번호와 단일 프로세스의 8시간 관리자 세션을 관리한다."""

from collections import OrderedDict
from dataclasses import dataclass, field
import hashlib
from ipaddress import ip_address
import json
import math
import secrets
from threading import Lock
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.concurrency import run_in_threadpool

from BackEnd.core.settings import get_settings
from BackEnd.admin import credentials as credential_store

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
    credential_version: int = 0


def login_client_key(request: Request) -> str:
    """제한 키에서만 명시한 프록시의 단일 전달 IP를 사용하고 실제 peer는 유지한다."""
    raw_peer = request.client.host if request.client else "unknown"
    try:
        if "%" in raw_peer:
            return raw_peer
        peer = str(ip_address(raw_peer))
    except ValueError:
        return raw_peer
    if peer not in get_settings().admin_trusted_proxy_ips:
        return peer
    forwarded = request.headers.getlist("x-forwarded-for")
    if len(forwarded) != 1 or not 1 <= len(forwarded[0]) <= 45 or "%" in forwarded[0]:
        return peer
    try:
        return str(ip_address(forwarded[0]))
    except ValueError:
        return peer


def _purge_sessions(now):
    for token_hash, session in list(_sessions.items()):
        if session.expires_at <= now:
            del _sessions[token_hash]


def _verify_password(password, peer, now):
    """호출자는 세션 잠금을 유지해 로그인·재인증의 실패 제한을 공유한다."""
    attempts, started = _failures.get(peer, (0, now))
    if now - started >= FAILURE_WINDOW:
        attempts, started = 0, now
    if attempts >= MAX_FAILURES:
        raise HTTPException(429, "로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.",
                            headers={"Retry-After": str(max(1, math.ceil(FAILURE_WINDOW - (now - started))))})
    version = credential_store.verify_password(get_settings(), password)
    if version is None:
        _failures[peer] = (attempts + 1, started)
        _failures.move_to_end(peer)
        if len(_failures) > 1024:
            _failures.popitem(last=False)
        raise HTTPException(401, "관리자 비밀번호가 일치하지 않습니다.")
    _failures.pop(peer, None)
    return version


def reauthenticate(password, peer, actor):
    with _lock:
        if _verify_password(password, peer, time.time()) != actor.credential_version:
            raise HTTPException(401, "관리자 세션이 없거나 만료되었습니다.")


def invalidate_sessions_before(version):
    with _lock:
        for token_hash, actor in list(_sessions.items()):
            if actor.credential_version < version:
                del _sessions[token_hash]


def create_session(password: str, peer: str):
    credential_store.current_version(get_settings())
    now = time.time()
    with _lock:
        version = _verify_password(password, peer, now)
        _purge_sessions(now)
        if len(_sessions) >= MAX_SESSIONS:
            raise HTTPException(503, "관리자 세션 한도에 도달했습니다. 기존 세션을 종료한 뒤 다시 로그인해 주세요.")
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        session = AdminSession(secrets.token_urlsafe(18), int(now) + SESSION_SECONDS, token_hash,
                               credential_version=version)
        _sessions[token_hash] = session
    return {"access_token": token, "expires_at": session.expires_at, "session_id": session.session_id, "token_type": "bearer"}


def require_admin_session(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    version = credential_store.current_version(get_settings())
    if credentials is None or credentials.scheme.lower() != "bearer" or len(credentials.credentials) > 256:
        raise HTTPException(401, "관리자 로그인이 필요합니다.", headers={"WWW-Authenticate": "Bearer"})
    token_hash = hashlib.sha256(credentials.credentials.encode()).hexdigest()
    with _lock:
        _purge_sessions(time.time())
        session = _sessions.get(token_hash)
    if session is None or session.credential_version != version:
        raise HTTPException(401, "관리자 세션이 없거나 만료되었습니다.")
    return session


@router.post("/login")
async def login(request: Request):
    await run_in_threadpool(credential_store.current_version, get_settings())
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
        password.encode("utf-8")
    except (ValueError, TypeError, UnicodeError):
        raise HTTPException(400, "비밀번호 요청 형식이 올바르지 않습니다.") from None
    return await run_in_threadpool(create_session, password, login_client_key(request))


@router.post("/logout", status_code=204)
def logout(session: AdminSession = Depends(require_admin_session)):
    with _lock:
        _sessions.pop(session.token_hash, None)
