import { apiBaseUrl, requireApiBaseUrl } from "./config";
import { ApiError } from "./errors";
import { authenticatedFetch } from "./auth";

export const documentApiRoot = `${apiBaseUrl}/api/v1/admin/documents`;
export interface Program { service_id: string; program_name: string; test_only: boolean }
export interface Block { id: string; text: string; markdown_text?: string; pages: number[]; table?: unknown; char_start?: number; char_end?: number }
export interface Analysis {
  hash: string; job_id: string; scope: string; blockers: string[]; warnings: string[];
  total_blocks: number; blocks: Block[]; next_offset: number | null;
}
export interface Job {
  job_id: string; state: string; error_code: string | null; reviewed_at?: string | null; progress?: { stored: number };
  created_at?: string; finished_at?: string | null;
  processing_mode?: "automatic" | "manual"; processed_at?: string | null;
  candidate_metadata?: Partial<Pick<DocumentStatus, "name" | "source_url" | "source_organization" | "source_updated_at" | "service_id" | "test_only">> & { basis_year?: string | number | null; document_name?: string };
}
export interface DocumentStatus {
  document_id: string; name: string; service_id: string; source_url: string; source_organization: string;
  basis_year: number | null; source_updated_at: string | null; test_only: boolean;
  active_job_id: string | null; jobs: Job[]; analysis?: Analysis;
}
export interface SearchResult { chunks: { chunk_id: string; text: string; section: string; similarity: number; pages: number[]; source_blocks: string[]; start: number; end: number }[] }
export interface QueryResult { response: { text: string; kind: string; reason?: string; services?: unknown[] }; diagnostics: unknown }

export class DocumentApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === "document_generation_failed"
      ? "문서 답변 모델 실행에 실패했습니다. 모델 상태를 확인한 뒤 다시 질문해 주세요."
      : code === "document_embedding_failed"
        ? "질문 임베딩에 실패했습니다. 임베딩 모델 상태를 확인한 뒤 다시 질문해 주세요."
      : code === "document_reranker_failed"
        ? "검색 결과 순위 계산에 실패했습니다. 리랭커 상태를 확인한 뒤 다시 질문해 주세요."
      : code === "automatic_processing_schema_required"
      ? "자동 처리 DB 마이그레이션이 필요합니다. 0005 설정을 적용한 뒤 다시 시도하세요."
      : code === "legacy_review_requires_reupload"
        ? "이전 검토 대기 작업입니다. 같은 문서 ID로 원문을 다시 첨부해 자동 처리하세요."
      : status === 503
      ? "문서 서버 또는 DB 연결을 확인하세요. 비밀번호를 변경했다면 컨테이너 restart만으로 환경변수가 갱신되지 않습니다. 환경 반영 후 다시 시도하세요."
      : status === 401 || status === 403
        ? "로그인 세션과 활성 관리자 권한을 확인해 주세요."
        : "요청을 완료하지 못했습니다. 상태를 새로 확인한 뒤 다시 시도하세요.");
  }
}

export async function documentRequest<T>(path: string, signal: AbortSignal, options: RequestInit = {}): Promise<T> {
  requireApiBaseUrl();
  const response = await authenticatedFetch(documentApiRoot + path, { ...options, signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: unknown };
    // 예외 본문이나 비밀 설정이 화면에 노출되지 않도록 공개 오류 코드만 표시한다.
    const code = typeof body.detail === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(body.detail) ? body.detail : `http_${response.status}`;
    throw new DocumentApiError(response.status, code);
  }
  return (response.headers.get("content-type")?.includes("text/plain") ? await response.text() : await response.json()) as T;
}

export function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function documentError(error: unknown) {
  if (error instanceof ApiError && ["backend_not_configured", "session_expired"].includes(error.code)) return error.message;
  if (error instanceof ApiError && [401, 403].includes(error.status)) return "로그인 세션과 활성 관리자 권한을 확인해 주세요.";
  return error instanceof DocumentApiError ? `${error.message} (${error.code})` : "서버에 연결하지 못했습니다. 백엔드와 Vite 프록시를 확인한 뒤 다시 시도하세요.";
}
