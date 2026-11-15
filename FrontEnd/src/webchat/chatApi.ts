export type Contact = {
  label: string;
  phone: string;
  kind: "general" | "service";
  source_url: string;
  checked_at: string;
  hours?: string;
};

export type ChatResponse = {
  kind: "answer" | "fallback";
  text: string;
  reason?: string;
  contacts: Contact[];
};

export type ApiErrorCode =
  | "config"
  | "capabilities"
  | "invalid"
  | "sensitive"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "response"
  | "unknown";

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode, public readonly status?: number) {
    super(code);
    this.name = "ApiError";
  }
}

export const QUERY_LIMIT = 300;
export const TIMEOUT_SECONDS = 600;
export const CAPABILITIES_TIMEOUT_MS = 15_000;

const PHONE = /^(?:1\d{2,3}|1\d{3}-\d{4}|0[2-9]\d{0,2}-\d{3,4}-\d{4})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** 공개 빌드 변수에서 API 주소를 읽는다. 없거나 https가 아니면 null을 돌려 연결하지 않는다. */
export function apiBase(raw: unknown = import.meta.env.VITE_API_BASE_URL): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** 서버의 글자 수 기준(코드 포인트)에 맞춰 길이를 센다. */
export function queryLength(text: string): number {
  return Array.from(text.trim()).length;
}

function shortText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || Array.from(text).length > limit || CONTROL.test(text)) return null;
  return text;
}

/** 표시 전에 연락처를 검증한다. 형식이 맞지 않는 항목은 버리며 대체 번호를 만들지 않는다. */
export function parseContacts(value: unknown): Contact[] {
  if (!Array.isArray(value)) return [];
  const result: Contact[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const label = shortText(record.label, 160);
    const phone = typeof record.phone === "string" ? record.phone.trim() : "";
    const kind = record.kind;
    if (!label || !PHONE.test(phone) || (kind !== "general" && kind !== "service")) continue;
    if (typeof record.source_url !== "string" || typeof record.checked_at !== "string") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.checked_at)) continue;
    let hours: string | undefined;
    if (record.hours !== undefined && record.hours !== null) {
      const parsed = shortText(record.hours, 100);
      if (!parsed) continue;
      hours = parsed;
    }
    const key = `${label}\u0000${phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ label, phone, kind, source_url: record.source_url, checked_at: record.checked_at, ...(hours ? { hours } : {}) });
  }
  return result;
}

/** 사용하는 필드만 꺼낸다. 서버가 더한 필드는 무시한다. */
export function parseChatResponse(body: unknown): ChatResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("response");
  const record = body as Record<string, unknown>;
  if ((record.kind !== "answer" && record.kind !== "fallback") || typeof record.text !== "string" || !record.text.trim()) {
    throw new ApiError("response");
  }
  return {
    kind: record.kind,
    text: record.text,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    contacts: parseContacts(record.contacts),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 연락처 안내 기록 수집 여부를 확인한다. 404는 비활성으로 보고 그 외 실패는 오류로 돌린다. */
export async function fetchReferralEnabled(base: string, signal: AbortSignal): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/v1/chat/capabilities`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError("capabilities");
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new ApiError("capabilities", response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError("capabilities", response.status);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("capabilities", response.status);
  const value = (body as Record<string, unknown>).referral_records_enabled;
  if (value !== undefined && typeof value !== "boolean") throw new ApiError("capabilities", response.status);
  return value === true;
}

function isSensitive(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const detail = (body as Record<string, unknown>).detail;
  if (detail === "sensitive_input") return true;
  return Array.isArray(detail) && detail.some((item) => !!item && typeof item === "object" && (item as Record<string, unknown>).type === "sensitive_input");
}

function statusError(status: number, body: unknown): ApiError {
  if (status === 422) return new ApiError(isSensitive(body) ? "sensitive" : "invalid", 422);
  if (status === 429) return new ApiError("rate_limit", 429);
  if (status === 503) return new ApiError("server", 503);
  if (status === 504 || status === 408) return new ApiError("timeout", status);
  return new ApiError("unknown", status);
}

const DRAFT_LIMIT = 3000;
const STREAM_LIMIT = 2 * 1024 * 1024;

async function readStream(response: Response, onDraft?: (text: string) => void): Promise<ChatResponse> {
  if (!response.body) throw new ApiError("response", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let draft = "";
  let size = 0;
  let final: ChatResponse | null = null;
  const readLine = (line: string) => {
    if (!line.trim()) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ApiError("response", response.status);
    }
    if (final) throw new ApiError("response", response.status);
    if (event?.type === "accepted") return;
    if (event?.type === "draft") {
      const next = typeof event.text === "string" ? event.text : typeof event.append === "string" ? draft + event.append : null;
      if (next === null || next.length > DRAFT_LIMIT) throw new ApiError("response", response.status);
      draft = next;
      onDraft?.(draft);
      return;
    }
    if (event?.type === "final") {
      final = parseChatResponse(event.response);
      return;
    }
    if (event?.type === "error" && typeof event.status === "number") throw statusError(event.status, { detail: event.detail });
    throw new ApiError("response", response.status);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > STREAM_LIMIT) throw new ApiError("response", response.status);
      buffered += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        readLine(buffered.slice(0, index));
        buffered = buffered.slice(index + 1);
      }
    }
    readLine(buffered + decoder.decode());
  } catch (error) {
    if (isAbort(error) || error instanceof ApiError) throw error;
    throw new ApiError("network");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!final) throw new ApiError("response", response.status);
  return final;
}

/** 현재 질문 하나만 보낸다. 대화 기록·프로필·인증 정보는 포함하지 않는다.
 *
 * 스트리밍 경로의 초안은 onDraft로만 전달하며 검증된 final 응답이 항상 대체한다.
 * 스트리밍 경로가 없는 서버는 기존 /api/v1/chat으로 한 번 다시 요청한다.
 */
export async function postChat(base: string, query: string, signal: AbortSignal,
                               onDraft?: (text: string) => void): Promise<ChatResponse> {
  const send = (path: string) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, timeout_seconds: TIMEOUT_SECONDS }),
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  let response: Response;
  let body: unknown = null;
  try {
    response = await send("/api/v1/chat/stream");
    if (response.status === 404 || response.status === 405) {
      body = await response.json().catch(() => null);
      const detail = body && typeof body === "object" ? (body as Record<string, unknown>).detail : null;
      if (detail === "Not Found" || detail === "Method Not Allowed") {
        body = null;
        response = await send("/api/v1/chat");
      }
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError("network");
  }
  if (response.ok && (response.headers.get("content-type") ?? "").startsWith("application/x-ndjson")) {
    return readStream(response, onDraft);
  }
  if (body === null) {
    try {
      body = await response.json();
    } catch (error) {
      if (isAbort(error)) throw error;
      if (response.ok) throw new ApiError("response", response.status);
    }
  }
  if (response.ok) return parseChatResponse(body);
  throw statusError(response.status, body);
}

export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  config: "연결 설정 오류: 서버 주소가 설정되지 않아 질문을 보낼 수 없습니다. 운영 담당자에게 알려 주세요.",
  capabilities: "연락처 안내 기록 설정을 확인하지 못해 질문을 보내지 않았습니다. 잠시 후 다시 보내 주세요.",
  invalid: "질문 형식을 확인해 주세요. 300자 이내로 다시 적어 주세요.",
  sensitive: "주민등록번호·계좌번호·휴대전화번호 같은 개인정보를 빼고 다시 질문해 주세요.",
  rate_limit: "요청이 많아 잠시 제한되었습니다. 잠시 후 다시 보내 주세요.",
  server: "서버에서 답변을 만들지 못했습니다. 잠시 후 다시 보내 주세요.",
  network: "서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 보내 주세요.",
  timeout: "답변을 기다리는 시간(10분)이 지났습니다. 잠시 후 다시 보내 주세요.",
  response: "서버 응답을 읽지 못했습니다. 잠시 후 다시 보내 주세요.",
  unknown: "요청을 처리하지 못했습니다. 잠시 후 다시 보내 주세요.",
};
