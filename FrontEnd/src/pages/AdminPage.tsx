import type { WelfareApi } from "../api/types";
import { ProgramManager } from "../components/admin/ProgramManager";

export function AdminPage({ api }: { api: WelfareApi }) {
  return <section className="stack-lg">
    <h1>제도 등록·관리</h1>
    <p>제도 정보를 등록한 뒤 원문을 연결해 자동 분석·게시합니다.</p>
    <p>실제 담당 부서가 목록에 없으면 관리자에게 부서 등록을 요청하세요.</p>
    <ProgramManager api={api} />
  </section>;
}
