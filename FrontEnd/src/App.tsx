import { Link, Route, Routes } from "react-router-dom";
import { createHttpApi } from "./api/httpApi";
import { AdminGate } from "./components/admin/AdminGate";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import type { WelfareApi } from "./api/types";
import { AdminPage } from "./pages/AdminPage";
import { UserPage } from "./pages/UserPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { ProgramManager } from "./components/admin/ProgramManager";
import { Header } from "./components/Header";

const liveApi = createHttpApi();

function ProgramsPage() {
  return <div className="page"><Header /><main className="admin">
    <h1>제도 등록·관리</h1>
    <p>제도 정보를 등록한 뒤 원문을 연결해 자동 분석·게시합니다.</p>
    <p>실제 담당 부서가 목록에 없으면 관리자에게 부서 등록을 요청하세요.</p>
    <Link to="/admin/documents">문서 관리로 이동</Link>
    <AdminGate><ProgramManager api={liveApi} /></AdminGate>
  </main></div>;
}

export function App({ api = liveApi }: { api?: WelfareApi }) {
  return <AuthProvider><AppRoutes api={api} /></AuthProvider>;
}

function AppRoutes({ api }: { api: WelfareApi }) {
  const { session, ready } = useAuth();
  const chat = ready ? <UserPage key={session?.session_id ?? "public"} api={api} privateSession={!!session} /> : <p role="status">세션 확인 중…</p>;
  return (
    <Routes>
      <Route path="/" element={chat} />
      <Route path="/admin" element={<AdminPage api={api} />} />
      <Route path="/admin/documents" element={<DocumentsPage />} />
      <Route path="/admin/programs" element={<ProgramsPage />} />
      <Route path="*" element={chat} />
    </Routes>
  );
}
