"""로컬 접수와 TEST_ 문서만 사용하는 실제 Docling·Postgres·모델 검증."""

import argparse
import json
import math
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from uuid import uuid4

import psycopg2
from psycopg2.extensions import parse_dsn
from fastapi.testclient import TestClient

from BackEnd.core.settings import Settings, get_settings
from BackEnd.core.db import connect
from BackEnd.documents import api, worker
from BackEnd.documents import auth
from BackEnd.documents.auth import require_document_admin
from BackEnd.documents.contracts import DocumentError, stable_hash
from BackEnd.documents.indexing import document_children
from BackEnd.documents.store import DocumentStore, get_document_store
from BackEnd.main import app
from BackEnd.rag.evidence import read_chunk, validate_version
from BackEnd.rag.chat import ordered_sentences
from BackEnd.rag.repository import PgServiceRepository
from BackEnd.rag.reranker import LocalReranker

ROOT = Path(__file__).resolve().parents[2]
SERVICE = "TEST_DOCLING_MD_01"
USE_SUPABASE = False


def local_connection():
    if USE_SUPABASE:
        settings = get_settings()
        parts = parse_dsn(settings.database_url.get_secret_value())
        ref = "prnnxajhbtvrxuaejihy"
        host, user = parts.get("host", ""), parts.get("user", "")
        assert host == "db." + ref + ".supabase.co" or host.endswith(".pooler.supabase.com") and user.endswith("." + ref)
        return connect(settings)
    # 격리된 검증 DB만 사용하며 실제 .env나 임의 DSN은 받지 않는다.
    return psycopg2.connect(host="127.0.0.1", port=15433, dbname="document_check", user="document_check",
                            password="document-check-only", connect_timeout=5)


def official_snapshot(cur):
    values = []
    for table, key in (("welfare_services", "service_id"), ("welfare_chunks", "chunk_id")):
        cur.execute(f"SELECT count(*),md5(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY {key})) FROM {table} t WHERE left(service_id,5)<>'TEST_'")
        values.append(cur.fetchone())
    return values


def bootstrap():
    with local_connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT current_database(),to_regclass('public.welfare_services')")
        database, table = cur.fetchone()
        if not USE_SUPABASE:
            assert database == "document_check"
        if table is None and not USE_SUPABASE:
            cur.execute((ROOT / "BackEnd/db/schema.sql").read_text(encoding="utf-8"))
            cur.execute("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; "
                        "CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)")
            cur.execute((ROOT / "BackEnd/db/migrations/0001_document_ingestion.sql").read_text(encoding="utf-8"))
        cur.execute("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rag_documents' AND column_name='original_bytes')")
        if not cur.fetchone()[0]:
            assert not USE_SUPABASE, "apply reviewed 0002 migration before cloud testing"
            cur.execute((ROOT / "BackEnd/db/migrations/0002_document_postgres_artifacts.sql").read_text(encoding="utf-8"))
        baseline = official_snapshot(cur)
        cur.execute("INSERT INTO welfare_services(service_id,name,summary,ministry,url) VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (SERVICE, "모의 별빛학습꾸러미", "개발 검증 전용 가상 자료", "가상 검증", "https://example.invalid/docling-test"))
        return baseline


def docker_analysis(path, config, settings, progress):
    progress("parsing")
    folder = Path(path).parent
    (folder / "config.json").write_text(json.dumps(config), encoding="utf-8")
    program = (
        "import json;from pathlib import Path;from BackEnd.core.settings import Settings;"
        "from BackEnd.documents.analysis import analyze_file;"
        "r=analyze_file(Path('/check/source.md'),json.loads(Path('/check/config.json').read_text()),Settings(_env_file=None));"
        "Path('/check/analysis.json').write_text(json.dumps(r,ensure_ascii=False),encoding='utf-8')"
    )
    command = ["docker", "run", "--rm", "--name", "welfare-document-check-parser-" + uuid4().hex[:8], "--cpus", "2", "--memory", "4g",
               "-v", f"{folder.as_posix()}:/check", "-v", f"{(ROOT / 'BackEnd').as_posix()}:/app/BackEnd:ro",
               "welfare_helper-document-worker", "python", "-c", program]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=7500)
    if result.returncode:
        raise RuntimeError("Docling container: " + result.stderr[-4000:])
    return json.loads((folder / "analysis.json").read_text(encoding="utf-8"))


def perform_job(store, expected):
    job = store.claim(300, SERVICE)
    assert job and job["kind"] == expected
    stop = threading.Event()

    def heartbeat():
        while not stop.wait(10):
            if not store.heartbeat(str(job["id"]), str(job["lease_token"]), 300):
                return

    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="document-check-source-") as folder:
            worker.process_job(str(job["id"]), str(job["lease_token"]), folder)
    finally:
        stop.set()
        thread.join()
    return job


def check_recovery(client, did, store, analysis, request, settings, tokenizer, report):
    previous, _ = store.status(did)
    queued = client.post(f"/api/v1/admin/documents/{did}/index", json={**request, "reindex_revision": "recovery-check"})
    assert queued.status_code == 202, queued.text
    first = store.claim(300, SERVICE)
    with local_connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE rag_document_jobs SET lease_until=now()-interval '1 second' WHERE id=%s", (str(first["id"]),))
    try:
        store.stage(str(first["id"]), str(first["lease_token"]), "expired_worker")
        raise AssertionError("expired lease accepted")
    except DocumentError as error:
        assert str(error) == "job_lease_lost"
    store.fail(str(first["id"]), str(first["lease_token"]), "expired_worker_failure")
    assert store.job_state(str(first["id"])) == "running"
    current = store.claim(300, SERVICE)
    assert current["id"] == first["id"] and current["lease_token"] != first["lease_token"]
    digest = store.progress(str(previous["active_job_id"]))["embed_digest"]
    children = document_children(current["document"], current["payload"], analysis, store.service_name(SERVICE), digest,
                                 tokenizer.count_tokens, settings.rerank_model + "@" + settings.rerank_revision)
    hashes = {c.chunk_id: stable_hash(c.embedding_text().encode()) for c in children}
    reused = store.reused_vectors(settings.ollama_embed, digest, list(hashes.values()))
    vectors = {cid: reused[key] for cid, key in hashes.items()}
    try:
        store.save_vectors(str(first["id"]), str(first["lease_token"]), "fault-check", did, children, vectors, settings.ollama_embed, digest)
        raise AssertionError("old worker wrote vectors")
    except DocumentError as error:
        assert str(error) == "job_lease_lost"
    store.save_vectors(str(current["id"]), str(current["lease_token"]), "fault-check", did, children, vectors, settings.ollama_embed, digest)
    try:
        store.activate(str(current["id"]), str(current["lease_token"]), "fault-check",
                       {"service_name": store.service_name(SERVICE), "chunks": len(children) + 1})
        raise AssertionError("incomplete staged version activated")
    except DocumentError as error:
        assert str(error) == "staged_chunk_count_mismatch"
    unchanged, _ = store.status(did)
    assert unchanged["active_job_id"] == previous["active_job_id"] and unchanged["active"]
    store.fail(str(current["id"]), str(current["lease_token"]), "test_fault_after_staging")
    with local_connection() as conn, conn.cursor() as cur:
        cur.execute("UPDATE rag_document_jobs SET available_at=now() WHERE id=%s", (str(current["id"]),))
    last = store.claim(300, SERVICE)
    assert last["attempts"] == 3
    store.fail(str(last["id"]), str(last["lease_token"]), "test_fault_after_staging")
    assert store.job_state(str(last["id"])) == "failed"
    retry = client.post(f"/api/v1/admin/documents/{did}/retry")
    assert retry.status_code == 202, retry.text
    done = perform_job(store, "index")
    active, _ = store.status(did)
    assert active["active_job_id"] == done["id"] and store.job_state(str(done["id"])) == "succeeded"
    report.update(expired_worker_rejected=True, failed_activation_preserves_previous=True, explicit_retry_succeeded=True)


def check_answers(client, did, chunks, report, result_file, rounds, case=None):
    parents = {c.chunk_id: c.parent_text for c in chunks if c.parent_text}
    cases = [
        ("자료 상자는 몇 개를 얼마나 자주 받나요?", [r"상자.*(?:두 개|수량: 2)", r"한 번|1회"], ["매월 반복해서 제공하지 않는다"]),
        ("상자 안 읽기 카드는 몇 장인가요?", [r"읽기 카드", r"일곱|7", r"장/상자|상자 한 개"], ["장/상자", "일곱 개의 상자를 제공한다는 뜻이 아니다"]),
        ("A코드 활성인데 B코드 정지면 참여할 수 있나요?", ["B코드가 정지", "A코드가 활성", "제외"], ["테스트구역", "A코드가 활성"]),
        ("신청 순서가 어떻게 되나요?", [r"접수|검토|승인번호", r"첫 단계|두 번째 단계|마지막 단계|단계 순서"], ["접수 기록, 검토, 승인번호 발급", "실제 방문 장소", "정하지 않았다"]),
        ("실제 지원 금액은 얼마인가요?", None, []),
    ]
    if case is not None:
        cases = [cases[case - 1]]
    report["answers"], failures = [], []
    for repeat in range(rounds):
        for question, selection_terms, answer_terms in cases:
            response = client.post(f"/api/v1/admin/documents/{did}/query", json={"query": question})
            body = response.json()
            answer, diagnostics = body.get("response", {}), body.get("diagnostics", {})
            selected = [ordered_sentences(parents[row["chunk_id"]])[row["sentence_index"]]
                        for row in diagnostics.get("selected_sentences", [])]
            selected_text = " ".join(selected)
            if selection_terms is None:
                passed = response.status_code == 200 and answer.get("kind") == "fallback" and answer.get("reason") == "insufficient_evidence"
            else:
                passed = (response.status_code == 200 and answer.get("kind") == "answer"
                          and all(re.search(pattern, selected_text) for pattern in selection_terms)
                          and all(term in answer.get("text", "") for term in answer_terms)
                          and "가상 검증 자료" in answer.get("text", "")
                          and not diagnostics.get("unanswered_intents") and not diagnostics.get("input_truncated"))
            row = {"round": repeat + 1, "query": question, "passed": passed, "selected_text": selected_text,
                   "http_status": response.status_code, "body": body}
            report["answers"].append(row)
            result_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"round": repeat + 1, "query": question, "passed": passed,
                              "reason": answer.get("reason"), "selected_text": selected_text,
                              "generation": diagnostics.get("generation_metadata")}, ensure_ascii=False), flush=True)
            if not passed:
                failures.append(f"round {repeat + 1}: {question}")
    report["answer_checks"] = {"passed": len(report["answers"]) - len(failures), "total": len(report["answers"]), "failures": failures}
    result_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    assert not failures, failures


def run(fixture: Path, result_file: Path, document_id=None, rounds=2, case=None, supabase=False, skip_answers=False):
    global USE_SUPABASE
    USE_SUPABASE = supabase
    baseline = bootstrap()
    settings = Settings(_env_file=None, documents_enabled=True, documents_local_mode=True, ollama_base_url="http://127.0.0.1:11435",
                        ollama_llm="qwen2.5:1.5b-instruct", ollama_timeout=600, llm_num_ctx=16384,
                        rerank_cache_dir=str(ROOT / ".reranker_cache"))
    store = DocumentStore(local_connection)
    with TestClient(app, base_url="http://127.0.0.1:8000", client=("127.0.0.1", 50000)) as client:
        api.get_settings = lambda: settings
        auth.get_settings = lambda: settings
        worker.get_settings = lambda: settings
        worker.get_document_store = lambda: store
        worker.analyze_file = docker_analysis
        app.dependency_overrides[get_document_store] = lambda: store
        if document_id:
            repo = PgServiceRepository(local_connection, documents_enabled=True, document_scope=document_id)
            report = {"model": settings.ollama_llm, "llm_num_ctx": settings.llm_num_ctx, "query_only": True, "document_id": document_id}
            try:
                check_answers(client, document_id, repo.snapshot().chunks, report, result_file, rounds, case)
            finally:
                app.dependency_overrides.clear()
            return
        metadata = {"service_id": SERVICE, "name": "가상 Docling 검증 문서", "source_url": "https://example.invalid/docling-test",
                    "basis_year": "2026", "test_only": True, "edition": "TEST-" + uuid4().hex[:8]}
        report = {"isolation": "TEST_ / test_only; real Postgres artifacts; real local HTTP gate; no Auth/Storage key",
                  "supabase": supabase,
                  "model": settings.ollama_llm, "llm_num_ctx": settings.llm_num_ctx}
        started = time.monotonic()
        try:
            upload = client.post("/api/v1/admin/documents", files={"file": (fixture.name, fixture.read_bytes(), "text/markdown")},
                                 data={"metadata": json.dumps(metadata, ensure_ascii=False)})
            assert upload.status_code == 202, upload.text
            did = upload.json()["id"]
            perform_job(store, "analyze")
            status = client.get(f"/api/v1/admin/documents/{did}", params={"limit": 200})
            assert status.status_code == 200, status.text
            analysis = status.json()["analysis"]
            assert not analysis["blockers"], analysis["blockers"]
            extracted = "\n".join(b["text"] for b in analysis["blocks"])
            for marker in ("BORDER-EXCEPTION-73", "TABLE-UNIT-29", "MISSING-DETAIL-41", "END-PROVENANCE-58"):
                assert marker in extracted
            assert "장/상자" in extracted and "B코드가 정지" in extracted
            markdown = client.get(f"/api/v1/admin/documents/{did}/markdown")
            assert markdown.status_code == 200 and "TABLE-UNIT-29" in markdown.text and "BORDER-EXCEPTION-73" in markdown.text
            assert DocumentStore(local_connection).analysis_data(did)["markdown"] == markdown.text
            assert DocumentStore(local_connection).original(did, 20*1024*1024) == fixture.read_bytes()
            report.update(markdown_characters=len(markdown.text), artifacts_reloaded_from_database=True)
            sections = {key: [] for key in ("target", "criteria", "benefit", "application")}
            current = "target"
            for block in analysis["blocks"]:
                if block["label"] == "section_header":
                    if "3." in block["text"]:
                        current = "benefit"
                    elif "4." in block["text"] or "5." in block["text"]:
                        current = "application"
                section = "criteria" if "단, B코드가 정지" in block["text"] else current
                sections[section].append(block["id"])
            request = {"analysis_hash": analysis["hash"], "sections": sections, "excluded_blocks": {},
                       "confirm_complete": True, "confirm_source_and_service": True, "review_note": "가상 원문 전체와 표 단위 및 제외 문장을 대조했습니다."}
            index = client.post(f"/api/v1/admin/documents/{did}/index", json=request)
            assert index.status_code == 202, index.text
            first_job = perform_job(store, "index")
            doc, jobs = store.status(did)
            result = next(j["result"] for j in jobs if str(j["id"]) == str(first_job["id"]))
            tokenizer = LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir)
            with local_connection() as conn, conn.cursor() as cur:
                cur.execute("SELECT chunk_id,content,embedding::text,embed_digest FROM rag_document_chunks WHERE job_id=%s ORDER BY chunk_id", (str(first_job["id"]),))
                rows = cur.fetchall()
            chunks = [read_chunk(cid, SERVICE, content, "") for cid, content, _, _ in rows]
            validate_version(chunks)
            parents = {c.chunk_id: c.parent_text for c in chunks if c.parent_text}
            overlaps = []
            for section in sections:
                ordered = sorted((c for c in chunks if c.section == section), key=lambda c: c.ordinal)
                for left, right in zip(ordered, ordered[1:]):
                    if right.start < left.end:
                        overlap = parents[left.parent_id][right.start:left.end]
                        overlaps.append({"characters": len(overlap), "tokens": tokenizer.count_tokens(overlap)})
                        assert len(overlap) <= 80 and tokenizer.count_tokens(overlap) <= 40
            for chunk in chunks:
                assert parents[chunk.parent_id][chunk.start:chunk.end] == chunk.text
                assert len(chunk.text) <= 800 and tokenizer.count_tokens(chunk.embedding_text()) <= 400
                assert not chunk.official and chunk.usable_detail and chunk.test_only
            vectors = [json.loads(row[2]) for row in rows]
            assert len(vectors) == len(chunks) == result["chunks"]
            assert all(len(v) == 1024 and all(math.isfinite(x) for x in v) and any(v) for v in vectors)
            report.update(document_id=did, analysis_blocks=len(analysis["blocks"]), analysis_characters=len(extracted),
                          table_count=sum(b["label"] == "table" for b in analysis["blocks"]), active_chunks=len(chunks),
                          target_children=sum(c.section == "target" for c in chunks), max_body_characters=max(len(c.text) for c in chunks),
                          max_embedding_tokens=max(tokenizer.count_tokens(c.embedding_text()) for c in chunks),
                          overlaps=overlaps, embed_digest=result["embed_digest"], first_embedded=result["embedded"])
            duplicate = client.post("/api/v1/admin/documents", files={"file": (fixture.name, fixture.read_bytes(), "text/markdown")},
                                    data={"metadata": json.dumps(metadata, ensure_ascii=False)})
            assert duplicate.status_code == 202 and duplicate.json()["id"] == did
            reindex = client.post(f"/api/v1/admin/documents/{did}/index", json={**request, "reindex_revision": "reuse-check"})
            assert reindex.status_code == 202, reindex.text
            reused_job = perform_job(store, "index")
            _, jobs = store.status(did)
            reused = next(j["result"] for j in jobs if str(j["id"]) == str(reused_job["id"]))
            assert reused["embedded"] == 0 and reused["reused"] == len(chunks)
            report["reindex_embedded"] = reused["embedded"]
            check_recovery(client, did, store, analysis, request, settings, tokenizer, report)
            public = PgServiceRepository(local_connection, documents_enabled=True).snapshot()
            assert not any(c.document_id == did for c in public.chunks)
            report["excluded_from_public_corpus"] = True
            report["semantic_search"] = []
            for question, expected in [("B코드가 정지인 경우 제외 조건", "BORDER-EXCEPTION-73"),
                                       ("상자별 읽기 카드 수량과 단위", "TABLE-UNIT-29"),
                                       ("문서 끝과 버전 원문 추적", "END-PROVENANCE-58")]:
                response = client.post(f"/api/v1/admin/documents/{did}/search", json={"query": question})
                assert response.status_code == 200, response.text
                hits = response.json()["chunks"]
                rank = next((i + 1 for i, hit in enumerate(hits) if expected in hit["text"]), None)
                assert rank is not None and rank <= 6, (question, rank)
                report["semantic_search"].append({"query": question, "marker_rank": rank, "top_similarity": hits[0]["similarity"]})
            result_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            active = PgServiceRepository(local_connection, documents_enabled=True, document_scope=did).snapshot().chunks
            with local_connection() as conn, conn.cursor() as cur:
                assert official_snapshot(cur) == baseline, "existing official data changed"
            report["official_data_preserved"] = True
            if skip_answers:
                report["answer_checks"] = {"executed": False}
            else:
                check_answers(client, did, active, report, result_file, rounds, case)
            report["seconds"] = round(time.monotonic() - started, 2)
            result_file.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({k: v for k, v in report.items() if k not in {"answers", "semantic_search"}}, ensure_ascii=False))
        finally:
            app.dependency_overrides.clear()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--document-id", help="같은 격리 DB의 활성 문서만 재질의한다. 분석/Storage 검증은 재실행하지 않는다.")
    parser.add_argument("--rounds", type=int, choices=range(1, 4), default=2)
    parser.add_argument("--case", type=int, choices=range(1, 6), help="실패 진단용 단일 문항. 전체 검증에서는 생략한다.")
    parser.add_argument("--supabase", action="store_true", help="확인된 welfare_helper 프로젝트의 TEST_ 전용 자료만 사용한다. DDL은 실행하지 않는다.")
    parser.add_argument("--skip-answers", action="store_true", help="마이그레이션·저장 검사 전용. Qwen 답변 검증은 실행하지 않는다.")
    args = parser.parse_args()
    run(args.fixture, args.result, args.document_id, args.rounds, args.case, args.supabase, args.skip_answers)
