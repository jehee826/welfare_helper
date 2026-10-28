import { getSupabase } from "../auth/supabase";
import { apiBaseUrl, requireApiBaseUrl } from "./config";
import { ApiError } from "./errors";

export async function authenticatedFetch(url: string, options: RequestInit = {}) {
  const client = getSupabase();
  const result = client ? await client.auth.getSession() : null;
  if (result?.error) throw new ApiError("로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.", 401, "session_expired");
  const token = result?.data.session?.access_token;
  const send = (accessToken?: string) => {
    const headers = new Headers(options.headers);
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(url, { ...options, headers });
  };
  let response = await send(token);
  // 인증 실패 응답만 한 번 갱신한다. 네트워크 오류나 처리 완료 요청을 자동 반복하지 않는다.
  if (response.status === 401 && token && client && !options.signal?.aborted) {
    const refreshed = await client.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session) {
      throw new ApiError("로그인이 만료되었습니다. 다시 로그인해 주세요.", 401, "session_expired");
    }
    response = await send(refreshed.data.session.access_token);
  }
  return response;
}

export async function checkAdminAccess(signal: AbortSignal) {
  requireApiBaseUrl();
  const response = await authenticatedFetch(`${apiBaseUrl}/api/v1/admin/session`, { signal });
  if (!response.ok) throw new ApiError(response.status === 403
    ? "활성 관리자 권한이 없습니다. 관리자 등록 상태를 확인해 주세요."
    : response.status === 401 ? "관리자 로그인이 필요합니다." : "관리자 서버 설정과 연결을 확인해 주세요.", response.status);
  const body = await response.json() as { is_admin: boolean; access_mode: "local" | "authenticated" };
  if (body.is_admin !== true || !["local", "authenticated"].includes(body.access_mode)) throw new ApiError("관리자 권한을 확인하지 못했습니다.", 403);
  return body;
}
