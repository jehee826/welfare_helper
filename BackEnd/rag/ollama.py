import httpx
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_ollama import ChatOllama

from BackEnd.rag.embeddings import validate_embeddings


class OllamaError(RuntimeError):
    """Ollama 호출이 실패했거나 응답 형식이 예상과 다를 때 발생한다."""


class ContextBudgetError(OllamaError):
    """생성 입력 또는 출력이 잘릴 위험이 있어 답변을 생성하지 않는다."""


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
        self._effective_context = None
        self._template_bytes = 0

    def model_digest(self, model: str | None = None) -> str:
        selected = model or self.embed_model
        try:
            response = httpx.get(f"{self.base_url}/api/tags", timeout=self.timeout)
            response.raise_for_status()
            models = response.json()["models"]
            if not isinstance(models, list) or any(not isinstance(row, dict) for row in models):
                raise ValueError
            names = {selected, selected + ":latest"} if ":" not in selected else {selected}
            matching = [r.get("digest") for r in models if r.get("name") in names]
            if any(not isinstance(digest, str) or not digest for digest in matching):
                raise ValueError
            matches = set(matching)
            if len(matches) != 1 or not all(isinstance(v, str) and v for v in matches):
                raise ValueError
            return matches.pop()
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise OllamaError("설치된 임베딩 모델 digest를 확인하지 못했습니다.") from None

    def context_limit(self) -> int:
        data = self._post("/api/show", {"model": self.llm_model}, self.timeout)
        info = data.get("model_info", {})
        if not isinstance(info, dict):
            raise ContextBudgetError("생성 모델 정보 형식이 올바르지 않습니다.")
        limits = [v for key, v in info.items() if key.endswith(".context_length") and type(v) is int and v > 0]
        if not limits:
            raise ContextBudgetError("생성 모델의 지원 문맥 길이를 확인하지 못했습니다.")
        self._template_bytes = len((str(data.get("template", "")) + str(data.get("system", ""))).encode("utf-8"))
        effective = min(min(limits), self.llm_options.get("num_ctx", 8192))
        if self._effective_context != effective:
            self._chat_chain = None
        self._effective_context = effective
        return self._effective_context

    def input_cost(self, system: str, user: str) -> int:
        # 정확한 생성 tokenizer가 없으므로 UTF-8 바이트 수와 템플릿·안전 여유를 보수적 상한으로 쓴다.
        return len((system + user).encode("utf-8")) + self._template_bytes + 256

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
            context = self._effective_context or self.context_limit()
            output = self.llm_options.get("num_predict", 512)
            if self.input_cost(system, user) + output > context:
                raise ContextBudgetError("필수 근거가 생성 문맥 예산을 초과했습니다.")
            if self._chat_chain is None:
                prompt = ChatPromptTemplate.from_messages([("system", "{system}"), ("human", "{user}")])
                model = ChatOllama(
                    model=self.llm_model, base_url=self.base_url, format="json",
                    client_kwargs={"timeout": self.timeout}, **{**self.llm_options, "num_ctx": context},
                )
                self._chat_chain = prompt | model
            message = self._chat_chain.invoke({"system": system, "user": user})
            if message.response_metadata.get("done_reason") == "length":
                raise ContextBudgetError("모델 출력이 잘렸습니다.")
            used = message.response_metadata.get("prompt_eval_count")
            if (message.response_metadata.get("truncated") is True
                    or isinstance(used, int) and used >= context - output):
                raise ContextBudgetError("모델 입력 잘림 가능성을 감지했습니다.")
            result = JsonOutputParser().invoke(message)
            if not isinstance(result, dict):
                raise ValueError("응답이 JSON 객체가 아닙니다.")
            return result
        except ContextBudgetError:
            raise
        except Exception as exc:
            raise OllamaError(f"LangChain Ollama 응답 실패: {type(exc).__name__}") from None
