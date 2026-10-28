import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { checkAdminAccess } from "../../api/auth";
import { ApiError } from "../../api/errors";
import { AdminLogin } from "./AdminLogin";

export function AdminGate({ children }: { children: ReactNode }) {
  const { ready, epoch } = useAuth();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ epoch: number; retry: number; allowed: boolean; error: string }>();
  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    void checkAdminAccess(abort.signal).then(() => {
      if (!abort.signal.aborted) setResult({ epoch, retry, allowed: true, error: "" });
    }).catch(error => {
      if (!abort.signal.aborted) setResult({ epoch, retry, allowed: false,
        error: error instanceof ApiError && error.status === 401 ? "" : error instanceof ApiError ? error.message : "관리자 서버에 연결하지 못했습니다." });
    });
    return () => abort.abort();
  }, [ready, epoch, retry]);
  if (!ready || result?.epoch !== epoch || result.retry !== retry) return <p role="status">관리자 권한 확인 중…</p>;
  if (result.allowed) return <>{children}</>;
  return <>{result.error && <p role="alert">{result.error}</p>}<AdminLogin onSuccess={() => setRetry(value => value + 1)} /></>;
}
