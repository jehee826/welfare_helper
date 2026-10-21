import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ChatAnswer, WelfareApi, WelfareProgram } from "../../api/types";
import { ProgramForm } from "./ProgramForm";

export function ProgramManager({ api }: { api: WelfareApi }) {
  const [programs, setPrograms] = useState<WelfareProgram[]>([]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<WelfareProgram | null | "new">(null);
  const [message, setMessage] = useState("");
  const [sample, setSample] = useState("");
  const [sampleResult, setSampleResult] = useState<ChatAnswer | null>(null);

  useEffect(() => {
    void api.listPrograms().then(setPrograms);
  }, [api]);

  async function persist(next: WelfareProgram[], notice: string) {
    await api.savePrograms(next);
    setPrograms(next);
    setMessage(notice);
  }

  async function handleSave(program: WelfareProgram) {
    const exists = programs.some((p) => p.id === program.id);
    const next = exists ? programs.map((p) => (p.id === program.id ? program : p)) : [program, ...programs];
    setEditing(null);
    await persist(next, `'${program.name}'을(를) ${exists ? "수정" : "추가"}했어요. 아래에서 샘플 질문으로 반영을 확인해 보세요.`);
    setSample(program.name);
  }

  async function handleDelete(program: WelfareProgram) {
    if (!window.confirm(`'${program.name}'을(를) 삭제할까요? 챗봇 안내에서도 빠져요.`)) return;
    await persist(programs.filter((p) => p.id !== program.id), `'${program.name}'을(를) 삭제했어요.`);
  }

  async function handleSample(event: FormEvent) {
    event.preventDefault();
    if (!sample.trim()) return;
    setSampleResult(await api.ask(sample, null));
  }

  const closeForm = useCallback(() => setEditing(null), []);
  const filtered = programs.filter((p) => !query.trim() || `${p.name}${p.ministry}${p.department}${p.category}`.includes(query.trim()));

  return (
    <div className="stack-lg">
      <section className="card" aria-labelledby="programs-title">
        <div className="section-head">
          <div>
            <h2 id="programs-title">복지제도 관리</h2>
            <p className="muted small">총 {programs.length}건 · 수정하면 이용자 안내에 바로 반영돼요 (목업: 이 브라우저에만 저장)</p>
          </div>
          <button type="button" className="btn btn--primary" onClick={() => setEditing("new")}>
            + 새 제도 추가
          </button>
        </div>
        <label className="field">
          <span className="sr-only">제도 검색</span>
          <input type="search" placeholder="제도명, 부처, 분야로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <div className="table-wrap">
          <table className="table table--programs">
            <thead>
              <tr>
                <th scope="col">제도명</th>
                <th scope="col" className="nowrap">분야</th>
                <th scope="col">소관</th>
                <th scope="col">갱신일</th>
                <th scope="col">
                  <span className="sr-only">관리</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {!p.howToApply && <span className="tag">신청방법 없음</span>}
                  </td>
                  <td className="nowrap">{p.category}</td>
                  <td className="muted">{p.ministry}</td>
                  <td className="muted nowrap">{p.updatedAt}</td>
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
        <p className="muted small">이용자가 물어볼 법한 질문을 넣어 챗봇이 어떻게 답하는지 확인해요.</p>
        <form className="composer" onSubmit={handleSample}>
          <label htmlFor="sample-input" className="sr-only">
            샘플 질문
          </label>
          <input id="sample-input" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="예: 기초연금 신청 방법" />
          <button type="submit" className="btn btn--primary btn--sm">
            확인
          </button>
        </form>
        {sampleResult && (
          <div className="sample-result" role="status">
            <p className="badge">{sampleResult.kind === "answer" ? "안내 가능" : "연락처 안내로 넘어감"}</p>
            <p>{sampleResult.text}</p>
            {sampleResult.kind === "answer" && (
              <p className="muted small">안내된 제도: {sampleResult.services.map((s) => s.name).join(", ")}</p>
            )}
          </div>
        )}
      </section>

      {editing !== null && <ProgramForm initial={editing === "new" ? null : editing} onSave={handleSave} onCancel={closeForm} />}
    </div>
  );
}
