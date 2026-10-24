import json
from contextlib import closing
from datetime import datetime, timezone
from uuid import uuid4

from psycopg2.extras import Json, RealDictCursor, execute_values

from BackEnd.core.db import connect
from BackEnd.core.settings import get_settings
from BackEnd.documents.contracts import DocumentError, PARSER_VERSION, stable_hash
from BackEnd.rag.embeddings import validate_embeddings
from BackEnd.rag.evidence import active_chunks, read_chunk, validate_version


def api_policy(cur, service_id: str) -> dict:
    cur.execute("SELECT chunk_id,content FROM welfare_chunks WHERE service_id=%s ORDER BY chunk_id", (service_id,))
    rows = cur.fetchall()
    chunks = active_chunks([read_chunk(row[0], service_id, row[1], "") for row in rows])
    official = [c for c in chunks if c.official]
    return {"hash": stable_hash([c.storage() for c in official]) if official else "",
            "years": sorted({c.basis_year for c in official})}


class DocumentStore:
    def __init__(self, connection_factory):
        self.connect = connection_factory

    @staticmethod
    def _admin(cur, actor):
        cur.execute("SELECT 1 FROM rag_document_admins WHERE user_id=%s AND active FOR SHARE", (actor,))
        if not cur.fetchone():
            raise DocumentError("admin_permission_required")

    def is_admin(self, actor):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM rag_document_admins WHERE user_id=%s AND active", (actor,))
            return bool(cur.fetchone())

    def register(self, metadata: dict, file_hash: str, size: int, suffix: str, actor: str, config: dict) -> dict:
        identity = stable_hash([metadata, file_hash, PARSER_VERSION, config])
        document_id = str(uuid4())
        key = f"originals/{document_id}/{file_hash}.{suffix}"
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            self._admin(cur, actor)
            cur.execute("SELECT service_id FROM welfare_services WHERE service_id=%s FOR SHARE", (metadata["service_id"],))
            if not cur.fetchone():
                raise DocumentError("linked_service_not_found")
            cur.execute("INSERT INTO rag_documents(id,service_id,name,source_url,basis_year,source_updated_at,file_hash,file_size,suffix,"
                        "object_key,parser_version,parse_config,dedupe_key,uploaded_by,test_only) VALUES "
                        "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                        "ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING *",
                        (document_id, metadata["service_id"], metadata["name"], metadata["source_url"], metadata["basis_year"],
                         metadata.get("source_updated_at"), file_hash, size, suffix, key, PARSER_VERSION, Json(config), identity, actor,
                         metadata["test_only"]))
            return dict(cur.fetchone())

    @staticmethod
    def _queue(cur, document_id, kind, key, payload, actor):
        cur.execute("SELECT * FROM rag_document_jobs WHERE document_id=%s AND kind=%s AND input_key=%s",
                    (document_id, kind, key))
        existing = cur.fetchone()
        if existing:
            return dict(existing)
        cur.execute("SELECT 1 FROM rag_document_jobs WHERE document_id=%s AND state IN ('queued','running')", (document_id,))
        if cur.fetchone():
            raise DocumentError("document_job_already_pending")
        job_id = str(uuid4())
        cur.execute("INSERT INTO rag_document_jobs(id,document_id,kind,input_key,payload,created_by) "
                    "VALUES(%s,%s,%s,%s,%s,%s) RETURNING *", (job_id, document_id, kind, key, Json(payload), actor))
        job = dict(cur.fetchone())
        cur.execute("UPDATE rag_documents SET status=%s WHERE id=%s", (kind + "_queued", document_id))
        return job

    def queue_analysis(self, document_id, actor):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            self._admin(cur, actor)
            cur.execute("SELECT * FROM rag_documents WHERE id=%s FOR UPDATE", (document_id,))
            doc = cur.fetchone()
            if not doc:
                raise DocumentError("document_not_found")
            return self._queue(cur, document_id, "analyze", stable_hash([doc["file_hash"], doc["parser_version"], doc["parse_config"]]), {}, actor)

    def upload_failed(self, document_id):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("UPDATE rag_documents SET status='upload_failed' WHERE id=%s AND status='uploading' AND NOT active",
                        (document_id,))

    def status(self, document_id):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM rag_documents WHERE id=%s", (document_id,))
            doc = cur.fetchone()
            if not doc:
                raise DocumentError("document_not_found")
            cur.execute("SELECT id,kind,state,attempts,error_code,result,created_at,finished_at FROM rag_document_jobs "
                        "WHERE document_id=%s ORDER BY created_at DESC LIMIT 20", (document_id,))
            return dict(doc), [dict(row) for row in cur.fetchall()]

    def analysis_result(self, document_id):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT j.* FROM rag_documents d JOIN rag_document_jobs j ON j.id=d.analysis_job_id "
                        "WHERE d.id=%s AND j.state='succeeded'", (document_id,))
            row = cur.fetchone()
            if not row:
                raise DocumentError("analysis_not_ready")
            return dict(row)

    def policy(self, service_id):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            return api_policy(cur, service_id)

    def queue_index(self, document_id, actor, request: dict, analysis_job_id, analysis_hash):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            self._admin(cur, actor)
            cur.execute("SELECT * FROM rag_documents WHERE id=%s FOR UPDATE", (document_id,))
            doc = cur.fetchone()
            if not doc or str(doc["analysis_job_id"]) != str(analysis_job_id):
                raise DocumentError("analysis_version_changed")
            cur.execute("SELECT result FROM rag_document_jobs WHERE id=%s AND state='succeeded'", (analysis_job_id,))
            row = cur.fetchone()
            if not row or row["result"].get("analysis_hash") != analysis_hash:
                raise DocumentError("analysis_version_changed")
            # API 원문 조회는 튜플 커서를 사용해 JSON/정책 비교 경계를 명확히 한다.
            with conn.cursor() as policy_cur:
                policy = api_policy(policy_cur, doc["service_id"])
            if policy["hash"] and (policy["years"] != [doc["basis_year"]]
                    or request["reconciled_api_version"] != policy["hash"] or len(request["reconciliation_note"].strip()) < 10):
                raise DocumentError("source_conflict_review_required")
            identity = stable_hash([analysis_hash, request])
            cur.execute("SELECT active_job_id FROM rag_documents WHERE service_id=%s AND active", (doc["service_id"],))
            current = cur.fetchone()
            payload = {"review": request, "analysis_job_id": str(analysis_job_id), "analysis_hash": analysis_hash,
                       "reviewed_by": actor, "reviewed_at": datetime.now(timezone.utc).isoformat(),
                       "api_policy": policy, "previous_active_job": str(current["active_job_id"]) if current else ""}
            return self._queue(cur, document_id, "index", identity, payload, actor)

    def retry(self, document_id, actor):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            self._admin(cur, actor)
            cur.execute("SELECT id FROM rag_documents WHERE id=%s FOR UPDATE", (document_id,))
            if not cur.fetchone():
                raise DocumentError("document_not_found")
            cur.execute("SELECT id,kind FROM rag_document_jobs WHERE document_id=%s AND state='failed' "
                        "ORDER BY created_at DESC LIMIT 1 FOR UPDATE", (document_id,))
            row = cur.fetchone()
            if not row:
                raise DocumentError("failed_job_not_found")
            cur.execute("SELECT 1 FROM rag_document_jobs WHERE document_id=%s AND state IN ('queued','running')", (document_id,))
            if cur.fetchone():
                raise DocumentError("document_job_already_pending")
            cur.execute("UPDATE rag_document_jobs SET state='queued',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,"
                        "error_code=NULL WHERE id=%s", (row["id"],))
            cur.execute("UPDATE rag_documents SET status=%s WHERE id=%s", (row["kind"] + "_queued", document_id))
            return str(row["id"])

    def claim(self, seconds: int):
        token = str(uuid4())
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("WITH failed AS (UPDATE rag_document_jobs SET state='failed',error_code='lease_expired_after_max_attempts',"
                        "lease_token=NULL,lease_until=NULL WHERE state='running' AND lease_until<now() AND attempts>=3 "
                        "RETURNING document_id,kind) UPDATE rag_documents d SET status=failed.kind||'_failed' FROM failed WHERE d.id=failed.document_id")
            cur.execute("SELECT j.* FROM rag_document_jobs j WHERE j.attempts<3 AND j.available_at<=now() "
                        "AND (j.state='queued' OR (j.state='running' AND j.lease_until<now())) "
                        "AND NOT EXISTS(SELECT 1 FROM rag_document_jobs other WHERE other.document_id=j.document_id "
                        "AND other.id<>j.id AND other.state='running' AND other.lease_until>=now()) "
                        "ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1")
            row = cur.fetchone()
            if not row:
                return None
            cur.execute("UPDATE rag_document_jobs SET state='running',attempts=attempts+1,lease_token=%s,"
                        "lease_until=now()+%s*interval '1 second',error_code=NULL WHERE id=%s RETURNING *", (token, seconds, row["id"]))
            job = dict(cur.fetchone())
            cur.execute("SELECT * FROM rag_documents WHERE id=%s", (job["document_id"],))
            job["document"] = dict(cur.fetchone())
            cur.execute("UPDATE rag_documents SET status=%s WHERE id=%s", ("analyzing" if job["kind"] == "analyze" else "indexing", job["document_id"]))
            return job

    def claimed_job(self, job_id, token):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            job = dict(self._lease(cur, job_id, token))
            self._admin(cur, job["created_by"])
            cur.execute("SELECT * FROM rag_documents WHERE id=%s", (job["document_id"],))
            job["document"] = dict(cur.fetchone())
            return job

    def stage(self, job_id, token, stage, **values):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("UPDATE rag_document_jobs SET result=result||%s WHERE id=%s AND lease_token=%s AND state='running' AND lease_until>now()",
                        (Json({"stage": stage, **values}), job_id, token))
            if cur.rowcount != 1:
                raise DocumentError("job_lease_lost")

    def progress(self, job_id):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("SELECT result FROM rag_document_jobs WHERE id=%s", (job_id,))
            row = cur.fetchone()
            return row[0] if row else {}

    def job_state(self, job_id):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("SELECT state FROM rag_document_jobs WHERE id=%s", (job_id,))
            row = cur.fetchone()
            return row[0] if row else None

    def service_name(self, service_id):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("SELECT name FROM welfare_services WHERE service_id=%s", (service_id,))
            row = cur.fetchone()
            if not row:
                raise DocumentError("linked_service_not_found")
            return row[0]

    @staticmethod
    def _lease(cur, job_id, token):
        cur.execute("SELECT * FROM rag_document_jobs WHERE id=%s AND lease_token=%s AND state='running' "
                    "AND lease_until>now() FOR UPDATE", (job_id, token))
        job = cur.fetchone()
        if not job:
            raise DocumentError("job_lease_lost")
        return job

    def heartbeat(self, job_id, token, seconds):
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("UPDATE rag_document_jobs SET lease_until=now()+%s*interval '1 second' "
                        "WHERE id=%s AND lease_token=%s AND state='running' AND lease_until>now()", (seconds, job_id, token))
            return cur.rowcount == 1

    def fail(self, job_id, token, code):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM rag_document_jobs WHERE id=%s AND lease_token=%s AND state='running' AND lease_until>now() FOR UPDATE", (job_id, token))
            job = cur.fetchone()
            if not job:
                return
            state = "queued" if job["attempts"] < 3 else "failed"
            cur.execute("UPDATE rag_document_jobs SET state=%s,error_code=%s,lease_token=NULL,lease_until=NULL,"
                        "available_at=now()+%s*interval '1 second' WHERE id=%s", (state, code[:100], 30 * job["attempts"], job_id))
            cur.execute("UPDATE rag_documents SET status=%s WHERE id=%s", (job["kind"] + ("_queued" if state == "queued" else "_failed"), job["document_id"]))

    def finish_analysis(self, job_id, token, result):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            job = self._lease(cur, job_id, token)
            self._admin(cur, job["created_by"])
            cur.execute("UPDATE rag_document_jobs SET state='succeeded',result=%s,finished_at=now(),lease_token=NULL,lease_until=NULL "
                        "WHERE id=%s", (Json(result), job_id))
            cur.execute("UPDATE rag_documents SET analysis_job_id=%s,status=%s WHERE id=%s",
                        (job_id, "quality_blocked" if result["blockers"] else "review_required", job["document_id"]))

    def reused_vectors(self, model, digest, hashes):
        if not hashes:
            return {}
        with closing(self.connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("SELECT DISTINCT ON(input_hash) input_hash,embedding::text FROM rag_document_chunks "
                        "WHERE embed_model=%s AND embed_digest=%s AND input_hash=ANY(%s) ORDER BY input_hash", (model, digest, hashes))
            return {key: json.loads(vector) for key, vector in cur.fetchall()}

    def save_vectors(self, job_id, token, index_key, document_id, chunks, vectors, model, digest):
        validate_embeddings(list(vectors.values()), len(chunks), 1024)
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            job = self._lease(cur, job_id, token)
            self._admin(cur, job["created_by"])
            if str(job["document_id"]) != str(document_id):
                raise DocumentError("job_document_mismatch")
            execute_values(cur, "INSERT INTO rag_document_chunks(job_id,index_key,document_id,chunk_id,service_id,content,"
                           "embedding,embed_model,embed_digest,input_hash) VALUES %s ON CONFLICT(job_id,index_key,chunk_id) "
                           "DO UPDATE SET content=EXCLUDED.content,embedding=EXCLUDED.embedding,embed_model=EXCLUDED.embed_model,"
                           "embed_digest=EXCLUDED.embed_digest,input_hash=EXCLUDED.input_hash",
                           [(job_id, index_key, document_id, c.chunk_id, c.service_id, c.storage(),
                             "[" + ",".join(str(v) for v in vectors[c.chunk_id]) + "]", model, digest, stable_hash(c.embedding_text().encode())) for c in chunks],
                           template="(%s,%s,%s,%s,%s,%s,%s::vector,%s,%s,%s)")

    def activate(self, job_id, token, index_key, result):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            job = self._lease(cur, job_id, token)
            self._admin(cur, job["created_by"])
            cur.execute("SELECT * FROM rag_documents WHERE id=%s FOR UPDATE", (job["document_id"],))
            doc = cur.fetchone()
            cur.execute("SELECT name,url FROM welfare_services WHERE service_id=%s FOR UPDATE", (doc["service_id"],))
            service = cur.fetchone()
            if not service:
                raise DocumentError("linked_service_not_found")
            if service["name"] != result["service_name"]:
                raise DocumentError("linked_service_changed")
            with conn.cursor() as policy_cur:
                if api_policy(policy_cur, doc["service_id"]) != job["payload"]["api_policy"]:
                    raise DocumentError("api_source_changed")
            cur.execute("SELECT id,active_job_id,basis_year FROM rag_documents WHERE service_id=%s AND active FOR UPDATE", (doc["service_id"],))
            old = cur.fetchone()
            if (str(old["active_job_id"]) if old else "") != job["payload"]["previous_active_job"]:
                raise DocumentError("active_document_changed")
            if old and old["basis_year"] > doc["basis_year"]:
                raise DocumentError("older_basis_rejected")
            cur.execute("SELECT content,chunk_id,service_id FROM rag_document_chunks WHERE job_id=%s AND index_key=%s ORDER BY chunk_id", (job_id, index_key))
            rows = cur.fetchall()
            restored = [read_chunk(r["chunk_id"], r["service_id"], r["content"], "") for r in rows]
            validate_version(restored)
            if any(c.document_id != str(doc["id"]) or c.service_id != doc["service_id"]
                   or c.document_name != doc["name"] or c.source_url != doc["source_url"]
                   or c.basis_year != doc["basis_year"] or c.test_only != doc["test_only"]
                   or c.review_hash != stable_hash(job["payload"])
                   or c.analysis_hash != job["payload"]["analysis_hash"]
                   or c.reviewed_by != job["payload"]["reviewed_by"]
                   or c.reviewed_at != job["payload"]["reviewed_at"] for c in restored):
                raise DocumentError("staged_document_provenance_mismatch")
            if len(restored) != result["chunks"]:
                raise DocumentError("staged_chunk_count_mismatch")
            cur.execute("UPDATE rag_documents SET active=false WHERE service_id=%s AND active", (doc["service_id"],))
            cur.execute("UPDATE rag_document_jobs SET state='succeeded',result=%s,finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=%s", (Json(result), job_id))
            cur.execute("UPDATE rag_documents SET active=true,active_job_id=%s,status='indexed' WHERE id=%s", (job_id, doc["id"]))


def get_document_store():
    return DocumentStore(lambda: connect(get_settings()))
