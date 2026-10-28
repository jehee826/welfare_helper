import json
from uuid import uuid4

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.worker import failure_diagnostic


def test_missing_dependency_report_keeps_only_safe_module_and_stage(tmp_path):
    job_id = str(uuid4())
    (tmp_path / "progress.json").write_text(json.dumps({"stage": "parsing"}))
    exc = ModuleNotFoundError("secret password and document text", name="cv2")
    report = failure_diagnostic(exc, job_id, tmp_path)
    assert report == {"event": "document_job_failed", "job_id": job_id, "stage": "parsing",
                      "exception_type": "ModuleNotFoundError", "missing_module": "cv2",
                      "error_code": "document_dependency_missing"}
    assert "secret" not in json.dumps(report)


def test_wrapped_missing_dependency_and_unsafe_names_are_sanitized(tmp_path):
    exc = RuntimeError("private source")
    exc.__cause__ = ModuleNotFoundError("private path", name="docling.models.safe_module")
    assert failure_diagnostic(exc, str(uuid4()), tmp_path)["missing_module"] == "docling.models.safe_module"
    unsafe = ModuleNotFoundError("private", name="password=secret")
    report = failure_diagnostic(unsafe, "secret-id", tmp_path)
    assert report["missing_module"] is None
    assert report["job_id"] is None
    assert "private" not in json.dumps(report)
    assert "secret" not in json.dumps(report)


def test_public_document_error_is_retained_without_exception_message(tmp_path):
    assert failure_diagnostic(DocumentError("analysis_quality_blocked"), str(uuid4()), tmp_path)["error_code"] == "analysis_quality_blocked"
    assert failure_diagnostic(DocumentError("postgres://password=secret"), str(uuid4()), tmp_path)["error_code"] == "document_processing_failed"
