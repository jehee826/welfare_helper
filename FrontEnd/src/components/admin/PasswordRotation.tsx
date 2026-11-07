import { useEffect, useRef, useState, type FormEvent } from "react";
import { activateAdminPassword, issueAdminPassword } from "../../api/auth";
import { ApiError } from "../../api/errors";
import { useAuth } from "../../auth/AuthProvider";
import { clearAdminSession, readAdminSession } from "../../auth/session";
import "./password-rotation.css";

export function PasswordRotation() {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ password: string; applied: boolean }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const controller = useRef<AbortController>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const submitting = useRef(false);
  const received = useRef(false);

  useEffect(() => () => { clearTimeout(timer.current); controller.current?.abort(); }, []);
  useEffect(() => {
    if (!received.current) {
      controller.current?.abort();
      clearTimeout(timer.current);
      setOpen(false); setError(""); setBusy(false); submitting.current = false;
    }
  }, [session?.session_id]);

  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    if (node?.showModal && !node.open) node.showModal();
    else node?.setAttribute("open", "");
    node?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { if (node?.open && node.close) node.close(); };
  }, [open]);

  useEffect(() => {
    if (issued) dialog.current?.querySelector<HTMLInputElement>("input[readonly]")?.focus();
  }, [issued?.password]);

  function close() {
    if (submitting.current) return;
    setOpen(false); setIssued(undefined); setError(""); received.current = false;
    const target = previousFocus.current?.isConnected ? previousFocus.current
      : document.querySelector<HTMLInputElement>('input[autocomplete="current-password"]');
    target?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !session) return;
    const password = String(new FormData(event.currentTarget).get("current_password") ?? "");
    event.currentTarget.reset();
    const owner = session.session_id;
    const abort = new AbortController(); controller.current = abort;
    let timedOut = false;
    timer.current = setTimeout(() => { timedOut = true; abort.abort(); }, 30000);
    submitting.current = true; setBusy(true); setError("");
    let result: { password: string; rotationToken: string } | undefined;
    try {
      result = await issueAdminPassword(password, abort.signal);
      if (abort.signal.aborted || readAdminSession()?.session_id !== owner) return;
      received.current = true;
      setIssued({ password: result.password, applied: false });
      // 발급값을 받은 뒤 자동 확인한다. 별도 적용 버튼이나 비밀번호 저장은 없다.
      await activateAdminPassword(result.rotationToken, abort.signal);
      if (abort.signal.aborted) return;
      setIssued({ password: result.password, applied: true });
      clearAdminSession(owner);
    } catch (failure) {
      if (!abort.signal.aborted || timedOut) {
        if (result && received.current) {
          setIssued({ password: result.password, applied: false });
          setError("적용 여부를 확인하지 못했습니다. 이 값을 복사해 새 비밀번호로 로그인해 보세요. 적용되지 않았다면 기존 비밀번호가 유지됩니다.");
        } else setError(failure instanceof ApiError ? failure.message : "서버에 연결하지 못했습니다. 기존 비밀번호는 유지됩니다.");
      }
    } finally {
      if (controller.current === abort) {
        clearTimeout(timer.current);
        submitting.current = false;
        if (!abort.signal.aborted || timedOut) setBusy(false);
      }
    }
  }

  async function copy() {
    if (!issued || busy) return;
    try {
      await navigator.clipboard.writeText(issued.password);
      close();
    } catch { setError("자동 복사를 사용할 수 없습니다. 비밀번호를 직접 선택해 복사한 뒤 닫아 주세요."); }
  }

  return <>
    {session && <div className="password-toolbar"><button type="button" className="btn btn--soft" disabled={busy} onClick={() => {
      previousFocus.current = document.activeElement as HTMLElement;
      setIssued(undefined); setError(""); received.current = false; setOpen(true);
    }}>비밀번호 재발급</button></div>}
    {open && <dialog ref={dialog} className="password-dialog card" aria-labelledby="password-dialog-title"
      onCancel={event => { event.preventDefault(); close(); }}>
      <h2 id="password-dialog-title">{issued ? "새 관리자 비밀번호" : "비밀번호 재발급"}</h2>
      {issued ? <div className="stack">
        <p role="status">{busy ? "새 비밀번호를 적용하고 있습니다…" : issued.applied
          ? "기존 관리자 세션을 종료했습니다. 새 비밀번호로 로그인해 주세요." : "비밀번호 적용 상태를 확인해 주세요."}</p>
        <label className="field">새 비밀번호<input value={issued.password} readOnly autoComplete="off" onFocus={event => event.currentTarget.select()} /></label>
        <p>이 창에서 한 번만 표시됩니다. 닫기 전에 복사해 보관하세요.</p>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void copy()}>복사하고 닫기</button>
      </div> : <form className="stack" onSubmit={event => void submit(event)}>
        <p>기존 비밀번호를 확인한 뒤 새 비밀번호를 발급합니다. 변경 후 모든 관리자 세션이 종료됩니다.</p>
        <label className="field">기존 비밀번호<input name="current_password" type="password" autoComplete="current-password" maxLength={256} required disabled={busy} /></label>
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "발급 중…" : "새 비밀번호 발급"}</button>
      </form>}
      {error && <p role="alert">{error}</p>}
      <button type="button" className="btn btn--soft" disabled={busy} onClick={close}>닫기</button>
    </dialog>}
  </>;
}
