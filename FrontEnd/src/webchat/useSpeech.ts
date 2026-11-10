import { useCallback, useEffect, useRef, useState } from "react";
import { speechChunks, speechText } from "./speech";

const KOREAN = /^ko([-_]|$)/i;

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined" || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") return null;
  return window.speechSynthesis;
}

function localKoreanVoice(engine: SpeechSynthesis): SpeechSynthesisVoice | null {
  try {
    return engine.getVoices().find((voice) => voice.localService === true && KOREAN.test(voice.lang || "")) || null;
  } catch {
    return null;
  }
}

function cancelAll() {
  try {
    synth()?.cancel();
  } catch {}
}

async function waitForVoice(engine: SpeechSynthesis): Promise<SpeechSynthesisVoice | null> {
  const found = localKoreanVoice(engine);
  if (found) return found;
  let listed = 0;
  try {
    listed = engine.getVoices().length;
  } catch {
    return null;
  }
  if (listed) return null;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      engine.removeEventListener?.("voiceschanged", done);
      resolve(localKoreanVoice(engine));
    };
    const timer = setTimeout(done, 1500);
    engine.addEventListener?.("voiceschanged", done);
  });
}

/** 기기 내 한국어 음성으로만 읽는다. 외부 음성 서비스로 보내지 않는다. */
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState("");
  const version = useRef(0);

  const stop = useCallback(() => {
    version.current += 1;
    setSpeaking(false);
    cancelAll();
  }, []);

  const speak = useCallback(
    async (text: string) => {
      stop();
      setNotice("");
      const engine = synth();
      if (!engine) {
        setNotice("이 브라우저는 답변 읽기를 지원하지 않습니다. 화면의 답변을 확인해 주세요.");
        return;
      }
      const owner = version.current;
      const voice = await waitForVoice(engine);
      if (owner !== version.current) return;
      if (!voice) {
        setNotice("이 기기에 한국어 음성이 없어 읽을 수 없습니다. 외부 음성 서비스로는 보내지 않습니다.");
        return;
      }
      const parts = speechChunks(speechText(text));
      if (!parts.length) return;
      setSpeaking(true);
      parts.forEach((part, index) => {
        const utterance = new window.SpeechSynthesisUtterance(part);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.onend = () => {
          if (owner === version.current && index === parts.length - 1) {
            version.current += 1;
            setSpeaking(false);
          }
        };
        utterance.onerror = (event) => {
          if (owner !== version.current) return;
          stop();
          if (!["interrupted", "canceled"].includes(event?.error)) setNotice("답변 읽기를 마치지 못했습니다. 화면의 답변을 확인해 주세요.");
        };
        engine.speak(utterance);
      });
    },
    [stop],
  );

  useEffect(() => {
    cancelAll();
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [stop]);

  return { speaking, notice, speak, stop, clearNotice: () => setNotice("") };
}
