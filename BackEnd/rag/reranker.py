"""캐시된 INT8 교차 인코더로 질문과 후보 원문의 관련성을 평가한다."""

import math
from pathlib import Path
from threading import Lock
from collections import OrderedDict
import os

from BackEnd.rag.chunking import split_ranges
from BackEnd.core.execution import checkpoint, ExecutionTimeoutError, ExecutionCancelledError
from BackEnd.core.qa_diagnostics import record_rerank_input_budget


class RerankerError(RuntimeError):
    """리랭커를 사용할 수 없거나 점수가 유효하지 않을 때 발생한다."""


class RerankerInputError(RerankerError):
    """질문 또는 문서가 원문 보존 입력 창에 들어가지 않는다."""


class LocalReranker:
    def __init__(self, model: str, revision: str, cache_dir: str, max_length: int = 512, threads: int = 2):
        self.model = model
        self.revision = revision
        self.cache_dir = cache_dir
        self.max_length = max_length
        self.threads = threads
        self._session = None
        self._tokenizer = None
        self._count_tokenizer = None
        self._lock = Lock()

    def model_files(self) -> tuple[Path, Path]:
        root = (Path(self.cache_dir).resolve() / ("models--" + self.model.replace("/", "--"))
                / "snapshots" / self.revision)
        files = (root / "tokenizer.json", root / "onnx" / "model_quantized.onnx")
        if any(not path.is_file() or path.stat().st_size == 0 for path in files):
            raise RerankerError("리랭커 준비가 필요합니다. 모델·revision·캐시 마운트를 확인해 주세요.")
        return files

    def score(self, query: str, passages: list[str]) -> list[float]:
        return self.score_with_diagnostics(query, passages)[0]

    def count_tokens(self, text: str) -> int:
        checkpoint()
        with self._lock:
            if self._count_tokenizer is None:
                from tokenizers import Tokenizer

                self._count_tokenizer = Tokenizer.from_file(str(self.model_files()[0]))
                self._count_tokenizer.no_truncation()
            return len(self._count_tokenizer.encode(text, add_special_tokens=False).ids)

    def score_with_diagnostics(self, query: str, passages: list[str]) -> tuple[list[float], list[dict]]:
        checkpoint()
        if not passages:
            return [], []
        query_tokens = self.count_tokens(query)
        if query_tokens > 128:
            record_rerank_input_budget(query_tokens, 128)
            raise RerankerInputError("질문이 128토큰을 넘습니다. 의도별로 범위를 좁혀 주세요.")
        # 첫 요청의 중복 모델 로딩과 동시 추론에 따른 메모리 급증을 막는다.
        with self._lock:
            try:
                checkpoint()
                if self._session is None:
                    files = self.model_files()
                    import onnxruntime as ort
                    from tokenizers import Tokenizer

                    tokenizer = Tokenizer.from_file(str(files[0]))
                    tokenizer.no_truncation()
                    options = ort.SessionOptions()
                    options.intra_op_num_threads = self.threads
                    options.inter_op_num_threads = 1
                    options.enable_cpu_mem_arena = False
                    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
                    session = ort.InferenceSession(
                        str(files[1]), sess_options=options,
                        providers=["CPUExecutionProvider"],
                    )
                    self._tokenizer, self._session = tokenizer, session
                checkpoint()

                scores, diagnostics = [], []
                import numpy as np
                input_args = self._session.get_inputs()
                pad_id = self._tokenizer.token_to_id("<pad>") if hasattr(self._tokenizer, "token_to_id") else None
                # 실제 pad ID와 가변 batch를 확인한 모델만 묶고, 그 외는 기존 단건을 유지한다.
                batch_size = 4 if pad_id is not None and all(
                    not isinstance((getattr(arg, "shape", None) or [1])[0], int) for arg in input_args) else 1
                pending = []
                special = len(self._tokenizer.encode(query, "").ids) - query_tokens

                def score_pending():
                    if not pending:
                        return
                    checkpoint()
                    width = max(len(encoded.ids) for _, encoded in pending)
                    rows = [{"input_ids": encoded.ids, "attention_mask": encoded.attention_mask,
                             "token_type_ids": encoded.type_ids} for _, encoded in pending]
                    inputs = {arg.name: np.asarray([
                        row[arg.name] + [pad_id if arg.name == "input_ids" else 0] * (width - len(row[arg.name]))
                        for row in rows], dtype=np.int64) for arg in input_args}
                    logits = self._session.run(None, inputs)[0].reshape(-1)
                    checkpoint()
                    if len(logits) != len(pending) or any(not math.isfinite(float(value)) for value in logits):
                        raise ValueError("리랭커 점수가 유효하지 않습니다.")
                    for (owner, _), value in zip(pending, logits):
                        value = float(value)
                        probability = (1 / (1 + math.exp(-value)) if value >= 0
                                       else math.exp(value) / (1 + math.exp(value)))
                        scores[owner] = max(scores[owner], probability)
                    pending.clear()

                for owner, passage in enumerate(passages):
                    checkpoint()
                    scores.append(float("-inf"))
                    budget = min(400, self.max_length - query_tokens - special - 16)
                    header, body = "", passage
                    lines = passage.split("\n", 2)
                    if len(lines) == 3 and lines[0].startswith("서비스명:") and lines[1].startswith("섹션:"):
                        header, body = "\n".join(lines[:2]) + "\n", lines[2]
                        while body.startswith("[제목") and "\n" in body:
                            heading, _, body = body.partition("\n")
                            header += heading + "\n"
                    def count(text):
                        checkpoint()
                        return len(self._tokenizer.encode(text, add_special_tokens=False).ids)
                    try:
                        windows = split_ranges(body, header, count, target=len(body), max_chars=max(1, len(body)),
                                               max_tokens=budget, overlap=False)
                    except ValueError:
                        raise RerankerInputError("원문을 빠짐없이 입력 창으로 나누지 못했습니다.") from None
                    lengths = []
                    for window in windows:
                        checkpoint()
                        encoded = self._tokenizer.encode(query, header + body[window.start:window.end])
                        if len(encoded.ids) > self.max_length - 16:
                            raise RerankerInputError("리랭커 쌍 입력 한도를 넘었습니다.")
                        lengths.append(len(encoded.ids))
                        pending.append((owner, encoded))
                        if len(pending) == batch_size:
                            score_pending()
                    diagnostics.append({"windows": len(windows), "pair_tokens": lengths, "truncated": False})
                score_pending()
                if any(not math.isfinite(value) for value in scores):
                    raise ValueError("리랭커 점수가 유효하지 않습니다.")
                return scores, diagnostics
            except (ExecutionTimeoutError, ExecutionCancelledError, RerankerInputError):
                raise
            except Exception as exc:
                raise RerankerError(f"로컬 리랭커 사용 실패: {type(exc).__name__}") from None


_cache = OrderedDict()
_cache_lock = Lock()


def cached_reranker(model: str, revision: str, cache_dir: str, max_length: int, threads: int):
    key = (model, revision, os.path.normcase(str(Path(cache_dir).resolve())), max_length, threads)
    with _cache_lock:
        if key not in _cache:
            _cache[key] = LocalReranker(*key)
            if len(_cache) > 4:
                _cache.popitem(last=False)
        _cache.move_to_end(key)
        return _cache[key]


def download_model() -> None:
    from huggingface_hub import snapshot_download

    from BackEnd.core.settings import get_settings

    settings = get_settings()
    reranker = LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir)
    try:
        reranker.model_files()
        print("기존 리랭커 캐시를 사용합니다. 다운로드하지 않았습니다.")
        return
    except RerankerError:
        pass
    snapshot_download(
        settings.rerank_model, revision=settings.rerank_revision, cache_dir=settings.rerank_cache_dir,
        allow_patterns=["tokenizer.json", "onnx/model_quantized.onnx"],
    )
    reranker.model_files()
    print("리랭커 모델 준비 완료. 질의 시에는 로컬 캐시만 사용합니다.")


if __name__ == "__main__":
    download_model()
