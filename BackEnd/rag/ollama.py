import httpx

from BackEnd.rag.embeddings import validate_embeddings


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
        embed_dim: int = 1024,
    ):
        self.base_url = base_url.rstrip("/")
        self.embed_model = embed_model
        self.llm_model = llm_model
        self.timeout = timeout
        self.llm_options = llm_options or {}
        self.embed_dim = embed_dim

    def _post(self, path: str, payload: dict, timeout: float) -> dict:
        try:
            response = httpx.post(f"{self.base_url}{path}", json=payload, timeout=timeout)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaError(f"Ollama {path} 호출 실패: {exc.__class__.__name__}") from exc
        if not isinstance(data, dict):
            raise OllamaError("Ollama 응답이 JSON 객체가 아닙니다.")
        return data

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        data = self._post(
            "/api/embed",
            {"model": self.embed_model, "input": texts, "truncate": False},
            timeout=self.timeout,
        )
        embeddings = data.get("embeddings")
        try:
            validate_embeddings(embeddings, len(texts), self.embed_dim)
        except ValueError as exc:
            raise OllamaError(str(exc)) from exc
        return embeddings

    def chat(self, system: str, user: str) -> str:
        payload = {
            "model": self.llm_model,
            "stream": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "options": self.llm_options,
        }
        data = self._post("/api/chat", payload, timeout=self.timeout)
        message = data.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if data.get("done") is False or data.get("done_reason") == "length":
            raise OllamaError("Ollama 응답이 완료되기 전에 잘렸습니다.")
        if not isinstance(content, str) or not content.strip():
            raise OllamaError("Ollama 채팅 응답 형식 오류")
        return content.strip()
