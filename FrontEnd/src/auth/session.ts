import { ApiError } from "../api/errors";

export interface AdminSession { access_token: string; session_id: string; expires_at: number }
export const SESSION_KEY = "welfare.admin-session";
export const SESSION_EVENT = "welfare-admin-session";

export function clearAdminSession(expectedId?: string) {
  if (expectedId) {
    try {
      if (JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null")?.session_id !== expectedId) return;
    } catch { return; }
  }
  sessionStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event(SESSION_EVENT));
}

export function saveAdminSession(session: AdminSession) {
  if (!session.access_token || !session.session_id || !Number.isFinite(session.expires_at)) throw new Error("invalid_admin_session");
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event(SESSION_EVENT));
}

export function readAdminSession(): AdminSession | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as AdminSession;
    if (typeof session.access_token !== "string" || !session.access_token || typeof session.session_id !== "string"
        || !session.session_id || !Number.isFinite(session.expires_at) || session.expires_at * 1000 <= Date.now()) throw new Error();
    return session;
  } catch {
    clearAdminSession();
    throw new ApiError("관리자 세션이 만료되었습니다. 다시 로그인해 주세요.", 401, "session_expired");
  }
}
