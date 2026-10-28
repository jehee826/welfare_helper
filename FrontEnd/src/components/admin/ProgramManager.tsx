import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../api/errors";
import type { AdminProgram, ChatAnswer, Department, ProgramInput, WelfareApi } from "../../api/types";
import { ProgramForm } from "./ProgramForm";

const SEARCH_DELAY_MS = 250;

const ERROR_MESSAGES: Record<string, string> = {
  program_has_documents: "원문 문서가 연결돼 있어 제도명·서비스 ID를 바꾸거나 제도를 삭제할 수 없어요. 문서를 먼저 정리해 주세요.",
  program_changed: "다른 곳에서 먼저 수정했어요. 목록을 다시 불러왔으니 확인한 뒤 다시 고쳐 주세요.",
  program_not_found: "이미 삭제된 제도예요. 목록을 다시 불러왔어요.",
  duplicate_service_id: "같은 서비스 ID를 쓰는 제도가 이미 있어요.",
  department_not_found: "선택한 담당 부서를 찾지 못했어요. 화면을 새로고침해 주세요.",
  test_service_requires_test_only: "TEST_로 시작하는 서비스 ID는 테스트용 제도에만 쓸 수 있어요.",
  program_constraint_violation: "입력값이 저장 규칙에 맞지 않아요. 빈 칸이나 형식을 확인해 주세요.",
  invalid_request: "입력값 형식을 확인해 주세요. 서비스 ID는 영문 대문자·숫자·_만, 출처 URL은 https 주소만 쓸 수 있어요.",
};
const RELOAD_CODES = new Set(["program_changed", "program_not_found"]);

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
    if (error.status === 401 || error.status === 403) return "관리자 인증이 필요해요. 다시 로그인해 주세요.";
  }
  return "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
}

export function ProgramManager({ api }: { api: WelfareApi }) {
  const [programs, setPrograms] = useState<AdminProgram[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<AdminProgram | null | "new">(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sample, setSample] = useState("");
  const [sampleResult, setSampleResult] = useState<ChatAnswer | null>(null);

  const reload = useCallback(
    async (search: string) => {
      try {
        const page = await api.listPrograms(search);
        setPrograms(page.items);
        setHasMore(page.hasMore);
      } catch (e) {
        setError(describeError(e));
      }
    },
    [api],
  );

  useEffect(() => {
    void api.listDepartments().then(setDepartments, (e: unknown) => setError(describeError(e)));
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(query.trim()), query ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
  }, [query, reload]);

  async function handleSave(changes: Partial<ProgramInput>) {
    if (editing === null) return;
    setSaving(true);
    try {
      if (editing === "new") {
        const created = await api.createProgram(changes as ProgramInput);
        setPrograms((list) => [created, ...list]);
        setMessage(`'${created.name}'을(를) 추가했어요. 다음 질문부터 챗봇 안내에 반영돼요. 아래에서 샘플 질문으로 확인해 보세요.`);
        setSample(created.name);
      } else if (Object.keys(changes).length > 0) {
        const updated = await api.updateProgram(editing, changes);
        setPrograms((list) => list.map((p) => (p.programId === updated.programId ? updated : p)));
        setMessage(`'${updated.name}'을(를) 수정했어요. 다음 질문부터 챗봇 안내에 반영돼요. 아래에서 샘플 질문으로 확인해 보세요.`);
        setSample(updated.name);
      }
      setEditing(null);
      setFormError("");
      setError("");
    } catch (e) {
      setFormError(describeError(e));
      if (e instanceof ApiError && RELOAD_CODES.has(e.code)) await reload(query.trim());
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(program: AdminProgram) {
    if (!window.confirm(`'${program.name}'을(를) 삭제할까요? 챗봇 안내에서도 빠져요.`)) return;
    try {
      await api.deleteProgram(program.programId);
      setPrograms((list) => list.filter((p) => p.programId !== program.programId));
      setMessage(`'${program.name}'을(를) 삭제했어요.`);
      setError("");
    } catch (e) {
      setError(describeError(e));
      if (e instanceof ApiError && RELOAD_CODES.has(e.code)) await reload(query.trim());
    }
  }

  async function handleSample(event: FormEvent) {
    event.preventDefault();
    if (!sample.trim()) return;
    try {
      setSampleResult(await api.ask(sample, null));
    } catch (e) {
      setError(describeError(e));
    }
  }

  const closeForm = useCallback(() => {
    setEditing(null);
    setFormError("");
  }, []);

  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="programs-title">
        <div className="section-head">
          <div>
            <h2 id="programs-title">복지제도 관리</h2>
            <p className="muted small">
              {programs.length}건 표시 · 이름·요약·문의처를 고치면 다음 질문부터 챗봇 안내에 반영돼요
            </p>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => setEditing("new")}>
            + 새 제도 추가
          </button>
        </div>
        <label className="field">
          <span className="sr-only">제도 검색</span>
          <input type="search" placeholder="제도명, 부처, 부서, 서비스 ID로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {hasMore && <p className="muted small">결과가 많아 앞부분만 보여요. 검색어로 좁혀 주세요.</p>}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        <div className="table-wrap">
          <table className="table table--programs">
            <thead>
              <tr>
                <th scope="col">제도명</th>
                <th scope="col">소관</th>
                <th scope="col" className="nowrap">
                  원문 문서
                </th>
                <th scope="col">갱신일</th>
                <th scope="col">
                  <span className="sr-only">관리</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {programs.map((p) => (
                <tr key={p.programId}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.testOnly && <span className="tag">테스트용</span>}
                  </td>
                  <td className="muted">
                    {p.ministryName} · {p.departmentName}
                  </td>
                  <td className="muted nowrap">
                    {p.documentCount}건 (게시 {p.publishedCount})
                  </td>
                  <td className="muted nowrap">{p.updatedAt.slice(0, 10)}</td>
                  <td className="nowrap">
                    <button type="button" className="btn btn--soft btn--sm" onClick={() => setEditing(p)} aria-label={`${p.name} 수정`}>
                      수정
                    </button>{" "}
                    <button type="button" className="btn btn--danger-text btn--sm" onClick={() => handleDelete(p)} aria-label={`${p.name} 삭제`}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="sample-title">
        <h2 id="sample-title">반영 확인</h2>
        <p className="muted small">
          이용자가 물어볼 법한 질문을 넣어 챗봇이 어떻게 답하는지 확인해요. 테스트용 제도는 이용자 검색에서 빠지므로 여기에도 나오지 않아요.
        </p>
        <form className="composer" onSubmit={handleSample}>
          <label htmlFor="sample-input" className="sr-only">
            샘플 질문
          </label>
          <input id="sample-input" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="예: 기초연금 문의처" />
          <button type="submit" className="btn btn--primary btn--sm">
            확인
          </button>
        </form>
        {sampleResult && (
          <div className="sample-result">
            <p className="badge">{sampleResult.kind === "answer" ? "안내 가능" : "연락처 안내로 넘어감"}</p>
            <p>{sampleResult.text}</p>
            {sampleResult.kind === "answer" && (
              <p className="muted small">안내된 제도: {sampleResult.services.map((s) => s.name).join(", ")}</p>
            )}
          </div>
        )}
      </section>

      {editing !== null && (
        <ProgramForm
          initial={editing === "new" ? null : editing}
          departments={departments}
          error={formError}
          saving={saving}
          onSave={handleSave}
          onCancel={closeForm}
        />
      )}
    </div>
  );
}
