// 확장과 웹이 같은 문서 개인정보 정책을 사용한다. 화면 수집 정책은 별도로 유지한다.
import "../../../Extension/protocol.js";

const privacy = (globalThis as unknown as { GyeoteProtocol: { privacy: {
  sensitiveInput(text: string): boolean;
  maskText(text: string, userHistory?: boolean): string;
  redactDocument<T>(value: T): T;
} } }).GyeoteProtocol.privacy;

export const { sensitiveInput, maskText, redactDocument } = privacy;
export const PRIVACY_NOTICE = "실명·주민번호·연락처·계좌번호 등 개인정보는 입력하지 마세요.";
export const SENSITIVE_INPUT_MESSAGE = "개인정보가 포함된 질문은 보낼 수 없습니다. 개인정보를 제외하고 다시 질문해 주세요.";
