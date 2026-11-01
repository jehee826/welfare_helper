import { SENSITIVE_INPUT_MESSAGE } from "../lib/privacy";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code = "") {
    super(message);
  }
}

export function chatError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "sensitive_input") return SENSITIVE_INPUT_MESSAGE;
    if (error.status === 429) return "다른 요청을 처리 중입니다. 잠시 후 직접 다시 질문해 주세요.";
    if (error.status === 504) return "요청 처리 시간을 넘었습니다. 잠시 후 다시 질문해 주세요.";
    if (error.status === 499) return "요청이 취소되었습니다. 다시 질문할 수 있습니다.";
    if ([401, 403].includes(error.status) || error.code === "session_expired") return "관리자 세션이 없거나 만료됐습니다. 다시 로그인해 주세요.";
    if (error.code === "backend_not_configured") return "상담 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.";
    if (error.status === 422) return "질문 내용을 확인한 뒤 다시 보내 주세요.";
    return "문서 검색이나 답변 처리에 실패했습니다. 잠시 후 다시 질문해 주세요.";
  }
  return "서버에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.";
}
