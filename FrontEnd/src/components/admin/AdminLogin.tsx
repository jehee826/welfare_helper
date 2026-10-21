import { useState, type FormEvent } from "react";

interface Props {
  expectedKey: string | undefined;
  onSuccess: () => void;
}

export function AdminLogin({ expectedKey, onSuccess }: Props) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!expectedKey) {
      setError("관리자 키가 설정되지 않았어요. VITE_ADMIN_DEMO_KEY 환경변수를 확인해 주세요.");
      return;
    }
    if (key !== expectedKey) {
      setError("키가 일치하지 않아요. 다시 입력해 주세요.");
      setKey("");
      return;
    }
    onSuccess();
  }

  return (
    <section className="card admin-login" aria-labelledby="admin-login-title">
      <p className="eyebrow">복지관 직원 전용</p>
      <h1 id="admin-login-title" className="admin-login__title">
        관리자 로그인
      </h1>
      <form onSubmit={handleSubmit} className="stack">
        <label className="field">
          <span className="field__label">관리자 키</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="current-password"
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error && (
          <p role="alert" className="field__error">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn--primary btn--lg">
          들어가기
        </button>
      </form>
      <p className="notice small">
        목업 안내: 키를 브라우저에서 비교하므로 실제 보안 기능이 아니에요. 실제 인증은 백엔드 연동 단계에서 적용해요.
      </p>
    </section>
  );
}
