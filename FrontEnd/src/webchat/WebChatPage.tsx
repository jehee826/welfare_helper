import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Contacts } from "./Contacts";
import { useSpeech } from "./useSpeech";
import { useVoiceInput } from "./useVoiceInput";
import {
  ApiError,
  CAPABILITIES_TIMEOUT_MS,
  ERROR_MESSAGES,
  QUERY_LIMIT,
  TIMEOUT_SECONDS,
  apiBase,
  fetchReferralEnabled,
  postChat,
  queryLength,
  type ApiErrorCode,
  type ChatResponse,
} from "./chatApi";
import { spokenAnswer } from "./speech";
import "./webchat.css";

type Phase =
  | { kind: "idle" }
  | { kind: "loading"; question: string; stage: "check" | "answer" }
  | { kind: "done"; question: string; response: ChatResponse }
  | { kind: "error"; question: string; code: ApiErrorCode }
  | { kind: "canceled"; question: string };

type Referral = "checking" | "enabled" | "disabled" | "unknown";

type Active = { id: number; controller: AbortController; timer: number; question: string };

const HINT = "질문마다 서비스 이름과 필요한 조건을 함께 적어 주세요.";
const REFERRAL_NOTICE =
  "연락처 안내 기록: 답변에 문의처가 나오면 기관명·전화번호·출처·문서 버전을 익명으로 기록하고 90일 뒤 자동 삭제합니다. 질문·답변·IP는 이 기록에 저장하지 않습니다.";

function linkedSignal(parent: AbortSignal, ms: number) {
  const child = new AbortController();
  const abort = () => child.abort();
  parent.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(abort, ms);
  return {
    signal: child.signal,
    done: () => {
      window.clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

async function checkReferral(base: string, signal: AbortSignal): Promise<boolean> {
  const linked = linkedSignal(signal, CAPABILITIES_TIMEOUT_MS);
  try {
    return await fetchReferralEnabled(base, linked.signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw error instanceof ApiError ? error : new ApiError("capabilities");
  } finally {
    linked.done();
  }
}

/** 질문 하나를 보내고 답변·연락처를 표시하는 단발성 상담 화면이다. 상담 내용은 메모리에만 둔다. */
export function WebChatPage({ baseUrl = apiBase() }: { baseUrl?: string | null }) {
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [referral, setReferral] = useState<Referral>(baseUrl ? "checking" : "unknown");
  const [elapsed, setElapsed] = useState(0);
  const active = useRef<Active | null>(null);
  const sequence = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const speech = useSpeech();

  const voice = useVoiceInput(
    useCallback((text: string) => {
      setDraft((previous) => {
        const kept = previous.replace(/\s+$/, "");
        return kept ? `${kept} ${text}` : text;
      });
      setInputError("");
      input.current?.focus();
    }, []),
  );

  const loading = phase.kind === "loading";
  const length = queryLength(draft);
  const over = length > QUERY_LIMIT;

  useEffect(() => {
    const previous = document.title;
    document.title = "곁에 · 복지 안내";
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (!baseUrl) return;
    const controller = new AbortController();
    checkReferral(baseUrl, controller.signal)
      .then((enabled) => setReferral(enabled ? "enabled" : "disabled"))
      .catch(() => {
        if (!controller.signal.aborted) setReferral("unknown");
      });
    return () => controller.abort();
  }, [baseUrl]);

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (phase.kind === "done") resultHeading.current?.focus();
  }, [phase]);

  const releaseActive = useCallback(() => {
    const current = active.current;
    active.current = null;
    if (current) window.clearTimeout(current.timer);
    return current;
  }, []);

  useEffect(
    () => () => {
      releaseActive()?.controller.abort();
    },
    [releaseActive],
  );

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (active.current || !baseUrl) return;
    const query = draft.trim();
    if (!query) {
      setInputError("질문을 입력해 주세요.");
      input.current?.focus();
      return;
    }
    if (queryLength(query) > QUERY_LIMIT) {
      setInputError(`질문은 ${QUERY_LIMIT}자 이내로 줄여 주세요. 지금 ${queryLength(query)}자입니다.`);
      input.current?.focus();
      return;
    }
    setInputError("");
    voice.cancel("");
    speech.stop();
    speech.clearNotice();

    const id = ++sequence.current;
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMEOUT_SECONDS * 1000);
    active.current = { id, controller, timer, question: query };
    setPhase({ kind: "loading", question: query, stage: "check" });

    try {
      const enabled = await checkReferral(baseUrl, controller.signal);
      if (active.current?.id !== id) return;
      setReferral(enabled ? "enabled" : "disabled");
      setPhase({ kind: "loading", question: query, stage: "answer" });
      const response = await postChat(baseUrl, query, controller.signal);
      if (active.current?.id !== id) return;
      releaseActive();
      setPhase({ kind: "done", question: query, response });
      setDraft((current) => (current.trim() === query ? "" : current));
    } catch (error) {
      if (active.current?.id !== id) return;
      releaseActive();
      const code: ApiErrorCode = timedOut ? "timeout" : error instanceof ApiError ? error.code : "network";
      if (code === "capabilities") setReferral("unknown");
      setPhase({ kind: "error", question: query, code });
      input.current?.focus();
    }
  };

  const cancelRequest = () => {
    const current = releaseActive();
    if (!current) return;
    current.controller.abort();
    setPhase({ kind: "canceled", question: current.question });
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };

  const onChange = (value: string) => {
    if (voice.listening) voice.cancel("입력창을 직접 고쳐서 음성 입력을 멈췄습니다.");
    setDraft(value);
    if (inputError) setInputError("");
  };

  const describedBy = ["question-hint", "question-count", inputError ? "question-error" : ""].filter(Boolean).join(" ");

  return (
    <div className="wc-root">
    <div className="wc-page">
      <header className="wc-header">
        <p className="wc-brand">
          곁에<span className="wc-brand-sub">복지 안내</span>
        </p>
      </header>

      <main>
        <div className="wc-intro">
          <h1>복지 안내 질문하기</h1>
          <p className="wc-lead">질문 하나를 보내면 공식 문서를 바탕으로 답변과 문의처를 알려 드립니다.</p>
        </div>
        {!baseUrl ? (
          <p className="wc-banner wc-banner-error" role="alert">
            {ERROR_MESSAGES.config}
          </p>
        ) : null}

        <form className="wc-ask" onSubmit={(event) => void submit(event)} noValidate aria-busy={loading}>
          <label htmlFor="question" className="wc-field-label">
            질문
          </label>
          <p id="question-hint" className="wc-hint">
            {HINT}
          </p>
          <textarea
            id="question"
            ref={input}
            rows={4}
            value={draft}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="예: 기초연금 신청 방법과 문의처를 알려줘."
            aria-describedby={describedBy}
            aria-invalid={inputError || over ? true : undefined}
            autoComplete="off"
          />
          <p id="question-count" className={over ? "wc-count wc-count-over" : "wc-count"}>
            {length} / {QUERY_LIMIT}자{over ? " (글자 수를 줄여 주세요)" : ""}
          </p>
          {inputError ? (
            <p id="question-error" className="wc-field-error" role="alert">
              {inputError}
            </p>
          ) : null}

          <div className="wc-actions">
            <button type="submit" className="wc-button wc-button-primary" disabled={!baseUrl} aria-disabled={loading || undefined}>
              {loading ? "보내는 중" : "보내기"}
            </button>
            {loading ? (
              <button type="button" className="wc-button wc-button-danger" onClick={cancelRequest}>
                요청 취소
              </button>
            ) : null}
            {voice.listening ? (
              <>
                <button type="button" className="wc-button" onClick={() => voice.finish()}>
                  말하기 끝
                </button>
                <button type="button" className="wc-button" onClick={() => voice.cancel()}>
                  음성 취소
                </button>
              </>
            ) : (
              <button type="button" className="wc-button" onClick={voice.start} disabled={!voice.supported}>
                음성 입력
              </button>
            )}
          </div>

          {!voice.supported ? <p className="wc-note">이 브라우저는 음성 입력을 지원하지 않습니다. 입력창에 직접 입력해 주세요.</p> : null}
          {voice.listening ? (
            <p className="wc-note wc-note-warning">음성이 브라우저의 외부 음성 인식 서비스로 전송될 수 있습니다. 민감한 개인정보는 말하지 마세요.</p>
          ) : null}
          <p className="wc-voice-status" role="status">
            {voice.status}
          </p>

          {referral === "enabled" ? <p className="wc-note">{REFERRAL_NOTICE}</p> : null}
          {referral === "unknown" && baseUrl ? <p className="wc-note">연락처 안내 기록 설정을 확인하지 못했습니다. 보내기를 누르면 다시 확인합니다.</p> : null}
        </form>

        <section className="wc-result" aria-label="답변">
          {phase.kind === "loading" ? (
            <div className="wc-panel">
              <Asked question={phase.question} />
              <div role="status" className="wc-loading">
                <p className="wc-loading-title">{phase.stage === "check" ? "연결을 확인하고 있습니다." : "답변을 준비하고 있습니다."}</p>
                <p>몇 분 걸릴 수 있습니다. 기다리는 동안 '요청 취소'를 누를 수 있습니다.</p>
              </div>
              <p className="wc-elapsed" aria-hidden="true">
                {elapsed}초 지남
              </p>
            </div>
          ) : null}

          {phase.kind === "done" ? (
            <article className="wc-panel">
              <Asked question={phase.question} />
              <h2 ref={resultHeading} tabIndex={-1}>
                {phase.response.kind === "answer" ? "답변" : "안내"}
              </h2>
              <div className="wc-answer-text">{phase.response.text}</div>
              <div className="wc-speech-row">
                <button
                  type="button"
                  className="wc-button"
                  aria-pressed={speech.speaking}
                  onClick={() => (speech.speaking ? speech.stop() : void speech.speak(spokenAnswer(phase.response)))}
                >
                  {speech.speaking ? "읽기 정지" : "답변 읽기"}
                </button>
              </div>
              <p className="wc-speech-status" role="status">
                {speech.notice}
              </p>
              <Contacts contacts={phase.response.contacts} />
              <p className="wc-disclaimer">답변은 안내용입니다. 실제 대상 여부와 신청은 담당 기관에서 확인해 주세요.</p>
            </article>
          ) : null}

          {phase.kind === "error" ? (
            <div className="wc-banner wc-banner-error" role="alert">
              <p>{ERROR_MESSAGES[phase.code]}</p>
              <p>입력한 질문은 그대로 남아 있습니다. 확인한 뒤 다시 보내 주세요.</p>
            </div>
          ) : null}

          {phase.kind === "canceled" ? (
            <div className="wc-banner" role="status">
              <p>요청을 취소했습니다. 이 요청의 결과는 화면에 표시하지 않습니다.</p>
              <p>서버에서는 이미 시작된 처리가 잠시 이어질 수 있습니다.</p>
            </div>
          ) : null}
        </section>
      </main>

      <footer className="wc-bottom">
        <p>새로고침하면 질문과 답변이 지워집니다. 상담 내용은 이 기기에 저장하지 않습니다.</p>
      </footer>
    </div>
    </div>
  );
}

function Asked({ question }: { question: string }) {
  return (
    <div className="wc-asked">
      <p className="wc-asked-label">내 질문</p>
      <p className="wc-asked-text">{question}</p>
    </div>
  );
}
