import { Link, Route, Routes, useSearchParams } from "react-router-dom";
import { api as defaultApi } from "./api";
import { createHttpApi } from "./api/httpApi";
import { localDocumentAccess } from "./api/documentApi";
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
    {localDocumentAccess() ? <ProgramManager api={liveApi} /> : <p role="alert">로컬 개발 서버에서만 사용할 수 있습니다. 공개 관리자는 서버 인증 연동이 필요합니다.</p>}
  </main></div>;
}

export function App({ api = defaultApi }: { api?: WelfareApi }) {
  const [params] = useSearchParams();
  const chatApi = params.get("source") === "documents" ? liveApi : api;
  return (
    <Routes>
      <Route path="/" element={<UserPage api={chatApi} />} />
      <Route path="/admin" element={<AdminPage api={api} />} />
      <Route path="/admin/documents" element={<DocumentsPage />} />
      <Route path="/admin/programs" element={<ProgramsPage />} />
      <Route path="*" element={<UserPage api={api} />} />
    </Routes>
  );
}
