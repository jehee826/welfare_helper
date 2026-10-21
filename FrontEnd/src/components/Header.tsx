import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { STORAGE_KEYS, readJson, writeJson } from "../lib/storage";

export function Header({ children }: { children?: ReactNode }) {
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
        <button type="button" className="btn btn--soft btn--sm" aria-pressed={large} onClick={() => setLarge((v) => !v)}>
          {large ? "글자 보통" : "글자 크게"}
        </button>
        {children}
      </nav>
    </header>
  );
}
