import httpx
import asyncio
import json
from contextlib import asynccontextmanager
from time import monotonic
from typing import Callable
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_ollama import ChatOllama
from langchain_core.messages import AIMessage

from BackEnd.rag.embeddings import validate_embeddings
from BackEnd.core.execution import ExecutionTimeoutError, ExecutionCancelledError, GenerationStopped
from BackEnd.core.qa_diagnostics import model_call, model_content


class OllamaError(RuntimeError):
    """Ollama 호출이 실패했거나 응답 형식이 예상과 다를 때 발생한다."""


class ContextBudgetError(OllamaError):
    """생성 입력 또는 출력이 잘릴 위험이 있어 답변을 생성하지 않는다."""


class GenerationTimeoutError(OllamaError, ExecutionTimeoutError):
    """화면 요청의 남은 생성 예산이 소진됐다."""


class GenerationCancelledError(OllamaError, ExecutionCancelledError):
    """화면 요청의 연결이 끊겨 생성 HTTP 스트림을 닫는다."""


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
        request_deadline: float | None = None,
        request_cancelled: Callable[[], bool] | None = None,
        embed_cpu_only: bool = False,
    ):
        self.base_url = base_url.rstrip("/")
        self.embed_model = embed_model
        self.llm_model = llm_model
        self.timeout = timeout
        self.llm_options = llm_options or {}
        self.embed_dim = embed_dim
        self.embed_cpu_only = embed_cpu_only
        self.request_deadline = request_deadline
        self.request_cancelled = request_cancelled
        self._chat_chain = None
        self._effective_context = None
        self._template_bytes = 0
        self.last_chat_diagnostics = {}

    def for_request(self, deadline: float, cancelled: Callable[[], bool]):
        return OllamaClient(self.base_url, self.embed_model, self.llm_model, self.timeout,
                            dict(self.llm_options), self.embed_dim, deadline, cancelled,
                            embed_cpu_only=self.embed_cpu_only)

    def remaining_timeout(self) -> float:
        if self.request_cancelled and self.request_cancelled():
            raise GenerationCancelledError("화면 요청 연결이 종료됐습니다.")
        if self.request_deadline is None:
            return self.timeout
        remaining = self.request_deadline - monotonic()
        if remaining <= 0:
            raise GenerationTimeoutError("화면 요청의 처리 시간을 넘었습니다.")
        return min(self.timeout, remaining)

    @asynccontextmanager
    async def _request_window(self, timeout):
        owner, cancelled = asyncio.current_task(), False
        async def watch_cancel():
            nonlocal cancelled
            while True:
                if self.request_cancelled():
                    cancelled = True
                    owner.cancel()
                    return
                await asyncio.sleep(0.05)
        watcher = asyncio.create_task(watch_cancel()) if self.request_cancelled else None
        try:
            async with asyncio.timeout(timeout):
                yield
        except asyncio.CancelledError:
            if cancelled:
                raise GenerationCancelledError("화면 요청 연결이 종료됐습니다.") from None
            raise
        finally:
            if watcher:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)

    def model_digest(self, model: str | None = None) -> str:
        selected = model or self.embed_model
        try:
            if self.request_deadline is not None:
                data = asyncio.run(self._get_before_deadline("/api/tags"))
            else:
                response = httpx.get(f"{self.base_url}/api/tags", timeout=self.timeout)
                response.raise_for_status()
                data = response.json()
            models = data["models"]
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
        except (httpx.TimeoutException, TimeoutError):
            raise GenerationTimeoutError("모델 식별 조회 시간을 넘었습니다.") from None
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
            if self.request_deadline is not None:
                data = asyncio.run(self._post_before_deadline(path, payload, timeout))
            else:
                response = httpx.post(f"{self.base_url}{path}", json=payload, timeout=timeout)
                response.raise_for_status()
                data = response.json()
        except (httpx.TimeoutException, TimeoutError):
            raise GenerationTimeoutError("Ollama 응답 대기 시간을 넘었습니다.") from None
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaError(f"Ollama {path} 호출 실패: {exc.__class__.__name__}") from exc
        if not isinstance(data, dict):
            raise OllamaError("Ollama 응답이 JSON 객체가 아닙니다.")
        return data

    async def _post_before_deadline(self, path, payload, timeout):
        remaining = min(timeout, self.remaining_timeout())
        async with self._request_window(remaining):
            async with httpx.AsyncClient(timeout=remaining) as client:
                response = await client.post(f"{self.base_url}{path}", json=payload)
                response.raise_for_status()
                return response.json()

    async def _get_before_deadline(self, path):
        remaining = self.remaining_timeout()
        async with self._request_window(remaining):
            async with httpx.AsyncClient(timeout=remaining) as client:
                response = await client.get(f"{self.base_url}{path}")
                response.raise_for_status()
                return response.json()

    async def _chat_before_deadline(self, system, user, schema, context, *, plain_text=False, on_content=None,
                                    num_predict=None):
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        options = {**self.llm_options, "num_ctx": context}
        if num_predict is not None:
            options["num_predict"] = num_predict
        payload = {"model": self.llm_model, "messages": messages, "stream": True, "options": options}
        if not plain_text:
            payload["format"] = schema if schema is not None else "json"
        parts, metadata = [], {}
        done = False

        def consume(line):
            nonlocal metadata
            if not line.strip():
                return False
            data = json.loads(line)
            if not isinstance(data, dict) or "error" in data:
                raise OllamaError("생성 스트림의 형식을 확인하지 못했습니다.")
            content = data.get("message", {}).get("content", "")
            if not isinstance(content, str):
                raise OllamaError("생성 스트림의 텍스트 형식이 올바르지 않습니다.")
            parts.append(content)
            model_content(content)
            if data.get("done") is True:
                metadata = {key: data[key] for key in ("done_reason", "prompt_eval_count", "eval_count", "truncated",
                    "total_duration", "load_duration", "prompt_eval_duration", "eval_duration") if key in data}
                timing.update(metadata)
            if on_content is not None and content:
                on_content(content)
            return data.get("done") is True

        # read timeout과 달리 토큰이 계속 와도 전체 예산에 도달하면 소켓 스트림을 닫는다.
        remaining = self.remaining_timeout()
        with model_call(self.llm_model) as timing:
            async with self._request_window(remaining):
                async with httpx.AsyncClient(timeout=remaining) as client:
                    async with client.stream("POST", f"{self.base_url}/api/chat", json=payload,
                                             headers={"Accept-Encoding": "identity"}) as response:
                        response.raise_for_status()
                        buffer, total = b"", 0
                        async for chunk in response.aiter_bytes():
                            self.remaining_timeout()
                            total += len(chunk)
                            if total > 2 * 1024 * 1024:
                                raise OllamaError("생성 스트림의 크기 한도를 넘었습니다.")
                            buffer += chunk
                            while b"\n" in buffer:
                                line, buffer = buffer.split(b"\n", 1)
                                if consume(line):
                                    done = True
                                    break
                            if done:
                                break
                        if not done and buffer:
                            done = consume(buffer)
                        if not done:
                            raise OllamaError("생성 스트림이 완료 전에 끊겼습니다.")
        return AIMessage(content="".join(parts), response_metadata=metadata)

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        payload = {"model": self.embed_model, "input": texts, "truncate": False}
        if self.embed_cpu_only:
            # 작은 임베딩 모델이 생성 모델의 GPU 메모리를 축출하지 않도록 분리한다.
            payload["options"] = {"num_gpu": 0}
        with model_call(self.embed_model, input_count=len(texts)) as timing:
            data = self._post("/api/embed", payload, timeout=self.timeout)
            timing.update(data)
            embeddings = data.get("embeddings")
            try:
                validate_embeddings(embeddings, len(texts), self.embed_dim)
            except ValueError as exc:
                raise OllamaError(str(exc)) from exc
        return embeddings

    def chat_text(self, system: str, user: str) -> str:
        """문서 질의는 JSON 선택 형식 없이 모델의 일반 텍스트 응답을 받는다."""
        self.last_chat_diagnostics = {}
        try:
            if self.request_deadline is not None:
                message = asyncio.run(self._chat_before_deadline(system, user, None,
                    self.llm_options.get("num_ctx", 8192), plain_text=True))
            else:
                prompt = ChatPromptTemplate.from_messages([("system", "{system}"), ("human", "{user}")])
                model = ChatOllama(model=self.llm_model, base_url=self.base_url,
                                   client_kwargs={"timeout": self.timeout}, **self.llm_options)
                with model_call(self.llm_model) as timing:
                    message = (prompt | model).invoke({"system": system, "user": user})
                    timing.update(message.response_metadata)
            self.last_chat_diagnostics = {key: message.response_metadata[key]
                for key in ("done_reason", "prompt_eval_count", "eval_count", "truncated", "total_duration",
                            "load_duration", "prompt_eval_duration", "eval_duration")
                if key in message.response_metadata}
            if not isinstance(message.content, str) or not message.content.strip():
                raise OllamaError("생성 모델의 텍스트 응답이 비어 있습니다.")
            return message.content.strip()
        except (httpx.TimeoutException, TimeoutError):
            raise GenerationTimeoutError("문서 답변 처리 시간을 넘었습니다.") from None
        except OllamaError:
            raise
        except Exception as exc:
            raise OllamaError(f"LangChain Ollama 텍스트 응답 실패: {type(exc).__name__}") from None

    def chat(self, system: str, user: str, *, schema: dict | None = None, on_content=None,
             num_predict: int | None = None) -> dict:
        """on_content는 기한이 있는 요청의 스트림 조각을 받는다. 최종 결과는 기존 검증을 거친 JSON만 반환한다.

        on_content가 GenerationStopped를 올리면 스트림을 닫아 생성을 멈추고 그 예외를 그대로 전달한다.
        num_predict는 이 호출에만 적용하는 출력 토큰 한도다.
        """
        self.last_chat_diagnostics = {}
        try:
            context = self._effective_context or self.context_limit()
            output = num_predict or self.llm_options.get("num_predict", 512)
            if self.input_cost(system, user) + output > context:
                raise ContextBudgetError("필수 근거가 생성 문맥 예산을 초과했습니다.")
            if self.request_deadline is not None:
                message = asyncio.run(self._chat_before_deadline(system, user, schema, context, on_content=on_content,
                                                                 num_predict=num_predict))
            elif self._chat_chain is None or schema is not None or num_predict:
                prompt = ChatPromptTemplate.from_messages([("system", "{system}"), ("human", "{user}")])
                model = ChatOllama(
                    model=self.llm_model, base_url=self.base_url, format=schema if schema is not None else "json",
                    client_kwargs={"timeout": self.remaining_timeout()},
                    **{**self.llm_options, "num_ctx": context, **({"num_predict": num_predict} if num_predict else {})},
                )
                chain = prompt | model
                # 요청별 자료·문장 선택 문법은 공유 캐시에 넣지 않는다.
                if schema is None and not num_predict:
                    self._chat_chain = chain
            else:
                chain = self._chat_chain
            if self.request_deadline is None:
                with model_call(self.llm_model) as timing:
                    message = chain.invoke({"system": system, "user": user})
                    timing.update(message.response_metadata)
            self.remaining_timeout()
            self.last_chat_diagnostics = {key: message.response_metadata[key]
                                          for key in ("done_reason", "prompt_eval_count", "eval_count", "truncated",
                                                      "total_duration", "load_duration", "prompt_eval_duration", "eval_duration")
                                          if key in message.response_metadata}
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
        except (ContextBudgetError, GenerationTimeoutError, GenerationCancelledError, GenerationStopped):
            raise
        except (httpx.TimeoutException, TimeoutError):
            raise GenerationTimeoutError("Ollama 응답 대기 시간을 넘었습니다.") from None
        except Exception as exc:
            raise OllamaError(f"LangChain Ollama 응답 실패: {type(exc).__name__}") from None
