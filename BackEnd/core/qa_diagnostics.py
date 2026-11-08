"""문서 QA 단계와 허용된 메타데이터만 기록한다. HTTP 전송 완료나 원문은 기록하지 않는다."""

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
    "ok", "answer", "clarify", "no_evidence", "out_of_scope", "no_document_evidence", "low_similarity",
    "conversation_clarification_required", "document_input_budget", "invalid_evidence_answer",
    "document_scope_mismatch", "embedding_digest_changed", "document_embedding_failed",
    "document_reranker_failed", "document_generation_failed", "document_changed_during_search",
    "document_evidence_version_mismatch", "document_evidence_incomplete", "timeout", "cancelled", "error",
})
ANSWER_VALIDATION_CODES = frozenset({
    "accepted", "invalid_schema", "empty_answer", "invalid_answer",
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


def _emit(state, event, code, *, stage=None, started=None, completion=None):
    record = {"request_id": state.request_id, "event": event,
              "elapsed_ms": round(max(0, monotonic() - (state.started if started is None else started)) * 1000, 2),
              "code": _safe_code(code)}
    if stage is not None:
        record["stage"] = stage
    if completion:
        record.update(completion)
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


def record_rerank_input_budget(token_count: int, token_limit: int):
    state = _current.get()
    if state is not None:
        # 질문이나 재작성 문장을 남기지 않고 기존 입력 한도 초과만 구분한다.
        _emit(state, "rerank_input_budget", "document_reranker_failed", stage="rerank",
              completion={"query_tokens": token_count, "query_limit": token_limit})


def record_generation_metrics(metadata):
    state = _current.get()
    if state is None or not isinstance(metadata, dict):
        return
    safe = {key: metadata[key] for key in ('prompt_eval_count', 'eval_count', 'total_duration',
            'load_duration', 'prompt_eval_duration', 'eval_duration')
            if type(metadata.get(key)) is int and metadata[key] >= 0}
    reason = metadata.get('done_reason')
    if type(reason) is str and reason in {'stop', 'length'}:
        safe['done_reason'] = reason
    if safe:
        _emit(state, 'generation_metrics', 'ok', stage='generation', completion=safe)


def diagnose_qa(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        state = Diagnostic()
        token = _current.set(state)
        code = "error"
        completion = {}
        try:
            _emit(state, "qa_start", "ok")
            result = function(*args, **kwargs)
            code = _safe_code(result[1].get("reason"))
            # 원문이 섞인 trace 전체 대신 허용된 값만 완료 로그에 전달한다.
            validation = result[1].get("answer_validation")
            if type(validation) is str and validation in ANSWER_VALIDATION_CODES:
                completion["answer_validation"] = validation
            metadata = result[1].get("generation_metadata")
            if isinstance(metadata, dict):
                reason = metadata.get("done_reason")
                if type(reason) is str and reason in {"stop", "length"}:
                    completion["done_reason"] = reason
                for key in ("prompt_eval_count", "eval_count"):
                    value = metadata.get(key)
                    if type(value) is int and value >= 0:
                        completion[key] = value
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
                _emit(state, "qa_end", code, completion=completion)
            finally:
                _current.reset(token)
    return wrapped
