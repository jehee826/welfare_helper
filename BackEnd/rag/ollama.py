import httpx
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_ollama import ChatOllama

from BackEnd.rag.embeddings import validate_embeddings


class OllamaError(RuntimeError):
    """Ollama 호출이 실패했거나 응답 형식이 예상과 다를 때 발생한다."""


class OllamaClient:
    """임베딩 HTTP 호출과 LangChain의 Ollama 프롬프트·구조화 자료 선택을 담당한다."""

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
        self._chat_chain = None

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

    def chat(self, system: str, user: str) -> dict:
        try:
            if self._chat_chain is None:
                prompt = ChatPromptTemplate.from_messages([("system", "{system}"), ("human", "{user}")])
                model = ChatOllama(
                    model=self.llm_model, base_url=self.base_url, format="json",
                    client_kwargs={"timeout": self.timeout}, **self.llm_options,
                )
                self._chat_chain = prompt | model
            message = self._chat_chain.invoke({"system": system, "user": user})
            if message.response_metadata.get("done_reason") == "length":
                raise ValueError("응답이 잘렸습니다.")
            result = JsonOutputParser().invoke(message)
            if not isinstance(result, dict):
                raise ValueError("응답이 JSON 객체가 아닙니다.")
            return result
        except Exception as exc:
            raise OllamaError(f"LangChain Ollama 응답 실패: {type(exc).__name__}") from None
