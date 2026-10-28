import { useState, type FormEvent } from "react";
import { getSupabase } from "../../auth/supabase";

export function AdminLogin({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const client = getSupabase();
    if (!client) { setError("Supabase 로그인 설정이 필요합니다. 관리자에게 문의해 주세요."); return; }
    setBusy(true); setError("");
    try {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setError("로그인하지 못했습니다. 이메일과 비밀번호를 확인해 주세요.");
      else onSuccess();
    } catch {
      setError("로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally { setPassword(""); setBusy(false); }
  }

  return <section className="card admin-login" aria-labelledby="admin-login-title">
    <p className="eyebrow">복지관 직원 전용</p>
    <h1 id="admin-login-title" className="admin-login__title">관리자 로그인</h1>
    <form onSubmit={handleSubmit} className="stack">
      <label className="field"><span className="field__label">이메일</span>
        <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required disabled={busy} />
      </label>
      <label className="field"><span className="field__label">비밀번호</span>
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" aria-invalid={!!error} required disabled={busy} />
      </label>
      {error && <p role="alert" className="field__error">{error}</p>}
      <button type="submit" className="btn btn--primary btn--lg" disabled={busy}>{busy ? "로그인 중…" : "들어가기"}</button>
    </form>
    <p className="notice small">등록된 Supabase 계정으로 로그인합니다. 관리자 기능은 서버의 활성 관리자 확인 후 사용할 수 있습니다.</p>
  </section>;
}
