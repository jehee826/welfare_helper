import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatAnswer, UserProfile, WelfareApi } from "../api/types";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { AnswerCard } from "./AnswerCard";
import { FallbackCard } from "./FallbackCard";
import { SuggestionChips } from "./SuggestionChips";
import { VoiceButton } from "./VoiceButton";

const VOICE_FAILURE_LIMIT = 2;

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "bot"; text: string }
  | { id: number; role: "answer"; answer: ChatAnswer };

interface Props {
  api: WelfareApi;
  profile: UserProfile | null;
  onAnswered: (question: string, answer: ChatAnswer) => void;
}

export function ChatPanel({ api, profile, onAnswered }: Props) {
  const greeting = profile
    ? "조건을 확인했어요. 궁금한 내용을 말하거나, 아래 버튼을 눌러 보세요."
    : "안녕하세요. 어떤 도움이 필요하세요? 궁금한 내용을 편하게 적거나 아래 버튼을 눌러 보세요.";
  const [messages, setMessages] = useState<Message[]>([{ id: 0, role: "bot", text: greeting }]);
  const [suggestions, setSuggestions] = useState(() => api.initialSuggestions(profile));
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (!text || pending) return;
    setMessages((m) => [...m, { id: nextId.current++, role: "user", text }]);
    setInput("");
    setPending(true);
    try {
      const answer = await api.ask(text, profile);
      setMessages((m) => [...m, { id: nextId.current++, role: "answer", answer }]);
      setSuggestions(answer.suggestions);
      onAnswered(text, answer);
    } catch {
      setMessages((m) => [
        ...m,
        { id: nextId.current++, role: "bot", text: "잠시 문제가 생겼어요. 조금 뒤에 다시 시도해 주세요. 급하면 보건복지상담센터 129로 전화해 주세요." },
      ]);
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  return (
    <section className="chat card" aria-label="복지 상담">
      <div ref={logRef} className="chat__log" role="log" aria-live="polite" aria-label="상담 내용">
        {messages.map((m) => {
          if (m.role === "user") return <p key={m.id} className="bubble bubble--user">{m.text}</p>;
          if (m.role === "bot") return <p key={m.id} className="bubble bubble--bot">{m.text}</p>;
          return m.answer.kind === "answer" ? (
            <AnswerCard key={m.id} text={m.answer.text} services={m.answer.services} />
          ) : (
            <FallbackCard key={m.id} text={m.answer.text} contacts={m.answer.contacts} />
          );
        })}
        {pending && (
          <p className="bubble bubble--bot bubble--pending" role="status">
            찾고 있어요…
          </p>
        )}
      </div>

      {voiceStuck && (
        <p className="voice-help" role="status">
          음성 인식이 잘 안 되네요. 아래 버튼을 눌러 질문을 골라 보세요.
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
          placeholder="예: 혼자 사는데 생활비가 부족해요"
          autoComplete="off"
        />
        {voice.supported && (
          <VoiceButton listening={voice.listening} disabled={pending} onStart={voice.start} onStop={voice.stop} />
        )}
        <button type="submit" className="icon-btn icon-btn--primary" aria-label="질문 보내기" disabled={pending || !input.trim()}>
          <span aria-hidden="true">↑</span>
        </button>
      </form>
      <p className="muted small center">AI 안내는 참고용이에요. 실제 자격은 담당 기관에서 확인해 주세요.</p>
    </section>
  );
}
