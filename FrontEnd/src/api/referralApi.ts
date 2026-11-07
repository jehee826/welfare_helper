import { authenticatedFetch } from "./auth";
import { apiBaseUrl, requireApiBaseUrl } from "./config";
import { ApiError } from "./errors";

export interface ReferralFilter { dateFrom: string; dateTo: string; departmentId: string }
export interface Referral {
  response_id: string; department_id: number; department_name: string; ministry_name: string;
  label: string; phone: string; source_url: string; document_id: string; document_version: string;
  contact_version: string; created_at: string;
}
export interface ReferralResult {
  items: Referral[];
  departments: { department_id: number; department_name: string; ministry_name: string; response_count: number }[];
  response_count: number; contact_count: number; next_offset: number | null; retention_days: number;
  failed_writes_since_restart: number;
}

async function request(filter: ReferralFilter, signal: AbortSignal, method: "GET" | "DELETE", offset = 0) {
  requireApiBaseUrl();
  const params = new URLSearchParams({ date_from: filter.dateFrom, date_to: filter.dateTo });
  if (filter.departmentId) params.set("department_id", filter.departmentId);
  if (method === "GET") params.set("offset", String(offset));
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) abort.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 30000);
  try {
    const response = await authenticatedFetch(`${apiBaseUrl}/api/v1/admin/referrals?${params}`, {
      method, signal: abort.signal, cache: "no-store", redirect: "error",
    });
    if (!response.ok) throw new ApiError(response.status === 422 ? "기간은 시작일과 종료일을 포함해 90일 이내로 지정해 주세요."
      : "연락처 기록을 불러오지 못했습니다. 서버의 기록 활성화 상태와 연결을 확인해 주세요.", response.status);
    return await response.json();
  } catch (failure) {
    if (timedOut) throw new ApiError("요청 시간을 넘었습니다. 삭제 요청이었다면 결과를 다시 조회해 주세요.", 504);
    throw failure;
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", cancel);
  }
}

export const listReferrals = (filter: ReferralFilter, signal: AbortSignal, offset = 0): Promise<ReferralResult> => request(filter, signal, "GET", offset);
export const deleteReferrals = (filter: ReferralFilter, signal: AbortSignal): Promise<{ deleted_contacts: number }> => request(filter, signal, "DELETE");
