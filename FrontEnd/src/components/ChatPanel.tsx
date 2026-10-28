import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatAnswer, DocumentChatAnswer, UserProfile, WelfareApi } from "../api/types";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { documentError } from "../api/documentApi";
import { SuggestionChips } from "./SuggestionChips";
import { VoiceButton } from "./VoiceButton";

const VOICE_FAILURE_LIMIT = 2;

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "bot"; text: string }
  | { id: number; role: "answer"; answer: DocumentChatAnswer };

interface Props {
  api: Pick<WelfareApi, "initialSuggestions"> & {
    ask: (query: string, profile: UserProfile | null, signal?: AbortSignal) => Promise<DocumentChatAnswer>;
  };
  profile: UserProfile | null;
  onAnswered: (question: string, answer: ChatAnswer) => void;
}

export function ChatPanel({ api, profile, onAnswered }: Props) {
  const greeting = "등록한 문서에 대해 궁금한 내용을 질문해 주세요.";
  const [messages, setMessages] = useState<Message[]>([{ id: 0, role: "bot", text: greeting }]);
  const [suggestions, setSuggestions] = useState(() => api.initialSuggestions(profile));
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController>();

  useEffect(() => () => requestRef.current?.abort(), []);

  const handleTranscript = useCallback((text: string) => {
    setInput(text);
    inputRef.current?.focus();
  }, []);
  const voice = useSpeechRecognition(handleTranscript);
  const voiceStuck = voice.failures >= VOICE_FAILURE_LIMIT && !voice.listening;

  useEffect(() => {
    const last = logRef.current?.lastElementChild as HTMLElement | null | undefined;
    const isAnswer = !pending && messages[messages.length - 1]?.role === "answer";
    last?.scrollIntoView?.({ block: isAnswer ? "start" : "nearest", behavior: "smooth" });
  }, [messages, pending]);

  async function send(question: string) {
    const text = question.trim();
    if (!text || requestRef.current) return;
    const request = new AbortController();
    requestRef.current = request;
    setMessages((m) => [...m, { id: nextId.current++, role: "user", text }]);
    setInput("");
    setPending(true);
    try {
      const answer = await api.ask(text, profile, request.signal);
      if (request.signal.aborted) return;
      setMessages((m) => [...m, { id: nextId.current++, role: "answer", answer }]);
      setSuggestions(answer.suggestions);
      onAnswered(text, answer);
    } catch (error) {
      if (request.signal.aborted) return;
      setMessages((m) => [
        ...m,
        { id: nextId.current++, role: "bot", text: documentError(error) },
      ]);
    } finally {
      if (!request.signal.aborted) setPending(false);
      if (requestRef.current === request) requestRef.current = undefined;
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  return (
    <section className="chat card" aria-label="채팅">
      <div ref={logRef} className="chat__log" role="log" aria-live="polite" aria-label="상담 내용">
        {messages.map((m) => {
          if (m.role === "user") return <p key={m.id} className="bubble bubble--user">{m.text}</p>;
          if (m.role === "bot") return <p key={m.id} className="bubble bubble--bot">{m.text}</p>;
          return <div key={m.id} className="bubble bubble--bot">
            <p className="badge">{m.answer.kind === "answer" ? "모델 답변" : "문서에서 확인하지 못했어요"}</p>
            <p className="bubble__text">{m.answer.text}</p>
            {!!m.answer.evidence?.length && <details>
              <summary>원문 근거 보기 ({m.answer.evidence.length}건)</summary>
              <ol>{m.answer.evidence.map((item, index) => <li key={`${item.chunk_id}:${index}`}>
                <p className="badge">{item.role === "retrieved" ? "검색 원문" : item.role === "required_context" ? "필수 원문 맥락" : "답변 인용"}</p>
                {item.role === "retrieved" && <p className="muted small">모델에 전달한 검색 자료입니다. 모델 답변의 정확한 인용으로 검증한 내용은 아닙니다.</p>}
                {item.role === "required_context" && <p className="muted small">답변과 함께 확인할 조건·예외의 원문입니다.</p>}
                {item.quote.trim() && <blockquote>{item.quote}</blockquote>}
                <p className="bubble__text">{item.context}</p>
                <p className="muted small">쪽: {item.pages.length ? item.pages.join(", ") : "미확인"} · 원문 블록: {item.source_blocks.join(", ")}</p>
                <p className="bubble__text muted small">출처: {item.source_url || "미확인"}</p>
              </li>)}</ol>
            </details>}
          </div>;
        })}
        {pending && (
          <p className="bubble bubble--bot bubble--pending" role="status">
            찾고 있어요…
          </p>
        )}
      </div>

      {voiceStuck && (
        <p className="voice-help" role="status">
          음성 인식이 잘 안 되네요. 궁금한 내용을 직접 입력해 주세요.
        </p>
      )}
      {voice.listening && (
        <p className="voice-help" role="status">
          듣고 있어요. 천천히 말씀해 주세요.
        </p>
      )}

      <SuggestionChips suggestions={suggestions} disabled={pending} highlighted={voiceStuck} onPick={send} />

      <form className="composer" onSubmit={handleSubmit}>
        <label htmlFor="chat-input" className="sr-only">
          궁금한 내용
        </label>
        <input
          id="chat-input"
          ref={inputRef}
          value={input}
          maxLength={300}
          onChange={(e) => setInput(e.target.value)}
          placeholder="예: 등록한 문서의 내용을 알려 주세요"
          autoComplete="off"
        />
        {voice.supported && (
          <VoiceButton listening={voice.listening} disabled={pending} onStart={voice.start} onStop={voice.stop} />
        )}
        <button type="submit" className="icon-btn icon-btn--primary" aria-label="질문 보내기" disabled={pending || !input.trim()}>
          <span aria-hidden="true">↑</span>
        </button>
      </form>
      <p className="muted small center scope-notice">등록된 원문을 검색해 모델이 답변합니다. 검색 원문과 페이지를 펼쳐 답변과 대조해 주세요.</p>
    </section>
  );
}
