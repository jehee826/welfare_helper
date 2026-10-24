from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import ValidationError
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from BackEnd.core.settings import get_settings
from BackEnd.documents.auth import require_document_admin
from BackEnd.documents.analysis import read_analysis
from BackEnd.documents.contracts import DocumentError, DocumentMetadata, IndexRequest, stable_hash, validate_file, validate_review
from BackEnd.documents.storage import PrivateStorage
from BackEnd.documents.store import get_document_store

router = APIRouter(prefix="/api/v1/admin/documents", tags=["관리자 문서"])


class DocumentQuery(BaseModel):
    query: str = Field(min_length=1, max_length=300)


def scoped_repository(store, document_id):
    from BackEnd.rag.repository import PgServiceRepository

    settings = get_settings()
    store.status(str(document_id))
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
        results = repo.dense_search(service.llm.embed([request.query])[0], 30, ids)
        return {"document_id": document_id, "model_digest": digest, "chunks": [
            {"chunk_id": c.chunk_id, "section": c.section, "text": c.text, "similarity": c.score,
             "start": c.start, "end": c.end, "pages": c.page_refs, "source_blocks": c.source_blocks} for c in results]}
    except Exception as exc:
        document_failure(exc)


@router.post("/{document_id}/query")
def query_document(document_id: UUID, request: DocumentQuery, actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        from BackEnd.rag.factory import build_chat_service

        repo = scoped_repository(store, document_id)
        service = build_chat_service(repo, get_settings())
        response, trace = service.answer_with_diagnostics(request.query, None)
        doc, _ = store.status(str(document_id))
        if doc["test_only"] and response["kind"] == "fallback":
            response["contacts"] = []
        return {"scope_document_id": document_id, "test_only": doc["test_only"], "response": response, "diagnostics": trace}
    except Exception as exc:
        document_failure(exc)


def document_failure(exc):
    if isinstance(exc, DocumentError):
        code = str(exc)
        status = 404 if code == "document_not_found" else 409
        raise HTTPException(status, code) from None
    raise HTTPException(503, "document_service_unavailable") from None


@router.post("", status_code=202)
async def upload_document(file: UploadFile = File(...), metadata: str = Form(..., description="DocumentMetadata JSON: service_id/name/source_url/basis_year/test_only"),
                          actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
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
        config = {"ocr": settings.docling_ocr, "max_pages": settings.documents_max_pages,
                  "max_characters": settings.documents_max_characters}
        doc = store.register(parsed.model_dump(mode="json"), stable_hash(content), len(content), suffix, actor, config)
        try:
            storage = PrivateStorage(settings)
            storage.put(doc["object_key"], content, {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "md": "text/markdown; charset=utf-8"}[suffix])
        except Exception:
            store.upload_failed(doc["id"])
            raise
        job = store.queue_analysis(doc["id"], actor)
        return {"id": str(doc["id"]), "job_id": str(job["id"]), "state": job["state"],
                "test_only": doc["test_only"], "embedding_started": False}

    try:
        return await run_in_threadpool(persist)
    except Exception as exc:
        document_failure(exc)


@router.get("/{document_id}")
def document_status(document_id: UUID, offset: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=200),
                    actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        doc, jobs = store.status(str(document_id))
        result = {key: doc[key] for key in ("id", "name", "service_id", "source_url", "basis_year", "source_updated_at", "status", "active", "test_only", "parser_version")}
        result["jobs"] = [{key: job[key] for key in ("id", "kind", "state", "attempts", "error_code", "created_at", "finished_at")} for job in jobs]
        for output, job in zip(result["jobs"], jobs):
            output["progress"] = {key: value for key, value in job["result"].items()
                                  if key in {"stage", "chunks", "embedded", "reused", "stored", "blocks", "pages"}}
        result["api_source"] = store.policy(doc["service_id"])
        if doc["analysis_job_id"]:
            settings = get_settings()
            job, analysis = read_analysis(store, PrivateStorage(settings), str(document_id), settings.documents_max_characters * 20 + 20 * 1024 * 1024)
            result["analysis"] = {"hash": job["result"]["analysis_hash"], "blockers": analysis["blockers"],
                                  "warnings": analysis["warnings"], "pages": analysis["pages"], "total_blocks": len(analysis["blocks"]),
                                  "blocks": analysis["blocks"][offset:offset + limit], "offset": offset,
                                  "next_offset": offset + limit if offset + limit < len(analysis["blocks"]) else None}
        return result
    except Exception as exc:
        document_failure(exc)


@router.post("/{document_id}/index", status_code=202)
def index_document(document_id: UUID, request: IndexRequest, actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        settings = get_settings()
        job, analysis = read_analysis(store, PrivateStorage(settings), str(document_id), settings.documents_max_characters * 20 + 20 * 1024 * 1024)
        if request.analysis_hash != job["result"]["analysis_hash"]:
            raise DocumentError("analysis_version_changed")
        payload = request.model_dump(mode="json")
        validate_review(analysis, payload)
        queued = store.queue_index(str(document_id), actor, payload, job["id"], request.analysis_hash)
        return {"id": document_id, "job_id": queued["id"], "state": queued["state"]}
    except Exception as exc:
        document_failure(exc)


@router.post("/{document_id}/retry", status_code=202)
def retry_document(document_id: UUID, actor: str = Depends(require_document_admin), store=Depends(get_document_store)):
    try:
        return {"job_id": store.retry(str(document_id), actor), "state": "queued"}
    except Exception as exc:
        document_failure(exc)


class DocumentBodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST" or not scope.get("path", "").startswith(router.prefix):
            return await self.app(scope, receive, send)
        size = 0
        cap = (get_settings().documents_max_file_mb * 1024 * 1024 + 65536
               if scope["path"].rstrip("/") == router.prefix else 2 * 1024 * 1024)

        async def bounded_receive():
            nonlocal size
            message = await receive()
            size += len(message.get("body", b""))
            if size > cap:
                raise HTTPException(413, "multipart_body_size_limit")
            return message

        return await self.app(scope, bounded_receive, send)
