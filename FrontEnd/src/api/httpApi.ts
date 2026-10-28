import { ApiError } from "./errors";
import { apiBaseUrl, requireApiBaseUrl } from "./config";
import { authenticatedFetch } from "./auth";
import { createMockApi } from "./mockApi";
import type { AdminProgram, ChatAnswer, Department, ProgramInput, WelfareApi } from "./types";

export { ApiError };

interface RawProgram {
  program_id: number;
  service_id: string;
  external_service_id: string | null;
  program_name: string;
  summary: string;
  department_id: number;
  department_name: string;
  ministry_name: string;
  contacts: AdminProgram["contacts"];
  source_url: string | null;
  source_updated_at: string | null;
  test_only: boolean;
  updated_at: string;
  document_count: number;
  published_count: number;
}

const LIST_LIMIT = 200;

const FIELD_NAMES: Record<keyof ProgramInput, string> = {
  name: "program_name",
  summary: "summary",
  departmentId: "department_id",
  externalServiceId: "external_service_id",
  sourceUrl: "source_url",
  sourceUpdatedAt: "source_updated_at",
  contacts: "contacts",
  testOnly: "test_only",
};

function toProgram(raw: RawProgram): AdminProgram {
  return {
    programId: raw.program_id,
    serviceId: raw.service_id,
    externalServiceId: raw.external_service_id,
    name: raw.program_name,
    summary: raw.summary,
    departmentId: raw.department_id,
    departmentName: raw.department_name,
    ministryName: raw.ministry_name,
    contacts: raw.contacts,
    sourceUrl: raw.source_url,
    sourceUpdatedAt: raw.source_updated_at,
    testOnly: raw.test_only,
    updatedAt: raw.updated_at,
    documentCount: raw.document_count,
    publishedCount: raw.published_count,
  };
}

function toBody(input: Partial<ProgramInput>): Record<string, unknown> {
  return Object.fromEntries(
    (Object.keys(input) as (keyof ProgramInput)[]).map((key) => [FIELD_NAMES[key], input[key]]),
  );
}

async function failure(response: Response, fallbackMessage: string): Promise<ApiError> {
  let detail: unknown;
  try {
    detail = ((await response.json()) as { detail?: unknown }).detail;
  } catch {
    detail = undefined;
  }
  if (typeof detail === "string") return new ApiError(detail, response.status, detail);
  if (Array.isArray(detail)) return new ApiError("invalid_request", response.status, "invalid_request");
  return new ApiError(`${fallbackMessage} (${response.status})`, response.status);
}

/**
 * 채팅(ask)과 관리자 제도 관리는 백엔드 API를 호출하고, 아직 백엔드가 없는 이용 통계는 목업에 맡긴다.
 */
export function createHttpApi(options: { baseUrl?: string; fallback?: WelfareApi } = {}): WelfareApi {
  const baseUrl = (options.baseUrl ?? apiBaseUrl).replace(/\/+$/, "");
  const fallback = options.fallback ?? createMockApi();

  async function admin<T>(path: string, init: RequestInit = {}): Promise<T> {
    requireApiBaseUrl(baseUrl);
    const response = await authenticatedFetch(`${baseUrl}/api/v1/admin${path}`, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
    });
    if (!response.ok) throw await failure(response, "관리자 요청을 처리하지 못했어요.");
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  return {
    initialSuggestions: () => [],
    getMonthlyStats: fallback.getMonthlyStats,

    async ask(query, _profile, signal) {
      requireApiBaseUrl(baseUrl);
      const response = await authenticatedFetch(`${baseUrl}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal,
      });
      if (!response.ok) {
        const error = await failure(response, "상담 응답을 받지 못했어요.");
        throw error.code === "invalid_request" ? new ApiError("상담 응답을 받지 못했어요.", error.status) : error;
      }
      return (await response.json()) as ChatAnswer;
    },

    async listPrograms(query = "") {
      const params = new URLSearchParams({ query, limit: String(LIST_LIMIT) });
      if (!query) params.delete("query");
      const page = await admin<{ items: RawProgram[]; next_offset: number | null }>(`/programs?${params}`);
      return { items: page.items.map(toProgram), hasMore: page.next_offset !== null };
    },

    async listDepartments() {
      const rows = await admin<{ department_id: number; department_name: string; ministry_name: string }[]>("/departments");
      return rows.map((r): Department => ({ id: r.department_id, name: r.department_name, ministry: r.ministry_name }));
    },

    async createProgram(input) {
      return toProgram(await admin<RawProgram>("/programs", { method: "POST", body: JSON.stringify(toBody(input)) }));
    },

    async updateProgram(program, changes) {
      const body = { ...toBody(changes), expected_updated_at: program.updatedAt };
      return toProgram(
        await admin<RawProgram>(`/programs/${program.programId}`, { method: "PATCH", body: JSON.stringify(body) }),
      );
    },

    async deleteProgram(programId) {
      await admin<void>(`/programs/${programId}`, { method: "DELETE" });
    },
  };
}
