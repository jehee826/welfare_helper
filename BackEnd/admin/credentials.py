"""DB 없이 서버 전용 해시 파일과 수신 확인용 단기 발급 권한을 관리한다."""

from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
from threading import Lock
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.concurrency import run_in_threadpool

from BackEnd.core.settings import get_settings

router = APIRouter(prefix="/api/v1/admin/password", tags=["관리자 인증"])
bearer = HTTPBearer(auto_error=False)
GRANT_SECONDS = 60
_file_lock = Lock()
_rotation_lock = Lock()
_pending = None


def password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=32768, r=8, p=1,
                            maxmem=64 * 1024 * 1024, dklen=32)
    return "scrypt:" + salt.hex() + ":" + digest.hex()


def matches_password(password, encoded):
    match = re.fullmatch(r"scrypt:([0-9a-f]{32}):([0-9a-f]{64})", encoded)
    if not match:
        raise HTTPException(503, "admin_credentials_unavailable")
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(match[1]), n=32768, r=8, p=1,
                            maxmem=64 * 1024 * 1024, dklen=32)
    return hmac.compare_digest(digest.hex(), match[2])


class CredentialFile:
    def __init__(self, path):
        self.path = Path(path)
        if not self.path.is_absolute():
            raise HTTPException(503, "admin_credentials_unavailable")

    @contextmanager
    def locked(self):
        if not _file_lock.acquire(timeout=2):
            raise HTTPException(503, "admin_credentials_unavailable")
        handle = None
        acquired = False
        try:
            handle = os.fdopen(os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600), "r+b")
            if os.name == "nt":
                import msvcrt
                if os.fstat(handle.fileno()).st_size == 0:
                    handle.write(b"0"); handle.flush()
                def lock():
                    handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                def unlock():
                    handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                def lock(): fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                def unlock(): fcntl.flock(handle, fcntl.LOCK_UN)
            deadline = time.monotonic() + 2
            while True:
                try:
                    lock(); acquired = True; break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise HTTPException(503, "admin_credentials_unavailable") from None
                    time.sleep(.01)
            yield
        except (OSError, ValueError, TypeError, UnicodeError):
            raise HTTPException(503, "admin_credentials_unavailable") from None
        finally:
            if handle is not None:
                try:
                    if acquired: unlock()
                finally:
                    handle.close()
            _file_lock.release()

    def _read(self):
        if self.path.is_symlink() or (os.name != "nt" and self.path.stat().st_mode & 0o077):
            raise HTTPException(503, "admin_credentials_unavailable")
        with self.path.open(encoding="utf-8") as source:
            state = json.loads(source.read(4097))
        if (not isinstance(state, dict) or set(state) != {"schema_version", "version", "password_hash"}
                or state["schema_version"] != 1 or type(state["version"]) is not int or state["version"] < 1
                or not isinstance(state["password_hash"], str)
                or not re.fullmatch(r"scrypt:[0-9a-f]{32}:[0-9a-f]{64}", state["password_hash"])):
            raise HTTPException(503, "admin_credentials_unavailable")
        return state

    def _write(self, state):
        temporary = self.path.with_name(self.path.name + "." + secrets.token_hex(8) + ".tmp")
        try:
            with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w", encoding="utf-8") as target:
                json.dump(state, target)
                target.flush(); os.fsync(target.fileno())
            os.replace(temporary, self.path)
            if os.name != "nt":
                descriptor = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try: os.fsync(descriptor)
                finally: os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)

    def initialize(self, password):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        encoded = password_hash(password)
        with self.locked():
            if self.path.exists():
                raise HTTPException(409, "admin_credentials_already_initialized")
            self._write({"schema_version": 1, "version": 1, "password_hash": encoded})

    def read(self):
        with self.locked():
            return self._read()

    def replace(self, expected_version, encoded):
        with self.locked():
            state = self._read()
            # 교체 후 응답이 유실돼도 같은 발급 권한은 다시 교체하지 않는다.
            if state["version"] == expected_version + 1 and hmac.compare_digest(state["password_hash"], encoded):
                return state["version"]
            if state["version"] != expected_version:
                raise HTTPException(409, "admin_credentials_changed")
            state = {"schema_version": 1, "version": expected_version + 1, "password_hash": encoded}
            self._write(state)
            return state["version"]


def current_version(settings):
    path = getattr(settings, "admin_credentials_file", None)
    if path:
        return CredentialFile(path).read()["version"]
    value = settings.admin_password
    if not value or not value.get_secret_value():
        raise HTTPException(503, "관리자 비밀번호 서버 설정이 필요합니다.")
    return 0


def verify_password(settings, password):
    path = getattr(settings, "admin_credentials_file", None)
    if path:
        state = CredentialFile(path).read()
        return state["version"] if matches_password(password, state["password_hash"]) else None
    current_version(settings)
    return 0 if hmac.compare_digest(password.encode(), settings.admin_password.get_secret_value().encode()) else None


@dataclass
class RotationGrant:
    token_hash: str = field(repr=False)
    session_hash: str = field(repr=False)
    password_hash: str = field(repr=False)
    version: int
    expires_at: float


def require_rotation_session(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    from BackEnd.admin.session import require_admin_session
    return require_admin_session(request, credentials)


async def private_body(request, key):
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "invalid_password_request")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2048:
            raise HTTPException(413, "invalid_password_request")
    try:
        value = json.loads(body)
        if not isinstance(value, dict) or set(value) != {key} or not isinstance(value[key], str) or not 1 <= len(value[key]) <= 256:
            raise ValueError
        value[key].encode("utf-8")
        return value[key]
    except (ValueError, TypeError, UnicodeError):
        raise HTTPException(400, "invalid_password_request") from None


def prepare_rotation(actor, password, peer):
    from BackEnd.admin import session
    global _pending
    settings = get_settings()
    if not getattr(settings, "admin_credentials_file", None):
        raise HTTPException(503, "password_rotation_unavailable")
    try:
        session.reauthenticate(password, peer, actor)
    except HTTPException as exc:
        if exc.status_code == 401:
            raise HTTPException(403, "current_password_invalid") from None
        raise
    with _rotation_lock:
        if _pending and _pending.expires_at > time.monotonic() and current_version(settings) == _pending.version:
            raise HTTPException(409, "password_rotation_pending")
        if current_version(settings) != actor.credential_version:
            raise HTTPException(409, "admin_credentials_changed")
        password, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
        _pending = RotationGrant(hashlib.sha256(token.encode()).hexdigest(), actor.token_hash,
                                 password_hash(password), actor.credential_version, time.monotonic() + GRANT_SECONDS)
        return {"password": password, "rotation_token": token, "expires_in": GRANT_SECONDS}


def activate_rotation(token, request, credentials):
    from BackEnd.admin import session
    with _rotation_lock:
        grant = _pending
        if (not grant or grant.expires_at <= time.monotonic() or credentials is None
                or credentials.scheme.lower() != "bearer"
                or not hmac.compare_digest(grant.token_hash, hashlib.sha256(token.encode()).hexdigest())
                or not hmac.compare_digest(grant.session_hash, hashlib.sha256(credentials.credentials.encode()).hexdigest())):
            raise HTTPException(401, "password_rotation_expired")
        settings = get_settings()
        if not getattr(settings, "admin_credentials_file", None):
            raise HTTPException(503, "password_rotation_unavailable")
        state = CredentialFile(settings.admin_credentials_file).read()
        applied = state["version"] == grant.version + 1 and hmac.compare_digest(state["password_hash"], grant.password_hash)
        if not applied:
            session.require_admin_session(request, credentials)
        version = CredentialFile(settings.admin_credentials_file).replace(grant.version, grant.password_hash)
        session.invalidate_sessions_before(version)
        return {"applied": True}


@router.post("/issue")
async def issue_password(request: Request, actor=Depends(require_rotation_session)):
    from BackEnd.admin.session import login_client_key
    password = await private_body(request, "current_password")
    return await run_in_threadpool(prepare_rotation, actor, password, login_client_key(request))


@router.post("/activate")
async def activate_password(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    token = await private_body(request, "rotation_token")
    return await run_in_threadpool(activate_rotation, token, request, credentials)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="서버 런타임 비밀번호를 전용 해시 파일로 최초 이관한다.")
    parser.add_argument("operation", choices=["initialize"])
    parser.parse_args()
    settings = get_settings()
    if not settings.admin_credentials_file or not settings.admin_password:
        raise SystemExit("런타임의 저장 경로와 초기 관리자 비밀번호 설정이 필요합니다.")
    CredentialFile(settings.admin_credentials_file).initialize(settings.admin_password.get_secret_value())
    print("관리자 해시 저장소 최초 이관 완료. 기존 저장소는 덮어쓰지 않았습니다.")
