import { useCallback, useEffect, useRef, useState } from "react";

interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * 브라우저 Web Speech API로 한국어 음성을 텍스트로 바꾼다.
 * 인식 결과가 없거나 오류가 나면 failures를 1 올리고, 성공하면 0으로 되돌린다.
 */
export function useSpeechRecognition(onTranscript: (text: string) => void) {
  const ctor = getRecognitionCtor();
  const [listening, setListening] = useState(false);
  const [failures, setFailures] = useState(0);
  const recognitionRef = useRef<Recognition | null>(null);
  const gotResultRef = useRef(false);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  const start = useCallback(() => {
    if (!ctor || listening) return;
    const recognition = new ctor();
    recognition.lang = "ko-KR";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    gotResultRef.current = false;
    recognition.onresult = (event) => {
      const text = event.results[0]?.[0]?.transcript?.trim() ?? "";
      if (text) {
        gotResultRef.current = true;
        setFailures(0);
        onTranscript(text);
      }
    };
    recognition.onerror = () => {
      gotResultRef.current = false;
    };
    recognition.onend = () => {
      setListening(false);
      if (!gotResultRef.current) setFailures((n) => n + 1);
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [ctor, listening, onTranscript]);

  const stop = useCallback(() => recognitionRef.current?.abort(), []);

  return { supported: ctor !== null, listening, failures, start, stop };
}
