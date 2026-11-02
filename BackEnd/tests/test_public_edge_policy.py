"""공개 edge의 정적 경로 계약이다. 실제 Caddy 라우팅 검증을 대신하지 않는다."""

from fnmatch import fnmatchcase
from pathlib import Path
import re

import pytest


CONFIG = (Path(__file__).resolve().parents[2] / "deploy/Caddyfile").read_text(encoding="utf-8")


def denied(path):
    groups = re.findall(r"^\s*(@\w+) path ([^\n]+)$", CONFIG, re.M)
    return any(re.search(r"respond " + re.escape(name) + r" 404\b", CONFIG)
               and any(fnmatchcase(path, pattern) for pattern in patterns.split())
               for name, patterns in groups)


@pytest.mark.parametrize("path", ["/health/", "/health/ready", "/health/db", "/health/runtime",
    "/docs", "/docs/", "/docs/oauth2-redirect", "/redoc", "/redoc/", "/redoc/child",
    "/openapi.json", "/debug", "/debug/rag", "/debug/child/path",
    "/api/v1/desktop", "/api/v1/desktop/guide"])
def test_public_edge_denies_internal_paths(path):
    assert denied(path)


@pytest.mark.parametrize("path", ["/health", "/api/v1/chat", "/api/v1/admin/login",
    "/api/v1/admin/session", "/api/v1/admin/logout", "/api/v1/admin/documents",
    "/api/v1/admin/documents/example/query"])
def test_public_edge_preserves_status_document_and_admin_paths(path):
    assert not denied(path)
    assert "reverse_proxy backend:8000" in CONFIG


def test_existing_tls_and_proxy_limits_are_preserved():
    assert "https://{$PUBLIC_API_HOST}" in CONFIG
    assert "max_size 52MiB" in CONFIG
    assert "response_header_timeout 1800s" in CONFIG
    assert "trusted_proxies" not in CONFIG
