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

async function passwordRequest(operation: "issue" | "activate", body: object, signal: AbortSignal) {
  requireApiBaseUrl();
  const response = await authenticatedFetch(`${apiBaseUrl}/api/v1/admin/password/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    cache: "no-store", redirect: "error",
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { detail?: string };
    throw new ApiError(detail.detail === "current_password_invalid" ? "기존 비밀번호가 일치하지 않습니다."
      : response.status === 429 ? "인증 시도가 많습니다. 잠시 후 다시 시도해 주세요."
      : response.status === 409 ? "다른 비밀번호 발급을 처리 중입니다. 잠시 후 다시 시도해 주세요."
      : "비밀번호를 재발급하지 못했습니다. 서버 상태를 확인한 뒤 다시 시도해 주세요.", response.status);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

export async function issueAdminPassword(currentPassword: string, signal: AbortSignal) {
  const body = await passwordRequest("issue", { current_password: currentPassword }, signal);
  if (typeof body.password !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.password)
      || typeof body.rotation_token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(body.rotation_token)) {
    throw new ApiError("발급 응답을 확인하지 못했습니다. 기존 비밀번호는 유지됩니다.", 502);
  }
  return { password: body.password, rotationToken: body.rotation_token };
}

export async function activateAdminPassword(rotationToken: string, signal: AbortSignal) {
  const body = await passwordRequest("activate", { rotation_token: rotationToken }, signal);
  if (body.applied !== true) throw new ApiError("새 비밀번호의 적용 상태를 확인하지 못했습니다.", 502);
}
