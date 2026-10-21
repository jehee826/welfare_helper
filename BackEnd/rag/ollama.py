import httpx


class OllamaError(RuntimeError):
    """Ollama 호출이 실패했거나 응답 형식이 예상과 다를 때 발생한다."""


class OllamaClient:
    """Ollama HTTP API로 임베딩과 채팅 응답을 받는다. base_url에 user:pass@를 넣으면 기본 인증을 보낸다."""

    def __init__(
        self,
        base_url: str,
        embed_model: str,
        llm_model: str,
        timeout: float = 120.0,
        llm_options: dict | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.embed_model = embed_model
        self.llm_model = llm_model
        self.timeout = timeout
        self.llm_options = llm_options or {}

    def _post(self, path: str, payload: dict, timeout: float) -> dict:
        try:
            response = httpx.post(f"{self.base_url}{path}", json=payload, timeout=timeout)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaError(f"Ollama {path} 호출 실패: {exc.__class__.__name__}") from exc

    def embed(self, texts: list[str]) -> list[list[float]]:
        data = self._post("/api/embed", {"model": self.embed_model, "input": texts}, timeout=min(self.timeout, 30.0))
        embeddings = data.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise OllamaError("Ollama 임베딩 응답 형식 오류")
        return embeddings

    def chat(self, system: str, user: str) -> str:
        payload = {
            "model": self.llm_model,
            "stream": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "options": self.llm_options,
        }
        data = self._post("/api/chat", payload, timeout=self.timeout)
        content = (data.get("message") or {}).get("content")
        if not isinstance(content, str) or not content.strip():
            raise OllamaError("Ollama 채팅 응답 형식 오류")
        return content.strip()
