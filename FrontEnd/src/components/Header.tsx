import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { STORAGE_KEYS, readJson, writeJson } from "../lib/storage";
import { useAuth } from "../auth/AuthProvider";
import { getSupabase } from "../auth/supabase";

export function Header({ children }: { children?: ReactNode }) {
  const { session } = useAuth();
  const [logoutError, setLogoutError] = useState("");
  async function logout() {
    setLogoutError("");
    try {
      const result = await getSupabase()?.auth.signOut({ scope: "local" });
      if (result?.error) setLogoutError("로그아웃하지 못했습니다. 다시 시도해 주세요.");
    } catch { setLogoutError("로그아웃 서버에 연결하지 못했습니다."); }
  }
  const [large, setLarge] = useState(() => readJson<boolean>(STORAGE_KEYS.largeText, false));

  useEffect(() => {
    document.documentElement.dataset.text = large ? "large" : "normal";
    writeJson(STORAGE_KEYS.largeText, large);
  }, [large]);

  return (
    <header className="header">
      <Link to="/" className="brand" aria-label="곁에 처음 화면">
        곁에<span className="brand__sub">복지 길잡이</span>
      </Link>
      <nav className="header__nav" aria-label="주 메뉴">
        <Link className="btn btn--soft btn--sm" to="/admin/documents">문서 관리</Link>
        {session && <button type="button" className="btn btn--soft btn--sm" onClick={() => void logout()}>로그아웃</button>}
        {logoutError && <span role="alert">{logoutError}</span>}
        <button type="button" className="btn btn--soft btn--sm" aria-pressed={large} onClick={() => setLarge((v) => !v)}>
          {large ? "글자 보통" : "글자 크게"}
        </button>
        {children}
      </nav>
    </header>
  );
}
