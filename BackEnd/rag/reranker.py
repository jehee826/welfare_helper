"""캐시된 INT8 교차 인코더로 질문과 후보 원문의 관련성을 평가한다."""

import math
from threading import Lock


class RerankerError(RuntimeError):
    """리랭커를 사용할 수 없거나 점수가 유효하지 않을 때 발생한다."""


class LocalReranker:
    def __init__(self, model: str, revision: str, cache_dir: str, max_length: int = 512, threads: int = 2):
        self.model = model
        self.revision = revision
        self.cache_dir = cache_dir
        self.max_length = max_length
        self.threads = threads
        self._session = None
        self._tokenizer = None
        self._lock = Lock()

    def score(self, query: str, passages: list[str]) -> list[float]:
        if not passages:
            return []
        # 첫 요청의 중복 모델 로딩과 동시 추론에 따른 메모리 급증을 막는다.
        with self._lock:
            try:
                import numpy as np
                import onnxruntime as ort
                from huggingface_hub import hf_hub_download
                from tokenizers import Tokenizer

                if self._session is None:
                    files = [hf_hub_download(
                        self.model, filename, revision=self.revision,
                        cache_dir=self.cache_dir, local_files_only=True,
                    ) for filename in ("tokenizer.json", "onnx/model_quantized.onnx")]
                    tokenizer = Tokenizer.from_file(files[0])
                    tokenizer.enable_truncation(max_length=self.max_length, strategy="only_second")
                    options = ort.SessionOptions()
                    options.intra_op_num_threads = self.threads
                    options.inter_op_num_threads = 1
                    options.enable_cpu_mem_arena = False
                    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
                    session = ort.InferenceSession(
                        files[1], sess_options=options,
                        providers=["CPUExecutionProvider"],
                    )
                    self._tokenizer, self._session = tokenizer, session

                scores = []
                for passage in passages:
                    encoded = self._tokenizer.encode(query, passage)
                    values = {
                        "input_ids": encoded.ids,
                        "attention_mask": encoded.attention_mask,
                        "token_type_ids": encoded.type_ids,
                    }
                    inputs = {arg.name: np.asarray([values[arg.name]], dtype=np.int64)
                              for arg in self._session.get_inputs()}
                    logits = self._session.run(None, inputs)[0].reshape(-1)
                    if len(logits) != 1 or not math.isfinite(float(logits[0])):
                        raise ValueError("리랭커 점수가 유효하지 않습니다.")
                    value = float(logits[0])
                    scores.append(1 / (1 + math.exp(-value)) if value >= 0
                                  else math.exp(value) / (1 + math.exp(value)))
                return scores
            except Exception as exc:
                raise RerankerError(f"로컬 리랭커 사용 실패: {type(exc).__name__}") from None


def download_model() -> None:
    from huggingface_hub import snapshot_download

    from BackEnd.core.settings import get_settings

    settings = get_settings()
    snapshot_download(
        settings.rerank_model, revision=settings.rerank_revision, cache_dir=settings.rerank_cache_dir,
        allow_patterns=["tokenizer.json", "onnx/model_quantized.onnx"],
    )
    print("리랭커 모델 준비 완료. 질의 시에는 로컬 캐시만 사용합니다.")


if __name__ == "__main__":
    download_model()
