from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import ValidationError
from pydantic import BaseModel, Field
from fastapi.responses import PlainTextResponse
from starlette.concurrency import run_in_threadpool

from BackEnd.core.settings import get_settings
from BackEnd.documents.auth import require_document_admin
from BackEnd.admin.session import AdminSession
from BackEnd.documents.analysis import read_analysis
from BackEnd.documents.contracts import DocumentError, DocumentMetadata, stable_hash, validate_file
from BackEnd.documents.store import get_document_store

router = APIRouter(prefix="/api/v1/admin/documents", tags=["관리자 문서"])


class DocumentQuery(BaseModel):
    query: str = Field(min_length=1, max_length=300)


@router.get("/processing", summary="자동 문서 처리 DB 계약 준비 상태")
def document_processing(actor=Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        return {"mode": "automatic", "ready": store.automatic_ready(), "human_review_required": False}
    except Exception as exc:
        document_failure(exc)


@router.get("/programs", summary="문서에 연결할 사전 등록 제도 조회")
def list_document_programs(test_only: bool | None = Query(default=None),
                           offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=200),
                           actor=Depends(require_document_admin), store=Depends(get_document_store)):
    """metadata.service_id와 test_only를 이 응답에서 확인한다. 문서 업로드는 제도를 자동 등록하지 않는다."""
    try:
        return store.programs(test_only,offset,limit)
    except Exception as exc:
        document_failure(exc)


def scoped_repository(store, document_id):
    from BackEnd.rag.repository import PgServiceRepository

    settings = get_settings()
    doc, _ = store.status(str(document_id))
    if not doc["active_job_id"]:
        raise DocumentError("document_not_published")
    return PgServiceRepository(store.connect, settings.ollama_embed, settings.embed_dim,
                               documents_enabled=True, document_scope=str(document_id))


@router.post("/{document_id}/search")
def search_document(document_id: UUID, request: DocumentQuery, actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        from BackEnd.rag.factory import build_chat_service

        repo = scoped_repository(store, document_id)
        service = build_chat_service(repo, get_settings())
        snapshot = repo.snapshot()
        digest = service.llm.model_digest()
        ids = [c.chunk_id for c in snapshot.chunks if c.embed_digest == digest]
        results = repo.dense_search(service.llm.embed([request.query])[0], 30, ids, snapshot=snapshot)
        if repo.snapshot().stamp != snapshot.stamp:
            raise DocumentError("document_changed_during_search")
        if service.llm.model_digest() != digest:
            raise DocumentError("embedding_digest_changed")
        return {"document_id": document_id, "model_digest": digest, "chunks": [
            {"chunk_id": c.chunk_id, "section": c.section, "text": c.text, "similarity": c.score,
             "start": c.start, "end": c.end, "pages": c.page_refs, "source_blocks": c.source_blocks} for c in results]}
    except Exception as exc:
        document_failure(exc)


@router.post("/{document_id}/query")
def query_document(document_id: UUID, request: DocumentQuery, actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        from BackEnd.rag.factory import build_chat_service
        from BackEnd.documents.qa import answer_document

        repo = scoped_repository(store, document_id)
        service = build_chat_service(repo, get_settings())
        response, trace = answer_document(repo, service, request.query)
        doc, _ = store.status(str(document_id))
        if (doc["test_only"] or doc["program_test_only"]) and response["kind"] == "fallback":
            response["contacts"] = []
        return {"scope_document_id": document_id, "test_only": doc["test_only"] or doc["program_test_only"], "response": response, "diagnostics": trace}
    except Exception as exc:
        document_failure(exc)


def document_failure(exc):
    if isinstance(exc, DocumentError):
        code = str(exc)
        status = (503 if code in {"automatic_processing_schema_required", "document_embedding_failed", "document_reranker_failed", "document_generation_failed"} else
                  404 if code in {"document_not_found", "job_not_found_or_replaced"} else 409)
        raise HTTPException(status, code) from None
    raise HTTPException(503, "document_service_unavailable") from None


@router.post("", status_code=202, summary="사전 등록 제도에 새 문서 후보 업로드")
async def upload_document(file: UploadFile = File(...), metadata: str = Form(..., description=(
    "JSON 문자열입니다. GET /api/v1/admin/documents/programs에서 service_id와 test_only를 확인하세요. "
    '목업 예: {"service_id":"TEST_MOCK_LIVING","name":"목업 생활지원 원문",'
    '"source_url":"https://example.invalid/mock/living","source_organization":"목업 기관",'
    '"basis_year":"2026","test_only":true}. 실제 문서의 출처·기관·확인된 기준일로 직접 작성하세요.'
)),
                          actor: str = Depends(require_document_admin), store=Depends(get_document_store),
                          document_id: UUID | None = Form(default=None, description="교체할 기존 문서 ID. 생략하면 새 문서를 추가합니다.")):
    settings = get_settings()
    try:
        parsed = DocumentMetadata.model_validate_json(metadata)
    except ValidationError:
        raise HTTPException(422, "invalid_document_metadata") from None
    suffix = Path(file.filename or "").suffix.lower().lstrip(".")
    data, size = [], 0
    try:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > settings.documents_max_file_mb * 1024 * 1024:
                raise HTTPException(413, "file_size_limit")
            data.append(chunk)
    finally:
        await file.close()
    content = b"".join(data)
    try:
        validate_file(content, suffix, settings.documents_max_file_mb * 1024 * 1024)
    except DocumentError as exc:
        raise HTTPException(415, str(exc)) from None

    def persist():
        shared = isinstance(actor, AdminSession)
        config = {"ocr": settings.docling_ocr, "max_pages": settings.documents_max_pages,
                  "max_characters": settings.documents_max_characters, "artifact_store": "postgres-current-v2"}
        if shared:
            config["auth_mode"] = actor.auth_mode
        doc, job = store.register(parsed.model_dump(mode="json"), stable_hash(content), len(content), suffix,
                                  None if shared else actor, config, content, document_id=document_id,
                                  **({"shared_password": True} if shared else {}))
        return {"id":str(doc["document_id"]), "document_id":str(doc["document_id"]),
                "program_id":doc["program_id"], "job_id":str(job["job_id"]), "state":job["state"],
                "test_only":parsed.test_only, "embedding_started":False,
                "processing_mode":"automatic", "human_review_required":False,
                "current_search_preserved":bool(doc["active_job_id"])}

    try:
        return await run_in_threadpool(persist)
    except Exception as exc:
        document_failure(exc)


@router.put("/{document_id}", status_code=202, summary="같은 문서 ID로 교체 후보 접수")
async def replace_document(document_id: UUID, file: UploadFile = File(...), metadata: str = Form(...),
                           actor=Depends(require_document_admin), store=Depends(get_document_store)):
    return await upload_document(file=file,metadata=metadata,actor=actor,store=store,document_id=document_id)


def public_job(job):
    return {"id":job["job_id"], "job_id":job["job_id"], "state":job["state"], "attempts":job["attempts"],
            "error_code":job["error_code"], "created_at":job["created_at"], "finished_at":job["finished_at"],
            "reviewed_at":job["reviewed_at"], "parser_version":job["parser_version"],
            "embedding_model":job["embedding_model"], "embedding_digest":job["embedding_digest"],
            "candidate_metadata":job.get("candidate_metadata",{}),
            "processing_mode":job.get("processing_mode","manual"),
            "processed_at":job.get("processed_at"), "human_reviewed":bool(job.get("reviewed_at"))}


@router.get("/{document_id}")
def document_status(document_id: UUID, offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=200),
                    actor=Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        doc, jobs = store.status(str(document_id))
        result = {"id":doc["document_id"], "document_id":doc["document_id"], "program_id":doc["program_id"],
                  "name":doc["document_name"], "service_id":doc["service_id"], "source_url":doc["source_url"],
                  "source_organization":doc["source_organization"], "basis_year":doc["basis_year"],
                  "source_updated_at":doc["source_updated_at"], "status":jobs[0]["state"] if jobs else "registered",
                  "active":bool(doc["active_job_id"]), "active_job_id":doc["active_job_id"],
                  "test_only":doc["test_only"] or doc["program_test_only"], "local_ingestion":doc["local_ingestion"],
                  "jobs":[public_job(job) for job in jobs]}
        result["api_source"] = store.policy(doc["service_id"])
        try:
            settings = get_settings()
            job, analysis = read_analysis(store,str(document_id),settings.documents_max_characters * 20 + 20 * 1024 * 1024)
        except DocumentError as exc:
            if str(exc) != "analysis_not_ready":
                raise
        else:
            result["analysis"] = {"hash":job["analysis_hash"], "job_id":job["job_id"],
                                  "scope":"current" if job["state"] == "succeeded" else "candidate",
                                  "blockers":analysis["blockers"], "warnings":analysis["warnings"], "pages":analysis["pages"],
                                  "total_blocks":len(analysis["blocks"]), "blocks":analysis["blocks"][offset:offset+limit],
                                  "offset":offset, "next_offset":offset+limit if offset+limit<len(analysis["blocks"]) else None}
            result["analysis"]["processing_mode"] = job.get("processing_mode","manual")
            result["analysis"]["human_review_required"] = False
            if job.get("processing_mode") != "automatic" and job["state"] != "succeeded":
                result["analysis"]["instruction"] = "이전 수동 검토 대기 작업입니다. 취소 후 원문을 다시 업로드하면 자동 처리합니다."
        return result
    except Exception as exc:
        document_failure(exc)


@router.get("/{document_id}/jobs/{job_id}")
def document_job(document_id: UUID, job_id: UUID, actor=Depends(require_document_admin),store=Depends(get_document_store)):
    try:
        _, jobs=store.status(str(document_id))
        job=next((j for j in jobs if str(j["job_id"]) == str(job_id)),None)
        if not job:
            raise DocumentError("job_not_found_or_replaced")
        return {**public_job(job), "progress":store.progress(str(job_id))}
    except Exception as exc:
        document_failure(exc)


@router.post("/{document_id}/cancel")
def cancel_document_job(document_id: UUID,actor=Depends(require_document_admin),store=Depends(get_document_store)):
    try:
        shared = isinstance(actor, AdminSession)
        return {"job_id":store.cancel(str(document_id), None if shared else actor,
                                     **({"shared_password": True} if shared else {})),
                "state":"cancelled","candidate_discarded":True}
    except Exception as exc:
        document_failure(exc)


@router.delete("/{document_id}",status_code=204)
def delete_document(document_id: UUID,actor=Depends(require_document_admin),store=Depends(get_document_store)):
    try:
        shared = isinstance(actor, AdminSession)
        store.delete(str(document_id), None if shared else actor, **({"shared_password": True} if shared else {}))
    except Exception as exc:
        document_failure(exc)


@router.post("/{document_id}/index", summary="수동 색인 승인 경로 종료 안내")
def index_document(document_id: UUID, actor: str = Depends(require_document_admin)):
    raise HTTPException(409, "manual_index_disabled_upload_again")


@router.post("/{document_id}/retry", status_code=202)
def retry_document(document_id: UUID, actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        settings = get_settings()
        config = {"ocr":settings.docling_ocr, "max_pages":settings.documents_max_pages,
                  "max_characters":settings.documents_max_characters, "artifact_store":"postgres-current-v2"}
        shared = isinstance(actor, AdminSession)
        if shared:
            config["auth_mode"] = actor.auth_mode
        return {"job_id":store.retry(str(document_id), None if shared else actor, config,
                                    **({"shared_password": True} if shared else {})), "state":"queued",
                "processing_mode":"automatic", "human_review_required":False}
    except Exception as exc:
        document_failure(exc)


@router.get("/{document_id}/markdown", response_class=PlainTextResponse)
def document_markdown(document_id: UUID, actor=Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        settings = get_settings()
        _, analysis = read_analysis(store, str(document_id), settings.documents_max_characters * 20 + 20 * 1024 * 1024)
        return analysis["markdown"]
    except Exception as exc:
        document_failure(exc)


class DocumentBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in {"POST", "PUT"} or not scope.get("path", "").startswith(router.prefix):
            return await self.app(scope, receive, send)
        size = 0
        cap = (get_settings().documents_max_file_mb * 1024 * 1024 + 65536
               if scope["path"].rstrip("/") == router.prefix or scope.get("method") == "PUT" else 2 * 1024 * 1024)

        async def bounded_receive():
            nonlocal size
            message = await receive()
            size += len(message.get("body", b""))
            if size > cap:
                raise HTTPException(413, "multipart_body_size_limit")
            return message

        return await self.app(scope, bounded_receive, send)
