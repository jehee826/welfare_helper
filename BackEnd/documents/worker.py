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
from BackEnd.documents.analysis import analyze_file, read_analysis
from BackEnd.documents.contracts import DocumentError, stable_hash, validate_file
from BackEnd.documents.indexing import document_children
from BackEnd.documents.storage import PrivateStorage
from BackEnd.documents.store import get_document_store


def process_job(job_id, token, temp_dir):
    settings, store = get_settings(), get_document_store()
    job = store.claimed_job(job_id, token)
    doc, storage = job["document"], PrivateStorage(settings)
    stage = lambda name, **values: store.stage(job_id, token, name, **values)
    if job["kind"] == "analyze":
        stage("fetching_original")
        original = storage.get(doc["object_key"], settings.documents_max_file_mb * 1024 * 1024)
        if stable_hash(original) != doc["file_hash"]:
            raise DocumentError("original_hash_mismatch")
        validate_file(original, doc["suffix"], settings.documents_max_file_mb * 1024 * 1024)
        path = Path(temp_dir) / ("source." + doc["suffix"])
        path.write_bytes(original)
        analysis = analyze_file(path, doc["parse_config"], settings, stage)
        content = json.dumps(analysis, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
        if len(content) > settings.documents_max_characters * 20 + 20 * 1024 * 1024:
            raise DocumentError("analysis_artifact_size_limit")
        digest = stable_hash(analysis)
        key = f"analyses/{doc['id']}/{job_id}/{digest}.json"
        stage("saving_analysis")
        storage.put(key, content, "application/json")
        store.finish_analysis(job_id, token, {"artifact_key": key, "analysis_hash": digest,
            "blockers": analysis["blockers"], "warnings": analysis["warnings"], "blocks": len(analysis["blocks"]), "pages": analysis["pages"]})
        return
    stage("validating_review")
    analysis_job, analysis = read_analysis(store, storage, str(doc["id"]), settings.documents_max_characters * 20 + 20 * 1024 * 1024)
    payload = job["payload"]
    if str(analysis_job["id"]) != payload["analysis_job_id"] or stable_hash(analysis) != payload["analysis_hash"]:
        raise DocumentError("analysis_version_changed")
    # Docling 분석과 관리자 검토를 확인한 뒤에만 tokenizer·임베딩 클라이언트를 만든다.
    from BackEnd.rag.ollama import OllamaClient
    from BackEnd.rag.reranker import LocalReranker

    llm = OllamaClient(settings.ollama_base_url, settings.ollama_embed, settings.ollama_llm,
                       settings.ollama_timeout, embed_dim=1024)
    digest = llm.model_digest()
    tokenizer = LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir)
    name = store.service_name(doc["service_id"])
    children = document_children(doc, payload, analysis, name, digest, tokenizer.count_tokens,
                                  settings.rerank_model + "@" + settings.rerank_revision)
    if len(children) > settings.documents_max_chunks:
        raise DocumentError("document_chunk_count_limit")
    index_key = stable_hash([payload, doc["file_hash"], doc["parser_version"], digest,
                            settings.ollama_embed, children[0].split_version])
    texts = {c.chunk_id: c.embedding_text() for c in children}
    hashes = {cid: stable_hash(text.encode()) for cid, text in texts.items()}
    cached = store.reused_vectors(settings.ollama_embed, digest, list(set(hashes.values())))
    embedded = 0
    stage("embedding", chunks=len(children), embedded=0, reused=sum(h in cached for h in hashes.values()))
    for start in range(0, len(children), 16):
        batch = children[start:start + 16]
        missing = list(dict.fromkeys(texts[c.chunk_id] for c in batch if hashes[c.chunk_id] not in cached))
        if missing:
            vectors = llm.embed(missing)
            cached.update((stable_hash(text.encode()), vector) for text, vector in zip(missing, vectors, strict=True))
            embedded += len(missing)
        store.save_vectors(job_id, token, index_key, str(doc["id"]), batch,
                           {c.chunk_id: cached[hashes[c.chunk_id]] for c in batch}, settings.ollama_embed, digest)
        stage("embedding", chunks=len(children), embedded=embedded, stored=min(start + 16, len(children)))
    if llm.model_digest() != digest:
        raise DocumentError("embedding_digest_changed")
    stage("activating")
    store.activate(job_id, token, index_key, {"index_key": index_key, "chunks": len(children),
        "embedded": embedded, "reused": len(children) - embedded, "embed_digest": digest,
        "analysis_hash": payload["analysis_hash"], "service_name": name})


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
    job_id, token = str(job["id"]), str(job["lease_token"])
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
                        if store.job_state(job_id) in {"succeeded", "failed", "queued"}:
                            child.wait(timeout=10)
                            break
                        raise DocumentError("job_lease_lost")
                    progress = store.progress(job_id)
                    current = progress.get("stage", "starting")
                    if current != phase:
                        phase, phase_started = current, now
                    cache_bytes = sum(p.stat().st_size for p in Path(settings.docling_cache_dir).rglob("*") if p.is_file())
                    print(json.dumps({"job_id": job_id, "stage": phase, "cache_bytes": cache_bytes}), flush=True)
                    heartbeat = now
                limit = (settings.documents_download_timeout if phase in {"starting", "downloading_models", "fetching_original"}
                         else settings.documents_parse_timeout if job["kind"] == "analyze" else settings.documents_index_timeout)
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
