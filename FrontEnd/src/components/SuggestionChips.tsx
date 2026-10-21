interface Props {
  suggestions: string[];
  disabled: boolean;
  highlighted: boolean;
  onPick: (text: string) => void;
}

export function SuggestionChips({ suggestions, disabled, highlighted, onPick }: Props) {
  if (suggestions.length === 0) return null;
  return (
    <div className={highlighted ? "chips is-highlighted" : "chips"} role="group" aria-label="추천 질문">
      {suggestions.map((s) => (
        <button key={s} type="button" className="chip" disabled={disabled} onClick={() => onPick(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}
