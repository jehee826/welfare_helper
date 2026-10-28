import { useState, type FormEvent } from "react";
import { loginAdmin } from "../../api/auth";
import { ApiError } from "../../api/errors";

export function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await loginAdmin(password);
      onSuccess();
    } catch (error) {
      setError(error instanceof ApiError ? error.message : "로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally { setPassword(""); setBusy(false); }
  }

  return <section className="card admin-login" aria-labelledby="admin-login-title">
    <p className="eyebrow">복지관 직원 전용</p>
    <h1 id="admin-login-title" className="admin-login__title">관리자 로그인</h1>
    <form onSubmit={handleSubmit} className="stack">
      <label className="field"><span className="field__label">비밀번호</span>
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" aria-invalid={!!error} required disabled={busy} />
      </label>
      {error && <p role="alert" className="field__error">{error}</p>}
      <button type="submit" className="btn btn--primary btn--lg" disabled={busy}>{busy ? "로그인 중…" : "들어가기"}</button>
    </form>
    <p className="notice small">운영 관리자가 설정한 공통 비밀번호를 입력하세요. 관리자 세션은 8시간 유지되며 서버 재시작 후에는 다시 로그인합니다.</p>
  </section>;
}
