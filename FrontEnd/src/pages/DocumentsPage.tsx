import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Header } from "../components/Header";
import { DocumentProgress } from "../components/admin/DocumentProgress";
import { DocumentApiError, documentError, documentRequest, jsonPost, localDocumentAccess } from "../api/documentApi";
import type { DocumentStatus, Job, Program, QueryResult, SearchResult } from "../api/documentApi";
import "./documents.css";

const validId = (value: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function DocumentsPage() {
  return <div className="page"><Header /><main className="admin documents">
    <h1>문서 관리</h1>
    <p>원문을 올리면 자동 분석·청크 분할·임베딩·게시까지 처리합니다. 분류·검토 승인은 필요하지 않습니다.</p>
    {localDocumentAccess() ? <DocumentRegistration /> : <p role="alert">로컬 개발 서버에서만 사용할 수 있습니다. 공개 관리자는 서버 인증 연동이 필요합니다.</p>}
  </main></div>;
}

function DocumentRegistration() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [prepared, setPrepared] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [params, setParams] = useSearchParams();
  const id = params.get("document") ?? "";
  const requestedJob = params.get("job") ?? undefined;
  const [openCount, setOpenCount] = useState(0);
  const [replacementId, setReplacementId] = useState("");
  const workspace = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController>();
  const submitting = useRef(false);

  useEffect(() => {
    if (!validId(id)) return;
    workspace.current?.focus();
    workspace.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [id, openCount]);

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setPrepared(false); setError("");
    void (async () => {
      const processing = await documentRequest<{ ready: boolean }>("/processing", abort.signal);
      if (!abort.signal.aborted) setPrepared(processing.ready);
      const items: Program[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: { items: Program[]; next_offset: number | null } = await documentRequest("/programs?offset=" + offset + "&limit=200", abort.signal);
        items.push(...page.items);
        if (page.next_offset !== null && page.next_offset <= offset) throw new Error("invalid_pagination");
        offset = page.next_offset;
      }
      if (!abort.signal.aborted) setPrograms(items);
    })().catch(e => { if (!abort.signal.aborted) setError(documentError(e)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [reload]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !controller.current || !prepared) return;
    const form = new FormData(event.currentTarget);
    const program = programs.find(p => p.service_id === form.get("service_id"));
    if (!program) return;
    const body = new FormData();
    body.set("file", form.get("file")!);
    body.set("metadata", JSON.stringify({
      service_id: program.service_id, name: String(form.get("name")).trim(),
      source_url: String(form.get("source_url")).trim(), source_organization: String(form.get("source_organization")).trim(),
      basis_year: form.get("basis_year") || null, source_updated_at: form.get("source_updated_at") || null, test_only: program.test_only,
    }));
    if (replacementId.trim()) body.set("document_id", replacementId.trim());
    submitting.current = true; setBusy(true); setError("");
    const signal = controller.current.signal;
    try {
      const result = await documentRequest<{ document_id: string; job_id: string }>("", signal, { method: "POST", body });
      if (!signal.aborted) { setParams({ document: result.document_id, job: result.job_id }); setOpenCount(v => v + 1); }
    } catch (e) { if (!signal.aborted) setError(documentError(e)); }
    finally { submitting.current = false; if (!signal.aborted) setBusy(false); }
  }

  return <>
    {error && <p role="alert">{error}</p>}
    {!loading && !prepared && <p role="alert">자동 처리 DB 설정이 아직 적용되지 않았습니다. 0005 마이그레이션 적용 후 다시 불러오세요.</p>}
    {validId(id) && <div ref={workspace} tabIndex={-1} aria-label="현재 문서 작업">
      <DocumentWorkspace key={id + ":" + (requestedJob ?? "latest") + ":" + openCount} documentId={id} requestedJob={requestedJob}
        onJobChange={job => setParams({ document: id, job })} onReplace={() => {
          setReplacementId(id);
          document.getElementById("document-upload")?.scrollIntoView?.({ behavior: "smooth" });
          document.querySelector<HTMLInputElement>('#document-upload input[name="file"]')?.focus();
        }} />
    </div>}
    <div className="document-toolbar"><Link className="btn btn--soft" to="/admin/programs">제도 등록·관리</Link>
      <button className="btn btn--soft" disabled={busy || loading} onClick={() => setReload(v => v + 1)}>설정·제도 목록 다시 불러오기</button>
    </div>
    <form id="document-upload" className="card document-form" onSubmit={upload}>
      <h2>원문 등록·교체</h2>
      <label className="field">연결할 제도<select name="service_id" required disabled={loading || busy}>
        <option value="">{loading ? "불러오는 중" : "제도 선택"}</option>
        {programs.map(p => <option key={p.service_id} value={p.service_id}>{p.program_name} ({p.service_id}){p.test_only ? " · 일반 상담 미노출" : ""}</option>)}
      </select></label>
      {!loading && !programs.length && <p>연결할 제도를 제도 등록·관리에서 먼저 등록하세요.</p>}
      <label className="field">문서명<input name="name" maxLength={160} required /></label>
      <label className="field">공개 원문 URL (HTTPS)<input name="source_url" type="url" pattern="https://.*" maxLength={1000} required /></label>
      <label className="field">발행 기관<input name="source_organization" maxLength={300} required /></label>
      <label className="field">확인한 기준연도 (선택)<input name="basis_year" pattern="(19|20)[0-9]{2}" /></label>
      <label className="field">원문 기준일 (선택)<input name="source_updated_at" type="date" /></label>
      <p>원문에서 확인한 정보만 입력하세요. 확인할 수 없는 날짜는 비워 두고 URL에는 인증정보를 넣지 마세요.</p>
      <label className="field">원문 파일 (PDF·DOCX·UTF-8 Markdown)<input name="file" type="file" accept=".pdf,.docx,.md" required /></label>
      <label className="field">교체할 문서 ID (신규 등록은 비움)<input name="document_id" value={replacementId} onChange={e => setReplacementId(e.target.value)} /></label>
      <button className="btn btn--primary" disabled={busy || loading || !prepared || !programs.length}>{busy ? "업로드 중" : "업로드·자동 처리"}</button>
    </form>
    <form className="card document-form" onSubmit={e => {
      e.preventDefault(); const resume = String(new FormData(e.currentTarget).get("resume") || "").trim();
      if (validId(resume)) { setParams({ document: resume }); setOpenCount(v => v + 1); setError(""); }
      else setError("올바른 문서 UUID를 입력하세요.");
    }}>
      <label className="field">기존 문서 ID로 이어서 확인<input name="resume" required /></label>
      <button className="btn btn--soft" disabled={busy}>문서 열기</button>
    </form>
  </>;
}

function DocumentWorkspace({ documentId, requestedJob, onReplace, onJobChange }: {
  documentId: string; requestedJob?: string; onReplace: () => void; onJobChange: (id: string) => void;
}) {
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [online, setOnline] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [answer, setAnswer] = useState<QueryResult | null>(null);
  const [reload, setReload] = useState(0);
  const action = useRef<AbortController>(); const submitting = useRef(false);

  useEffect(() => {
    const abort = new AbortController(); const signal = abort.signal;
    let timer: ReturnType<typeof setTimeout>; let identity = ""; let failures = 0;
    setStatus(null); setJob(null); setMarkdown(""); setError(""); setConnectionError("");
    setOnline(false); setUpdatedAt(null); setResult(null); setAnswer(null); setBusy(false); submitting.current = false;
    async function poll() {
      try {
        const doc = await documentRequest<DocumentStatus>("/" + documentId + "?limit=1", signal);
        const selected = requestedJob ?? doc.jobs[0]?.job_id;
        const current = selected ? await documentRequest<Job>("/" + documentId + "/jobs/" + selected, signal) : null;
        if (signal.aborted) return;
        const next = selected + ":" + doc.active_job_id + ":" + doc.analysis?.hash;
        if (next !== identity) {
          action.current?.abort(); submitting.current = false; setBusy(false); setMarkdown(""); setResult(null); setAnswer(null); identity = next;
        }
        failures = 0; setConnectionError(""); setOnline(true); setStatus(doc); setJob(current); setUpdatedAt(Date.now());
        if (current && ["queued", "parsing", "embedding", "ready", "succeeded"].includes(current.state)) timer = setTimeout(() => void poll(), 5000);
      } catch (e) {
        if (!signal.aborted) {
          action.current?.abort(); submitting.current = false; setBusy(false); setOnline(false); failures += 1;
          setConnectionError(documentError(e) + (failures <= 3 ? " 잠시 후 상태만 다시 확인합니다." : " 자동 확인을 멈췄습니다. 상태 새로 확인을 눌러 주세요."));
          if (failures <= 3) timer = setTimeout(() => void poll(), 5000 * 2 ** (failures - 1));
        }
      }
    }
    void poll(); return () => { abort.abort(); action.current?.abort(); clearTimeout(timer); };
  }, [documentId, requestedJob, reload]);

  const ready = online && !!job && job.state === "succeeded" && status?.active_job_id === job.job_id;
  const metadata = { ...status, ...(status?.analysis?.scope === "candidate" ? job?.candidate_metadata : {}) };

  async function perform(operation: "search" | "query" | "markdown" | "retry", query?: string) {
    if (submitting.current || !online || (operation === "search" || operation === "query") && !ready) return;
    const abort = new AbortController(); action.current = abort; submitting.current = true; setBusy(true); setError("");
    if (operation === "search" || operation === "query") { setResult(null); setAnswer(null); }
    try {
      if (operation === "retry") {
        const next = await documentRequest<{ job_id: string }>("/" + documentId + "/retry", abort.signal, { method: "POST" });
        if (!abort.signal.aborted) onJobChange(next.job_id);
      } else {
        const latest = await documentRequest<DocumentStatus>("/" + documentId + "?limit=1", abort.signal);
        if (operation !== "markdown" && (latest.active_job_id !== job?.job_id || !latest.jobs.some(j => j.job_id === job?.job_id && j.state === "succeeded"))) {
          setReload(v => v + 1); throw new DocumentApiError(409, "document_changed_during_search");
        }
        if (operation === "markdown") {
          if (latest.analysis?.job_id !== job?.job_id) throw new DocumentApiError(409, "analysis_version_changed");
          const text = await documentRequest<string>("/" + documentId + "/markdown", abort.signal);
          const check = await documentRequest<DocumentStatus>("/" + documentId + "?limit=1", abort.signal);
          if (check.analysis?.hash !== latest.analysis?.hash || check.analysis?.job_id !== job?.job_id) throw new DocumentApiError(409, "analysis_version_changed");
          if (!abort.signal.aborted) setMarkdown(text);
        } else if (operation === "search") {
          const data = await documentRequest<SearchResult>("/" + documentId + "/search", abort.signal, jsonPost({ query }));
          if (!abort.signal.aborted) setResult(data);
        } else {
          const data = await documentRequest<QueryResult>("/" + documentId + "/query", abort.signal, jsonPost({ query }));
          if (!abort.signal.aborted) setAnswer(data);
        }
      }
    } catch (e) { if (!abort.signal.aborted) setError(documentError(e)); }
    finally { if (!abort.signal.aborted) { submitting.current = false; setBusy(false); } }
  }

  return <section className="card document-form" aria-label="문서 작업 상태">
    <h2>처리 상태</h2><DocumentProgress job={job} updatedAt={updatedAt} error={connectionError} />
    {error && <p role="alert">{error}</p>}{connectionError && <p role="alert">{connectionError}</p>}
    <details><summary>문서·작업 ID</summary><p>문서 ID: <code>{documentId}</code></p>{job && <p>작업 ID: <code>{job.job_id}</code></p>}</details>
    {status && status.jobs.length > 1 && <label className="field">확인할 작업<select value={job?.job_id ?? ""} onChange={e => onJobChange(e.target.value)}>{status.jobs.map(j => <option key={j.job_id} value={j.job_id}>{j.state} · {j.created_at ? new Date(j.created_at).toLocaleString("ko-KR") : j.job_id}</option>)}</select></label>}
    <button className="btn btn--soft" disabled={busy} onClick={() => setReload(v => v + 1)}>상태 새로 확인</button>
    {status && <dl className="document-metadata"><div><dt>문서</dt><dd>{metadata.document_name ?? metadata.name}</dd></div><div><dt>연결 제도</dt><dd>{metadata.service_id}</dd></div><div><dt>발행 기관</dt><dd>{metadata.source_organization}</dd></div><div><dt>원문 기준</dt><dd>{metadata.basis_year ?? metadata.source_updated_at ?? "미확인"}</dd></div><div><dt>출처</dt><dd>{metadata.source_url}</dd></div><div><dt>처리 방식</dt><dd>{job?.processing_mode === "automatic" ? "자동 처리 · 사람 검토 아님" : "이전 처리 방식"}</dd></div></dl>}
    {job && ["failed", "cancelled", "awaiting_review"].includes(job.state) && <div className="document-next"><strong>같은 문서에 새 원문 등록</strong><p>최초 실패·취소 후보의 원본은 정리됩니다. 이전 검토 대기는 자동 재처리하지 않습니다. 같은 ID로 파일을 다시 첨부하면 새 자동 처리 후보를 만듭니다.</p><button className="btn btn--soft" onClick={onReplace}>같은 문서에 원문 다시 올리기</button>
      {status?.active_job_id && !status.jobs.some(j => ["queued", "parsing", "awaiting_review", "embedding", "ready"].includes(j.state)) && <button className="btn btn--soft" disabled={busy || !online} onClick={() => void perform("retry")}>기존 게시 원문 자동 재처리</button>}
    </div>}
    {status?.analysis && <details><summary>추출된 원문 확인 (선택)</summary><p>분석 블록 {status.analysis.total_blocks}개</p>
      {status.analysis.blockers.length > 0 && <p>분석 차단: {status.analysis.blockers.join(", ")}</p>}
      {status.analysis.warnings.length > 0 && <p>분석 주의: {status.analysis.warnings.join(", ")}</p>}
      <button className="btn btn--soft" disabled={busy || !online || status.analysis.job_id !== job?.job_id} onClick={() => void perform("markdown")}>원문 불러오기</button><pre className="document-text">{markdown}</pre>
    </details>}
    <h2>게시 문서 검색·질의</h2>
    {ready && <p><Link to={`/?document=${encodeURIComponent(documentId)}`}>이 문서로 대화하기</Link>에서 기존 채팅 화면으로 원문에 대해 질문할 수 있습니다. 아래에서도 같은 문서 안에서만 검색합니다.</p>}
    {!ready && <p>선택 작업의 게시 완료와 현재 게시본 일치가 확인되면 검색할 수 있습니다.</p>}
    <form className="document-form" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void perform(form.get("operation") === "query" ? "query" : "search", String(form.get("query")).trim()); }}>
      <label className="field">질문<input name="query" maxLength={300} required disabled={!ready || busy} /></label>
      <label className="field">확인 방식<select name="operation" disabled={!ready || busy}><option value="search">청크 검색</option><option value="query">문서 RAG 질의</option></select></label>
      <button className="btn btn--primary" disabled={!ready || busy}>{busy ? "처리 중" : "실행"}</button>
    </form>
    {result && <section aria-label="검색 결과"><p>검색 청크 {result.chunks.length}개. 유사도는 정답 확률·정확도가 아닙니다.</p>{result.chunks.map(c => <article className="document-block" key={c.chunk_id}><p>{c.chunk_id} · {c.section} · 유사도 {c.similarity.toFixed(4)}</p><pre className="document-text">{c.text}</pre><p>쪽: {c.pages.join(", ")} · 원문 블록: {c.source_blocks.join(", ")} · 위치: {c.start}–{c.end}</p></article>)}</section>}
    {answer && <section aria-label="질의 결과"><p>{answer.response.kind}</p><pre className="document-text">{answer.response.text}</pre><p>보류 사유: {answer.response.reason ?? "없음"}</p><details open><summary>근거·진단</summary><pre className="document-text">{JSON.stringify({ services: answer.response.services, diagnostics: answer.diagnostics }, null, 2)}</pre></details></section>}
  </section>;
}
