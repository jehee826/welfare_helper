import { useState, type FormEvent } from "react";
import type { Household, IncomeBracket, UserProfile } from "../api/types";
import { HOUSEHOLD_OPTIONS, INCOME_OPTIONS, REGIONS } from "../lib/profile";

interface Props {
  initial: UserProfile | null;
  onSubmit: (profile: UserProfile) => void;
  onSkip: () => void;
  onClear?: () => void;
}

export function ConditionForm({ initial, onSubmit, onSkip, onClear }: Props) {
  const [age, setAge] = useState(initial ? String(initial.age) : "");
  const [income, setIncome] = useState<IncomeBracket>(initial?.income ?? "unknown");
  const [household, setHousehold] = useState<Household>(initial?.household ?? "single");
  const [region, setRegion] = useState(initial?.region ?? REGIONS[0]);
  const [disability, setDisability] = useState(initial?.disability ?? false);
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = Number(age);
    if (!age || !Number.isInteger(parsed) || parsed < 0 || parsed > 120) {
      setError("나이를 0~120 사이 숫자로 입력해 주세요.");
      return;
    }
    onSubmit({ age: parsed, income, household, region, disability });
  }

  return (
    <section className="card condition" aria-labelledby="condition-title">
      <p className="eyebrow">처음 한 번만 알려주세요</p>
      <h1 id="condition-title" className="condition__title">
        나에게 맞는 복지를
        <br />
        찾아드릴게요.
      </h1>
      <p className="muted">회원가입은 필요 없어요. 입력한 조건은 이 기기의 브라우저에만 저장돼요.</p>

      <form className="condition__form" onSubmit={handleSubmit} noValidate>
        <label className="field">
          <span className="field__label">나이</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={120}
            value={age}
            onChange={(e) => setAge(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "age-error" : undefined}
            placeholder="예: 67"
          />
        </label>
        {error && (
          <p id="age-error" role="alert" className="field__error">
            {error}
          </p>
        )}

        <label className="field">
          <span className="field__label">소득 구간</span>
          <select value={income} onChange={(e) => setIncome(e.target.value as IncomeBracket)}>
            {INCOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">가구 형태</span>
          <select value={household} onChange={(e) => setHousehold(e.target.value as Household)}>
            {HOUSEHOLD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">사는 곳</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="field">
          <legend className="field__label">장애가 있나요?</legend>
          <div className="segmented">
            <label className={disability ? "segmented__item is-active" : "segmented__item"}>
              <input type="radio" name="disability" checked={disability} onChange={() => setDisability(true)} />
              예
            </label>
            <label className={!disability ? "segmented__item is-active" : "segmented__item"}>
              <input type="radio" name="disability" checked={!disability} onChange={() => setDisability(false)} />
              아니오
            </label>
          </div>
        </fieldset>

        <div className="condition__actions">
          <button type="submit" className="btn btn--primary btn--lg">
            이 조건으로 시작하기
          </button>
          <button type="button" className="btn btn--ghost" onClick={onSkip}>
            {initial ? "취소" : "나중에 입력할게요"}
          </button>
          {onClear && (
            <button type="button" className="btn btn--danger-text" onClick={onClear}>
              내 정보 지우기
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
