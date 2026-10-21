import { Route, Routes } from "react-router-dom";
import { api as defaultApi } from "./api/mockApi";
import type { WelfareApi } from "./api/types";
import { AdminPage } from "./pages/AdminPage";
import { UserPage } from "./pages/UserPage";

export function App({ api = defaultApi }: { api?: WelfareApi }) {
  return (
    <Routes>
      <Route path="/" element={<UserPage api={api} />} />
      <Route path="/admin" element={<AdminPage api={api} />} />
      <Route path="*" element={<UserPage api={api} />} />
    </Routes>
  );
}
