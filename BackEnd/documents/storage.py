import base64
import json
from urllib.parse import quote, urlparse

import httpx

from BackEnd.documents.contracts import DocumentError


def supabase_headers(settings) -> tuple[str, dict]:
    base = settings.supabase_url.rstrip("/")
    parsed = urlparse(base)
    key = settings.supabase_service_key.get_secret_value() if settings.supabase_service_key else ""
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment or not key):
        raise DocumentError("supabase_server_configuration_required")
    headers = {"apikey": key}
    if key.startswith("sb_secret_") and len(key) > len("sb_secret_"):
        return base, headers
    # 서버 설정의 레거시 키 유형만 구분한다. JWT의 실제 검증은 Supabase가 수행한다.
    try:
        parts = key.split(".")
        claims = json.loads(base64.b64decode(parts[1] + "=" * (-len(parts[1]) % 4), altchars=b"-_", validate=True)) if len(parts) == 3 else {}
        if not isinstance(claims, dict) or claims.get("role") != "service_role":
            raise ValueError
    except (ValueError, TypeError):
        raise DocumentError("supabase_server_key_required") from None
    headers["Authorization"] = "Bearer " + key
    return base, headers


class PrivateStorage:
    def __init__(self, settings):
        self.base, self.headers = supabase_headers(settings)
        self.bucket = settings.documents_bucket

    def _private(self):
        try:
            response = httpx.get(self.base + "/storage/v1/bucket/" + quote(self.bucket, safe=""),
                                 headers=self.headers, timeout=30, follow_redirects=False)
            response.raise_for_status()
            if response.json().get("public") is not False:
                raise DocumentError("private_bucket_required")
        except (httpx.HTTPError, ValueError):
            raise DocumentError("private_bucket_unavailable") from None

    def _url(self, key):
        if ".." in key.split("/") or key.startswith("/") or "\\" in key:
            raise DocumentError("invalid_object_key")
        return self.base + "/storage/v1/object/" + quote(self.bucket, safe="") + "/" + quote(key, safe="/")

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self._private()
        try:
            response = httpx.post(self._url(key), headers={**self.headers, "Content-Type": content_type, "x-upsert": "false"},
                                  content=data, timeout=120, follow_redirects=False)
            if response.status_code not in {200, 201, 400, 409}:
                response.raise_for_status()
            # 같은 주소의 기존 객체는 다시 내려받아 내용이 동일한 경우에만 재사용한다.
            if response.status_code in {400, 409} and self.get(key, len(data) + 1) != data:
                raise DocumentError("object_hash_conflict")
        except httpx.HTTPError:
            raise DocumentError("storage_upload_failed") from None

    def get(self, key: str, max_bytes: int) -> bytes:
        self._private()
        try:
            with httpx.stream("GET", self._url(key), headers=self.headers, timeout=120, follow_redirects=False) as response:
                response.raise_for_status()
                parts, size = [], 0
                for part in response.iter_bytes():
                    size += len(part)
                    if size > max_bytes:
                        raise DocumentError("storage_object_size_limit")
                    parts.append(part)
            return b"".join(parts)
        except httpx.HTTPError:
            raise DocumentError("storage_download_failed") from None
