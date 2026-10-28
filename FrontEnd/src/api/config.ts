import { ApiError } from "./errors";

// 비밀값 없이 API 서버의 기본 주소만 빌드 시 반영한다. 개발 중 빈 값은 동일 출처다.
export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

export function requireApiBaseUrl(baseUrl = apiBaseUrl) {
  if (import.meta.env.PROD && !baseUrl) {
    throw new ApiError("백엔드가 연결되지 않았습니다. 배포 설정에 VITE_API_BASE_URL을 지정하고 다시 빌드해 주세요.", 503, "backend_not_configured");
  }
}
