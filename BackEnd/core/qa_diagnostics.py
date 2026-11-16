"""문서 QA 단계와 허용된 메타데이터만 기록한다. HTTP 전송 완료나 원문은 기록하지 않는다."""

from contextvars import ContextVar
from contextlib import contextmanager
from dataclasses import dataclass, field
from functools import wraps
import json
import logging
from time import monotonic
from uuid import uuid4

from BackEnd.core.execution import ExecutionCancelledError, ExecutionTimeoutError, GenerationStopped
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
    "early_stop", "skipped",
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
    call_index: int = 0
    rerank_wait_ms: float | None = None
    rerank_process_ms: float = 0


_current: ContextVar[Diagnostic | None] = ContextVar("qa_diagnostic", default=None)
_purpose: ContextVar[str] = ContextVar("model_purpose", default="answer")
_model_call: ContextVar[dict | None] = ContextVar("model_call", default=None)
NATIVE_DURATIONS = ("total_duration", "load_duration", "prompt_eval_duration", "eval_duration")


def native_metadata(metadata):
    """Ollama ns와 토큰 수만 허용하며 미제공·잘못된 값은 채우지 않는다."""
    result = {}
    for key in (*NATIVE_DURATIONS, "prompt_eval_count", "eval_count"):
        value = metadata.get(key)
        if type(value) is int and value >= 0:
            result[key.removesuffix("_duration") + "_ms" if key in NATIVE_DURATIONS else key] = (
                round(value / 1_000_000, 6) if key in NATIVE_DURATIONS else value)
    if type(metadata.get("done_reason")) is str and metadata["done_reason"] in {"stop", "length"}:
        result["done_reason"] = metadata["done_reason"]
    durations = sum(key.removesuffix("_duration") + "_ms" in result for key in NATIVE_DURATIONS)
    result["native_timing"] = "complete" if durations == 4 else "partial" if durations else "missing"
    return result


@contextmanager
def model_purpose(purpose):
    token = _purpose.set(purpose if purpose in {"context", "answer"} else "answer")
    try:
        yield
    finally:
        _purpose.reset(token)


@contextmanager
def model_call(model, *, input_count=None):
    state = _current.get()
    started, metadata = monotonic(), {}
    fields = {"purpose": "embedding" if input_count is not None else _purpose.get(), "model": model}
    if state is not None:
        state.call_index += 1
        fields["call_index"] = state.call_index
        if input_count is not None:
            fields["input_count"] = input_count
        _emit(state, "model_start", "ok", completion=fields)
    active = {"state": state, "fields": fields, "first_content": False, "started": started}
    token = _model_call.set(active)
    code = "ok"
    try:
        yield metadata
    except GenerationStopped:
        code = "early_stop"
        raise
    except ExecutionTimeoutError:
        code = "timeout"
        raise
    except ExecutionCancelledError:
        code = "cancelled"
        raise
    except BaseException:
        code = "error"
        raise
    finally:
        _model_call.reset(token)
        if state is not None:
            _emit(state, "model_end", code, started=started,
                  completion={**fields, **native_metadata(metadata),
                              "wall_ms": round((monotonic() - started) * 1000, 2)})


def model_content(content):
    active = _model_call.get()
    if active is not None and not active["first_content"] and content.strip():
        active["first_content"] = True
        if active["state"] is not None:
            _emit(active["state"], "first_model_content", "ok", completion=active["fields"])


def context_preparation(trace):
    state = _current.get()
    if state is not None:
        status = trace.get("preparation")
        if status not in {"used", "skipped", "input_budget", "failed"}:
            return
        _emit(state, "context_preparation", "skipped" if status == "skipped" else "ok" if status == "used" else "error",
              completion={"purpose": "context", "preparation": status,
                          "reason": {"skipped": "no_context", "input_budget": "input_budget",
                                     "failed": "preparation_failed", "used": "prepared"}[status],
                          "early_stop": trace.get("preparation_stopped_early") is True})


COUNT_FIELDS = frozenset({"input_count", "candidate_count", "eligible_count", "dense_count", "keyword_count",
    "union_count", "passing_count", "evidence_count", "document_count", "included_evidence_count",
    "evidence_omitted", "context_limit", "reserved_output", "estimated_input", "threads", "pair_count"})


def _counts(values):
    return {k: v for k, v in values.items() if k in COUNT_FIELDS and type(v) is int and v >= 0}


@contextmanager
def qa_step(name, **counts):
    state, started, code = _current.get(), monotonic(), "ok"
    if state is not None:
        _emit(state, "step_start", code, completion={"step": name, **_counts(counts)})
    try:
        yield counts
    except ExecutionTimeoutError:
        code = "timeout"
        raise
    except ExecutionCancelledError:
        code = "cancelled"
        raise
    except BaseException:
        code = "error"
        raise
    finally:
        if state is not None:
            _emit(state, "step_end", code, started=started, completion={"step": name, **_counts(counts)})


@contextmanager
def timed_rerank_lock(lock, site, **counts):
    """기존 잠금 범위를 유지한다. 처리 시간에는 토큰화·병렬 평가가 함께 들어간다."""
    state, waiting, code = _current.get(), monotonic(), "ok"
    acquired = finished = None
    try:
        with lock:
            acquired = monotonic()
            try:
                yield counts
            finally:
                finished = monotonic()
    except ExecutionTimeoutError:
        code = "timeout"
        raise
    except ExecutionCancelledError:
        code = "cancelled"
        raise
    except BaseException:
        code = "error"
        raise
    finally:
        if state is not None and acquired is not None and finished is not None:
            wait_ms, process_ms = (acquired - waiting) * 1000, (finished - acquired) * 1000
            state.rerank_wait_ms = (state.rerank_wait_ms or 0) + wait_ms
            state.rerank_process_ms += process_ms
            _emit(state, "rerank_lock", code, started=waiting,
                  completion={"site": site, "wait_ms": round(wait_ms, 2),
                              "process_ms": round(process_ms, 2), **_counts(counts)})


def current_diagnostic():
    return _current.get()


def _safe_code(value):
    return value if type(value) is str and value in CODES else "error"


def _emit(state, event, code, *, stage=None, started=None, completion=None):
    record = {"request_id": state.request_id, "event": event,
              "request_elapsed_ms": round(max(0, monotonic() - state.started) * 1000, 2),
              "elapsed_ms": round(max(0, monotonic() - (state.started if started is None else started)) * 1000, 2),
              "code": _safe_code(code)}
    if stage is not None:
        record["stage"] = stage
    if completion:
        record.update(completion)
    logger.info("%s", json.dumps(record, separators=(",", ":")))


def _finish_stage(state, code):
    if state.stage is not None:
        completion = {}
        if state.stage == "rerank" and state.rerank_wait_ms is not None:
            completion = {"lock_wait_ms": round(state.rerank_wait_ms, 2),
                          "lock_process_ms": round(state.rerank_process_ms, 2)}
        _emit(state, "stage_end", code, stage=state.stage, started=state.stage_started, completion=completion)
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
                completion.update(native_metadata(metadata))
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
