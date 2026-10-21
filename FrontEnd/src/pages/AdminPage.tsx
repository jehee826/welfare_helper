import { useState } from "react";
import type { WelfareApi } from "../api/types";
import { Header } from "../components/Header";
import { AdminLogin } from "../components/admin/AdminLogin";
import { ProgramManager } from "../components/admin/ProgramManager";
import { StatsPanel } from "../components/admin/StatsPanel";

type Tab = "programs" | "stats";

export function AdminPage({ api }: { api: WelfareApi }) {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("programs");

  return (
    <div className="page">
      <Header>
        {authed && (
          <button type="button" className="btn btn--soft btn--sm" onClick={() => setAuthed(false)}>
            로그아웃
          </button>
        )}
      </Header>
      <main className="admin">
        {!authed ? (
          <AdminLogin expectedKey={import.meta.env.VITE_ADMIN_DEMO_KEY} onSuccess={() => setAuthed(true)} />
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label="관리 메뉴">
              <button type="button" role="tab" aria-selected={tab === "programs"} className="tab" onClick={() => setTab("programs")}>
                복지제도 관리
              </button>
              <button type="button" role="tab" aria-selected={tab === "stats"} className="tab" onClick={() => setTab("stats")}>
                이용 통계
              </button>
            </div>
            <div role="tabpanel">{tab === "programs" ? <ProgramManager api={api} /> : <StatsPanel api={api} />}</div>
          </>
        )}
      </main>
    </div>
  );
}
