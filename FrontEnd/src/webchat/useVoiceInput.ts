import { useCallback, useEffect, useRef, useState } from "react";

export const VOICE_LIMIT_MS = 30_000;
const STOP_GRACE_MS = 5_000;

type RecognitionResult = { isFinal: boolean; 0?: { transcript: string } };
type RecognitionEvent = { resultIndex?: number; results?: ArrayLike<RecognitionResult> };
type RecognitionError = { error?: string };

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionError) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const ctor = scope.SpeechRecognition || scope.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : null;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "마이크 사용이 허용되지 않았습니다. 브라우저 설정에서 허용하거나 직접 입력해 주세요.",
  "service-not-allowed": "이 브라우저에서 음성 인식을 사용할 수 없습니다. 직접 입력해 주세요.",
  "no-speech": "음성이 들리지 않았습니다. 다시 시도하거나 직접 입력해 주세요.",
  "audio-capture": "마이크를 찾지 못했습니다. 마이크 연결을 확인하거나 직접 입력해 주세요.",
  network: "음성 인식 서비스에 연결하지 못했습니다. 직접 입력해 주세요.",
  "language-not-supported": "한국어 음성 인식을 지원하지 않는 브라우저입니다. 직접 입력해 주세요.",
};
const FAILED = "음성을 알아듣지 못했습니다. 다시 시도하거나 직접 입력해 주세요.";
const APPLIED = "음성 내용을 입력창에 넣었습니다. 확인·수정한 뒤 직접 보내 주세요.";

/** 한국어 음성을 최대 30초 듣고 결과를 전달한다. 자동 전송하지 않는다. */
export function useVoiceInput(onText: (text: string) => void) {
  const supported = recognitionCtor() !== null;
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("");
  const current = useRef<Recognition | null>(null);
  const timers = useRef<number[]>([]);
  const received = useRef(false);
  const deliver = useRef(onText);
  deliver.current = onText;

  const release = useCallback((recognition: Recognition) => {
    if (current.current !== recognition) return false;
    current.current = null;
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    recognition.onresult = recognition.onerror = recognition.onend = null;
    setListening(false);
    return true;
  }, []);

  const cancel = useCallback(
    (message = "음성 입력을 취소했습니다.") => {
      const recognition = current.current;
      if (!recognition || !release(recognition)) return;
      try {
        recognition.abort();
      } catch {}
      setStatus(message);
    },
    [release],
  );

  const finish = useCallback(
    (message = "말씀을 정리하고 있습니다.") => {
      const recognition = current.current;
      if (!recognition) return;
      setStatus(message);
      try {
        recognition.stop();
      } catch {
        cancel(FAILED);
        return;
      }
      timers.current.push(
        window.setTimeout(() => {
          if (current.current === recognition) cancel(received.current ? APPLIED : FAILED);
        }, STOP_GRACE_MS),
      );
    },
    [cancel],
  );

  const start = useCallback(() => {
    if (current.current) return;
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setStatus("이 브라우저는 음성 입력을 지원하지 않습니다. 입력창에 직접 입력해 주세요.");
      return;
    }
    let recognition: Recognition;
    try {
      recognition = new Ctor();
    } catch {
      setStatus("음성 입력을 시작하지 못했습니다. 직접 입력하거나 다시 눌러 주세요.");
      return;
    }
    received.current = false;
    recognition.lang = "ko-KR";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      if (current.current !== recognition) return;
      const results = event.results;
      if (!results) return;
      const from = Number.isInteger(event.resultIndex) && (event.resultIndex as number) >= 0 ? (event.resultIndex as number) : 0;
      let text = "";
      for (let index = from; index < results.length; index += 1) {
        const result = results[index];
        if (result?.isFinal && typeof result[0]?.transcript === "string") text += result[0].transcript;
      }
      text = text.trim();
      if (!text) return;
      received.current = true;
      deliver.current(text);
    };
    recognition.onerror = (event) => {
      if (current.current !== recognition || event?.error === "aborted") return;
      release(recognition);
      try {
        recognition.abort();
      } catch {}
      setStatus((event?.error && ERRORS[event.error]) || FAILED);
    };
    recognition.onend = () => {
      if (!release(recognition)) return;
      setStatus(received.current ? APPLIED : FAILED);
    };
    current.current = recognition;
    try {
      recognition.start();
    } catch (error) {
      release(recognition);
      setStatus(error instanceof DOMException && error.name === "NotAllowedError" ? ERRORS["not-allowed"] : "음성 입력을 시작하지 못했습니다. 직접 입력하거나 다시 눌러 주세요.");
      return;
    }
    setListening(true);
    setStatus("듣고 있습니다. 말씀을 마치면 '말하기 끝'을 눌러 주세요.");
    timers.current.push(
      window.setTimeout(() => {
        if (current.current === recognition) finish("30초가 지나 음성 입력을 마칩니다.");
      }, VOICE_LIMIT_MS),
    );
  }, [finish, release]);

  useEffect(
    () => () => {
      const recognition = current.current;
      if (recognition && release(recognition)) {
        try {
          recognition.abort();
        } catch {}
      }
    },
    [release],
  );

  return { supported, listening, status, start, finish, cancel, clearStatus: () => setStatus("") };
}
