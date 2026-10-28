import { clearAdminSession, readAdminSession, saveAdminSession, type AdminSession } from "../auth/session";
import { apiBaseUrl, requireApiBaseUrl } from "./config";
import { ApiError } from "./errors";

export async function authenticatedFetch(url: string, options: RequestInit = {}) {
  const session = readAdminSession();
  const headers = new Headers(options.headers);
  if (session) headers.set("Authorization", `Bearer ${session.access_token}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && session) {
    clearAdminSession(session.session_id);
    throw new ApiError("관리자 세션이 만료되었습니다. 다시 로그인해 주세요.", 401, "session_expired");
  }
  return response;
}

export async function loginAdmin(password: string) {
  requireApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}/api/v1/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  if (!response.ok) throw new ApiError(response.status === 401 ? "관리자 비밀번호가 일치하지 않습니다."
    : response.status === 429 ? "로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요."
    : "관리자 비밀번호 서버 설정과 연결을 확인해 주세요.", response.status);
  saveAdminSession(await response.json() as AdminSession);
}

export async function logoutAdmin() {
  const session = readAdminSession();
  try {
    requireApiBaseUrl();
    const response = await authenticatedFetch(`${apiBaseUrl}/api/v1/admin/logout`, { method: "POST" });
    if (!response.ok) throw new Error("logout_failed");
  } finally { if (session) clearAdminSession(session.session_id); }
}

export async function checkAdminAccess(signal: AbortSignal) {
  requireApiBaseUrl();
  const response = await authenticatedFetch(`${apiBaseUrl}/api/v1/admin/session`, { signal });
  if (!response.ok) throw new ApiError(response.status === 401 ? "관리자 로그인이 필요합니다." : "관리자 서버 설정과 연결을 확인해 주세요.", response.status);
  const body = await response.json() as { is_admin: boolean; access_mode: string };
  if (body.is_admin !== true || body.access_mode !== "shared_password") throw new ApiError("관리자 권한을 확인하지 못했습니다.", 403);
  return body;
}
