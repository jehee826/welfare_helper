import { useEffect, useRef, useState, type FormEvent } from "react";
import { deleteReferrals, listReferrals, type ReferralFilter, type ReferralResult } from "../api/referralApi";
import { ApiError } from "../api/errors";

function day(offset: number) {
  return new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

export function ReferralsPage() {
  const [filter, setFilter] = useState<ReferralFilter>(() => ({ dateFrom: day(-29), dateTo: day(0), departmentId: "" }));
  const [query, setQuery] = useState(() => ({ filter, offset: 0, revision: 0 }));
  const [result, setResult] = useState<ReferralResult>();
  const [departments, setDepartments] = useState<ReferralResult['departments']>([]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const abortDelete = useRef<AbortController>();
  const deleteLock = useRef(false);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);

  useEffect(() => () => abortDelete.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true); setError(""); setResult(undefined);
    listReferrals(query.filter, abort.signal, query.offset).then(value => {
      if (!abort.signal.aborted) {
        setResult(value);
        setDepartments(previous => [...new Map([...previous, ...value.departments].map(item => [item.department_id, item])).values()]);
      }
    }).catch(failure => {
      if (!abort.signal.aborted) setError(failure instanceof ApiError ? failure.message : "서버에 연결하지 못했습니다.");
    }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [query]);

  useEffect(() => {
    if (!confirm) return;
    const node = confirmDialog.current;
    if (node?.showModal && !node.open) node.showModal(); else node?.setAttribute("open", "");
    node?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (node?.open && node.close) node.close(); };
  }, [confirm]);

  function refresh(event: FormEvent) {
    event.preventDefault(); setNotice(""); setQuery(previous => ({ filter, offset: 0, revision: previous.revision + 1 }));
  }
  function closeConfirm() {
    if (deleteLock.current) return;
    setConfirm(false); deleteButton.current?.focus();
  }
  async function remove() {
    if (deleteLock.current) return;
    deleteLock.current = true; setDeleting(true); setError("");
    const abort = new AbortController(); abortDelete.current = abort;
    try {
      const value = await deleteReferrals(query.filter, abort.signal);
      if (abort.signal.aborted) return;
      setNotice(`연락처 기록 ${value.deleted_contacts}건을 삭제했습니다. 집계에도 반영됩니다.`);
      setConfirm(false); setQuery(previous => ({ ...previous, offset: 0, revision: previous.revision + 1 }));
    } catch (failure) {
      if (!abort.signal.aborted) {
        setError(failure instanceof ApiError ? failure.message : "삭제 결과를 확인하지 못했습니다. 목록을 다시 조회해 주세요.");
        setConfirm(false);
      }
    } finally {
      deleteLock.current = false;
      if (!abort.signal.aborted) { setDeleting(false); deleteButton.current?.focus(); }
    }
  }

  return <section className="stack-lg">
    <h1>연락처 안내 기록</h1>
    <p>공개 상담에서 서버가 생성한 연락처 안내 건수입니다. 실제 이용자·화면 수신·전화 발신·신청 횟수가 아닙니다.</p>
    <p>질문·답변·요약·프로필·IP는 저장하지 않습니다. 기록은 90일 후 삭제되며 만료·삭제된 기록은 통계에서도 제외됩니다.</p>
    <form className="card stack" onSubmit={refresh}>
      <label className="field">시작일 (한국 시각)<input type="date" value={filter.dateFrom} required disabled={busy || deleting} onChange={event => setFilter({ ...filter, dateFrom: event.target.value })} /></label>
      <label className="field">종료일 (한국 시각)<input type="date" value={filter.dateTo} required disabled={busy || deleting} onChange={event => setFilter({ ...filter, dateTo: event.target.value })} /></label>
      <label className="field">담당 부서<select value={filter.departmentId} disabled={busy || deleting} onChange={event => setFilter({ ...filter, departmentId: event.target.value })}>
        <option value="">전체 부서</option>
        {departments.map(item => <option key={item.department_id} value={item.department_id}>{item.ministry_name} · {item.department_name}</option>)}
      </select></label>
      <button className="btn btn--primary" disabled={busy || deleting}>조회</button>
    </form>
    {busy && <p role="status">기록을 불러오고 있습니다…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {result && <>
      <p>조회 기준: {query.filter.dateFrom} ~ {query.filter.dateTo} (한국 시각), {query.filter.departmentId ? "선택한 부서" : "전체 부서"}</p>
      {result.failed_writes_since_restart > 0 && <p role="alert">서버 재시작 이후 저장 실패 {result.failed_writes_since_restart}건이 있어 집계가 누락될 수 있습니다.</p>}
      <section className="card stack" aria-label="안내 집계">
        <h2>안내 응답 {result.response_count}건 · 연락처 {result.contact_count}건</h2>
        <p>한 응답에서 같은 부서를 여러 번 안내해도 부서별 횟수는 1건입니다.</p>
        {result.departments.map(item => <p key={item.department_id}>{item.ministry_name} · {item.department_name}: {item.response_count}건</p>)}
      </section>
      {result.items.length === 0 ? <p>해당 기간의 연락처 안내 기록이 없습니다.</p> : <ul className="stack" aria-label="연락처 안내 이력">
        {result.items.map(item => <li className="card stack" key={`${item.response_id}:${item.contact_version}`}>
          <strong>{item.label} · {item.phone}</strong>
          <span>{item.ministry_name} · {item.department_name}</span>
          <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</time>
          <a href={item.source_url} target="_blank" rel="noreferrer">연락처 증명 출처</a>
        </li>)}
      </ul>}
      <div className="stack">
        {query.offset > 0 && <button className="btn btn--soft" disabled={busy || deleting} onClick={() => setQuery({ ...query, offset: Math.max(0, query.offset - 50) })}>이전 기록</button>}
        {result.next_offset !== null && <button className="btn btn--soft" disabled={busy || deleting} onClick={() => setQuery({ ...query, offset: result.next_offset! })}>다음 기록</button>}
        <button ref={deleteButton} className="btn btn--soft" disabled={busy || deleting || result.contact_count === 0} onClick={() => setConfirm(true)}>조회 조건의 기록 삭제</button>
      </div>
    </>}
    {confirm && <dialog ref={confirmDialog} className="password-dialog card" aria-labelledby="delete-referrals-title" onCancel={event => { event.preventDefault(); closeConfirm(); }}>
      <h2 id="delete-referrals-title">연락처 기록 삭제</h2>
      <p>{query.filter.dateFrom} ~ {query.filter.dateTo}, {query.filter.departmentId ? "선택한 부서" : "전체 부서"}의 기록을 삭제합니다. 집계도 줄어들며 되돌릴 수 없습니다.</p>
      <button className="btn btn--soft" disabled={deleting} onClick={closeConfirm}>취소</button>
      <button className="btn btn--primary" disabled={deleting} onClick={() => void remove()}>{deleting ? "삭제 중…" : "해당 기록 영구 삭제"}</button>
    </dialog>}
  </section>;
}
