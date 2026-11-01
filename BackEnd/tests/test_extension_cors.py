import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from pydantic import ValidationError

from BackEnd.core.settings import Settings


EXTENSION = "chrome-extension://" + "a" * 32


@pytest.mark.parametrize("origin", ["*", "chrome-extension://*", "chrome-extension://" + "q" * 32,
                                    EXTENSION + "/", "https://api.example.invalid"])
def test_cors_rejects_broad_or_unapproved_origin(origin):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, cors_allowed_origins=[origin])


def test_only_configured_extension_receives_cors_preflight():
    original = Settings(_env_file=None).cors_allowed_origins
    settings = Settings(_env_file=None, cors_allowed_origins=original + [EXTENSION, EXTENSION])
    assert settings.cors_allowed_origins == original + [EXTENSION]
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_allowed_origins,
                       allow_credentials=False, allow_methods=["POST"],
                       allow_headers=["Content-Type", "Authorization"])
    with TestClient(app) as client:
        for origin in [EXTENSION, original[0]]:
            response = client.options("/api/v1/chat", headers={"Origin": origin,
                "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"})
            assert response.status_code == 200
            assert response.headers["access-control-allow-origin"] == origin
            assert "access-control-allow-credentials" not in response.headers
        response = client.options("/api/v1/chat", headers={"Origin": "chrome-extension://" + "b" * 32,
            "Access-Control-Request-Method": "POST"})
        assert response.status_code == 400
        assert "access-control-allow-origin" not in response.headers
