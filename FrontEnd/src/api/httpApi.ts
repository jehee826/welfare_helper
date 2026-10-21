import { createMockApi } from "./mockApi";
import type { ChatAnswer, WelfareApi } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * 채팅(ask)은 백엔드 /api/v1/chat을 호출하고, 아직 백엔드가 없는 관리자 기능은 목업에 맡긴다.
 */
export function createHttpApi(options: { baseUrl?: string; fallback?: WelfareApi } = {}): WelfareApi {
  const baseUrl = options.baseUrl ?? "";
  const fallback = options.fallback ?? createMockApi();
  return {
    initialSuggestions: fallback.initialSuggestions,
    listPrograms: fallback.listPrograms,
    savePrograms: fallback.savePrograms,
    getMonthlyStats: fallback.getMonthlyStats,

    async ask(query, profile) {
      const response = await fetch(`${baseUrl}/api/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, profile }),
      });
      if (!response.ok) {
        let detail = "상담 응답을 받지 못했어요.";
        try {
          const body = (await response.json()) as { detail?: unknown };
          if (typeof body.detail === "string") detail = body.detail;
        } catch {
          detail = `${detail} (${response.status})`;
        }
        throw new ApiError(detail, response.status);
      }
      return (await response.json()) as ChatAnswer;
    },
  };
}
