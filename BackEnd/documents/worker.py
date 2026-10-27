"""DB의 lease로 작업을 복구하고 별도 프로세스에서 문서·모델을 처리한다."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from BackEnd.core.settings import get_settings
from BackEnd.documents.analysis import analyze_file
from BackEnd.documents.contracts import DocumentError, PARSER_VERSION, stable_hash, validate_file
from BackEnd.documents.indexing import document_children
from BackEnd.documents.store import get_document_store


def process_job(job_id, token, temp_dir):
    settings, store = get_settings(), get_document_store()
    job = store.claimed_job(job_id, token)
    doc = job["document"]

    def stage(name, **values):
        # 진행률은 수명이 짧은 worker 작업 디렉터리에만 두고 DB 설정에는 섞지 않는다.
        path = Path(temp_dir) / "progress.json"
        pending = path.with_suffix(".tmp")
        pending.write_text(json.dumps({"stage": name, **values}), encoding="utf-8")
        os.replace(pending, path)

    if job["state"] == "ready":
        config = job["chunk_config"]
        if (job["parser_version"] != PARSER_VERSION or config.get("embedding_model") != settings.ollama_embed
                or config.get("tokenizer_revision") != settings.rerank_model + "@" + settings.rerank_revision):
            raise DocumentError("index_settings_changed_create_new_job")
        stage("publishing")
        store.activate(job_id, token)
        return
    if job["parser_version"] != PARSER_VERSION:
        raise DocumentError("parser_version_changed_create_new_job")
    if job["state"] == "parsing":
        stage("fetching_original")
        original = bytes(job["candidate_original"] or b"")
        if stable_hash(original) != doc["file_sha256"]:
            raise DocumentError("original_hash_mismatch")
        validate_file(original, doc["file_format"], settings.documents_max_file_mb * 1024 * 1024)
        path = Path(temp_dir) / ("source." + doc["file_format"])
        path.write_bytes(original)
        analysis = analyze_file(path, job["parse_config"], settings, stage)
        content = json.dumps(analysis, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
        if len(content) > settings.documents_max_characters * 20 + 20 * 1024 * 1024:
            raise DocumentError("analysis_artifact_size_limit")
        stage("awaiting_review")
        store.finish_analysis(job_id, token, analysis)
        return
    stage("validating_review")
    analysis = job["candidate_analysis"]
    config = job["chunk_config"]
    payload = config.get("payload", {})
    revision = settings.rerank_model + "@" + settings.rerank_revision
    if (not analysis or stable_hash(analysis) != payload.get("analysis_hash")
            or analysis.get("markdown") != job["candidate_markdown"]):
        raise DocumentError("analysis_version_changed")
    if config.get("embedding_model") != settings.ollama_embed or config.get("tokenizer_revision") != revision:
        raise DocumentError("index_settings_changed_create_new_job")
    if doc["service_name"] != payload["service_name"]:
        raise DocumentError("linked_service_changed_create_new_job")
    # Docling 분석과 명시적 검토 이후에만 모델·tokenizer를 사용한다.
    from BackEnd.rag.ollama import OllamaClient
    from BackEnd.rag.reranker import LocalReranker

    llm = OllamaClient(settings.ollama_base_url, settings.ollama_embed, settings.ollama_llm,
                       settings.ollama_timeout, embed_dim=1024)
    digest = llm.model_digest()
    store.begin_embedding(job_id, token, settings.ollama_embed, digest)
    tokenizer = LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir)
    records = document_children(doc, payload, analysis, payload["service_name"], digest, tokenizer.count_tokens, revision)
    if not records or len(records) > settings.documents_max_chunks:
        raise DocumentError("document_chunk_count_limit")
    texts = {r["chunk"].chunk_id:r["chunk"].embedding_text() for r in records}
    hashes = {cid:stable_hash(text.encode()) for cid,text in texts.items()}
    cached = store.reused_vectors(settings.ollama_embed, digest, list(set(hashes.values())))
    embedded = 0
    stage("embedding", chunks=len(records), embedded=0)
    for start in range(0,len(records),16):
        batch = records[start:start+16]
        missing = list(dict.fromkeys(texts[r["chunk"].chunk_id] for r in batch
                                    if hashes[r["chunk"].chunk_id] not in cached))
        if missing:
            vectors = llm.embed(missing)
            cached.update((stable_hash(text.encode()),vector) for text,vector in zip(missing,vectors,strict=True))
            embedded += len(missing)
        store.save_vectors(job_id,token,str(doc["document_id"]),batch,
                           {r["chunk"].chunk_id:cached[hashes[r["chunk"].chunk_id]] for r in batch},
                           settings.ollama_embed,digest)
        stage("embedding",chunks=len(records),embedded=embedded,stored=min(start+16,len(records)))
    if llm.model_digest() != digest:
        raise DocumentError("embedding_digest_changed")
    stage("publishing")
    store.activate(job_id,token)


def stop_child(child):
    if child.poll() is not None:
        return
    if os.name == "posix":
        os.killpg(child.pid, signal.SIGTERM)
    else:
        child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name == "posix":
            os.killpg(child.pid, signal.SIGKILL)
        else:
            child.kill()
        child.wait()


def supervise(job, store, settings):
    job_id, token = str(job["job_id"]), str(job["lease_token"])
    with tempfile.TemporaryDirectory(prefix="document-job-") as temp:
        child = subprocess.Popen([sys.executable, "-m", "BackEnd.documents.worker", "--job", job_id,
                                  "--lease", token, "--temp-dir", temp], start_new_session=os.name == "posix",
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        phase, phase_started, heartbeat = "starting", time.monotonic(), 0.0
        try:
            while child.poll() is None:
                now = time.monotonic()
                if now - heartbeat >= settings.documents_lease_seconds / 3:
                    if not store.heartbeat(job_id, token, settings.documents_lease_seconds):
                        if store.job_state(job_id) in {"succeeded", "failed", "cancelled", "awaiting_review", None}:
                            child.wait(timeout=10)
                            break
                        raise DocumentError("job_lease_lost")
                    try:
                        progress = json.loads((Path(temp) / "progress.json").read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        progress = {}
                    current = progress.get("stage", "starting")
                    if current != phase:
                        phase, phase_started = current, now
                    cache_bytes = 0
                    for path in Path(settings.docling_cache_dir).rglob("*"):
                        try:
                            if path.is_file():
                                cache_bytes += path.stat().st_size
                        except OSError:
                            # 다운로드 중 파일 교체 때문에 실제 문서 작업을 실패시키지 않는다.
                            continue
                    print(json.dumps({"job_id": job_id, "stage": phase, "cache_bytes": cache_bytes}), flush=True)
                    heartbeat = now
                limit = (settings.documents_download_timeout if phase in {"starting", "downloading_models", "fetching_original"}
                         else settings.documents_parse_timeout if job["state"] == "parsing" else settings.documents_index_timeout)
                if now - phase_started > limit:
                    raise DocumentError("job_stage_timeout")
                time.sleep(1)
            if child.returncode:
                # 하위 프로세스는 공개 가능한 코드만 DB에 남긴다.
                store.fail(job_id, token, "worker_process_failed")
        except BaseException:
            stop_child(child)
            store.fail(job_id, token, "worker_interrupted_or_timeout")
            raise
        finally:
            stop_child(child)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job")
    parser.add_argument("--lease")
    parser.add_argument("--temp-dir")
    args = parser.parse_args()
    if args.job:
        try:
            process_job(args.job, args.lease, args.temp_dir)
            return 0
        except Exception as exc:
            code = str(exc) if isinstance(exc, DocumentError) else type(exc).__name__
            get_document_store().fail(args.job, args.lease, code)
            return 1
    settings = get_settings()
    def shutdown(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, shutdown)
    while True:
        if settings.documents_enabled:
            try:
                store = get_document_store()
                job = store.claim(settings.documents_lease_seconds)
                if job:
                    supervise(job, store, settings)
                    continue
            except Exception as exc:
                print(json.dumps({"worker_error": type(exc).__name__}), flush=True)
        time.sleep(settings.documents_poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
