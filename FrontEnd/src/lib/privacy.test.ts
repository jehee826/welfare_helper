import cases from "../../../BackEnd/tests/fixtures/document_privacy_cases.json";
import { maskText, redactDocument, sensitiveInput } from "./privacy";

it.each(cases)("서버와 같은 가상 경계 사례: $text", ({ text, sensitive }) => {
  expect(sensitiveInput(text)).toBe(sensitive);
});

it("응답의 공공 연락처와 숫자를 유지하고 명백한 식별정보와 근거만 정제한다", () => {
  const raw = { text: "2026년 129, 1355, 14일, 계좌번호: 321-00-000001", contacts: [{ phone: "010-0000-0000" }],
    evidence: [{ chunk_id: "chunk", quote: "991399-1234567", context: "개인 연락처: 010-0000-0000" }] };
  const result = redactDocument(raw);
  expect(result.text).toContain("2026년 129, 1355, 14일");
  expect(JSON.stringify(result.evidence)).not.toMatch(/991399|010-0000/);
  expect(result.evidence[0]).toHaveProperty("redacted", true);
  expect(result.contacts).toEqual(raw.contacts);
  expect(raw.evidence[0].quote).toBe("991399-1234567");
  expect(maskText("010-0000-0000", true)).toBe("[개인정보 가림]");
  expect(maskText("신청자의 휴대전화번호는 010-0000-0000")).toBe("[개인정보 가림]");
});
