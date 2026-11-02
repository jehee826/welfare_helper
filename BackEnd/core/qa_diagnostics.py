"""문서 QA의 처리 단계만 기록한다. HTTP 전송 완료나 원문은 기록하지 않는다."""

from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import wraps
import json
import logging
from time import monotonic
from uuid import uuid4

from BackEnd.core.execution import ExecutionCancelledError, ExecutionTimeoutError
from BackEnd.documents.contracts import DocumentError


logger = logging.getLogger("welfare_helper.qa_steps")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate = False

STAGES = frozenset({"snapshot", "context", "retrieval", "rerank", "generation", "validation"})
CODES = frozenset({
    "ok", "answer", "clarify", "no_evidence", "out_of_scope", "no_document_evidence",
    "conversation_clarification_required", "document_input_budget", "invalid_evidence_answer",
    "document_scope_mismatch", "embedding_digest_changed", "document_embedding_failed",
    "document_reranker_failed", "document_generation_failed", "document_changed_during_search",
    "document_evidence_version_mismatch", "document_evidence_incomplete", "timeout", "cancelled", "error",
})


@dataclass
class Diagnostic:
    request_id: str = field(default_factory=lambda: uuid4().hex)
    started: float = field(default_factory=monotonic)
    stage: str | None = None
    stage_started: float = 0
    seen: set[str] = field(default_factory=set)


_current: ContextVar[Diagnostic | None] = ContextVar("qa_diagnostic", default=None)


def current_diagnostic():
    return _current.get()


def _safe_code(value):
    return value if type(value) is str and value in CODES else "error"


def _emit(state, event, code, *, stage=None, started=None):
    record = {"request_id": state.request_id, "event": event,
              "elapsed_ms": round(max(0, monotonic() - (state.started if started is None else started)) * 1000, 2),
              "code": _safe_code(code)}
    if stage is not None:
        record["stage"] = stage
    logger.info("%s", json.dumps(record, separators=(",", ":")))


def _finish_stage(state, code):
    if state.stage is not None:
        _emit(state, "stage_end", code, stage=state.stage, started=state.stage_started)
        state.stage = None


def qa_stage(name):
    state = _current.get()
    if state is None or name not in STAGES or name in state.seen:
        return
    _finish_stage(state, "ok")
    state.stage = name
    state.stage_started = monotonic()
    state.seen.add(name)
    _emit(state, "stage_start", "ok", stage=name, started=state.stage_started)


def diagnose_qa(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        state = Diagnostic()
        token = _current.set(state)
        code = "error"
        try:
            _emit(state, "qa_start", "ok")
            result = function(*args, **kwargs)
            code = _safe_code(result[1].get("reason"))
            return result
        except ExecutionTimeoutError:
            code = "timeout"
            raise
        except ExecutionCancelledError:
            code = "cancelled"
            raise
        except DocumentError as exc:
            code = _safe_code(exc.args[0] if exc.args else None)
            raise
        finally:
            try:
                _finish_stage(state, code)
                _emit(state, "qa_end", code)
            finally:
                _current.reset(token)
    return wrapped
