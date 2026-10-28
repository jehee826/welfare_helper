import { useState } from "react";
import type { WelfareApi } from "../api/types";
import { Header } from "../components/Header";
import { AdminGate } from "../components/admin/AdminGate";
import { Link } from "react-router-dom";
import { ProgramManager } from "../components/admin/ProgramManager";
import { StatsPanel } from "../components/admin/StatsPanel";

type Tab = "programs" | "stats";

export function AdminPage({ api }: { api: WelfareApi }) {
  const [tab, setTab] = useState<Tab>("programs");

  return (
    <div className="page">
      <Header />
      <main className="admin">
        <AdminGate>
          <>
            <Link to="/admin/documents">문서 관리로 이동</Link>
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
        </AdminGate>
      </main>
    </div>
  );
}
