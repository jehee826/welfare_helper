"""DB 읽기·모델 존재·캐시와 워커 생존만 확인한다. 추론은 실행하지 않는다."""

from contextlib import closing
from pathlib import Path
import sys
import time
from urllib.request import urlopen

import httpx

from BackEnd.core.db import connect
from BackEnd.core.settings import get_settings
from BackEnd.rag.reranker import LocalReranker

WORKER_HEARTBEAT = Path("/tmp/welfare-document-worker.heartbeat")


class ReadinessError(RuntimeError):
    pass


def check_ready(settings=None):
    settings = settings or get_settings()
    try:
        with closing(connect(settings)) as conn:
            conn.set_session(readonly=True)
            with conn, conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '5s'")
                cur.execute("SELECT 1")
                cur.fetchone()
                if settings.documents_enabled:
                    cur.execute("SELECT public.welfare_document_processing_contract()")
                    if cur.fetchone()[0] != "automatic-v1":
                        raise ValueError
    except Exception:
        raise ReadinessError("database_or_document_schema_not_ready") from None
    try:
        LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir).model_files()
    except Exception:
        raise ReadinessError("reranker_cache_not_ready") from None
    try:
        response = httpx.get(settings.ollama_base_url.rstrip("/") + "/api/tags", timeout=5)
        response.raise_for_status()
        names = {row["name"] for row in response.json()["models"]}
        for model in (settings.ollama_llm, settings.ollama_embed):
            if model not in names and (":" in model or model + ":latest" not in names):
                raise ValueError
    except Exception:
        raise ReadinessError("ollama_models_not_ready") from None
    return {"status": "ready", "database": "connected", "models": "present",
            "reranker": "cache_ready", "inference_checked": False}


def worker_heartbeat():
    WORKER_HEARTBEAT.touch()


def main():
    try:
        if sys.argv[1:] == ["worker"]:
            max_age = max(180, get_settings().documents_poll_seconds * 3)
            if time.time() - WORKER_HEARTBEAT.stat().st_mtime > max_age:
                raise ReadinessError("worker_heartbeat_stale")
        elif sys.argv[1:] == ["api"]:
            with urlopen("http://127.0.0.1:8000/health/ready", timeout=18) as response:
                if response.status != 200:
                    raise ReadinessError("api_not_ready")
        else:
            raise ReadinessError("invalid_healthcheck")
    except Exception:
        print("service_not_ready", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
