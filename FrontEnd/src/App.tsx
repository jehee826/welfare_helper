import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { createHttpApi } from "./api/httpApi";
import { AdminGate } from "./components/admin/AdminGate";
import { AuthProvider } from "./auth/AuthProvider";
import type { WelfareApi } from "./api/types";
import { AdminPage } from "./pages/AdminPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { Header } from "./components/Header";

const liveApi = createHttpApi();

function AdminLayout() {
  return <div className="page"><Header /><main className="admin">
    <AdminGate><Outlet /></AdminGate>
  </main></div>;
}

export function App({ api = liveApi }: { api?: WelfareApi }) {
  return <AuthProvider><AppRoutes api={api} /></AuthProvider>;
}

function AppRoutes({ api }: { api: WelfareApi }) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin/documents" replace />} />
      <Route path="/admin" element={<Navigate to="/admin/documents" replace />} />
      <Route element={<AdminLayout />}>
        <Route path="/admin/documents" element={<DocumentsPage />} />
        <Route path="/admin/programs" element={<AdminPage api={api} />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin/documents" replace />} />
    </Routes>
  );
}
