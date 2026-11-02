import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { STORAGE_KEYS, readJson, writeJson } from "../lib/storage";
import { useAuth } from "../auth/AuthProvider";
import { logoutAdmin } from "../api/auth";

export function Header() {
  const { session } = useAuth();
  const [logoutError, setLogoutError] = useState("");
  async function logout() {
    setLogoutError("");
    try {
      await logoutAdmin();
    } catch { setLogoutError("이 기기에서 로그아웃했지만 서버 세션 종료는 확인하지 못했습니다."); }
  }
  const [large, setLarge] = useState(() => readJson<boolean>(STORAGE_KEYS.largeText, false));

  useEffect(() => {
    document.documentElement.dataset.text = large ? "large" : "normal";
    writeJson(STORAGE_KEYS.largeText, large);
  }, [large]);

  return (
    <header className="header">
      <Link to="/admin/documents" className="brand" aria-label="곁에 관리자 처음 화면">
        곁에<span className="brand__sub">관리자</span>
      </Link>
      <nav className="header__nav" aria-label="주 메뉴">
        <NavLink className="btn btn--soft btn--sm" to="/admin/documents">문서 관리</NavLink>
        <NavLink className="btn btn--soft btn--sm" to="/admin/programs">제도 관리</NavLink>
        {session && <button type="button" className="btn btn--soft btn--sm" onClick={() => void logout()}>로그아웃</button>}
        {logoutError && <span role="alert">{logoutError}</span>}
        <button type="button" className="btn btn--soft btn--sm" aria-pressed={large} onClick={() => setLarge((v) => !v)}>
          {large ? "글자 보통" : "글자 크게"}
        </button>
      </nav>
    </header>
  );
}
