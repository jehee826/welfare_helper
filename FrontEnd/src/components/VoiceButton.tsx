interface Props {
  listening: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function VoiceButton({ listening, disabled, onStart, onStop }: Props) {
  return (
    <button
      type="button"
      className={listening ? "icon-btn is-listening" : "icon-btn"}
      aria-label={listening ? "음성 입력 멈추기" : "말로 질문하기"}
      aria-pressed={listening}
      disabled={disabled}
      onClick={listening ? onStop : onStart}
    >
      <span aria-hidden="true">{listening ? "■" : "🎤"}</span>
    </button>
  );
}
