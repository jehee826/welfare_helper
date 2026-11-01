import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ChatPanel } from "./ChatPanel";
import { UserPage } from "../pages/UserPage";
import { createMockApi } from "../api/mockApi";
import { createHttpApi } from "../api/httpApi";
import { ApiError, chatError } from "../api/errors";
import { documentRequest, jsonPost } from "../api/documentApi";
import { SENSITIVE_INPUT_MESSAGE } from "../lib/privacy";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const submit = (text: string) => {
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
};

it.each(["991399-1234567", "010-0000-0000", "계좌번호: 321-00-000001"])("전송·메시지·새 이력보다 먼저 질문을 차단한다: %s", raw => {
  const ask = vi.fn(), onAnswered = vi.fn(), fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<ChatPanel api={{ ask, initialSuggestions: () => [] }} profile={null} onAnswered={onAnswered} />);
  submit(raw);
  expect(screen.getByText(SENSITIVE_INPUT_MESSAGE)).toBeInTheDocument();
  expect(screen.getByRole("log")).not.toHaveTextContent(raw);
  expect(screen.getByLabelText("궁금한 내용")).toHaveValue("");
  expect(ask).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(onAnswered).not.toHaveBeenCalled();
  expect(localStorage.getItem("welfare.history")).toBeNull();
});

it("HTTP 채팅과 관리자 질의/검색도 민감 질문을 네트워크 전에 차단한다", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(createHttpApi({ baseUrl: "" }).ask("010-0000-0000", null)).rejects.toMatchObject({ code: "sensitive_input" });
  for (const path of ["/fake/query", "/fake/search"]) {
    await expect(documentRequest(path, new AbortController().signal, jsonPost({ query: "계좌번호: 321-00-000001" }))).rejects.toMatchObject({ code: "sensitive_input" });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it("정상 질문은 전송하고 응답·근거·이력 콜백에서는 원문 식별정보를 가린다", async () => {
  const answer = { kind: "answer" as const, text: "가상 991399-1234567, 2026년 129/1355 안내", services: [], suggestions: [],
    evidence: [{ chunk_id: "chunk", document_id: "doc", quote: "991399-1234567", context: "계좌번호: 321-00-000001", pages: [1], source_blocks: ["b1"], source_url: "https://example.invalid" }] };
  const ask = vi.fn().mockResolvedValue(answer), onAnswered = vi.fn();
  render(<ChatPanel api={{ ask, initialSuggestions: () => [] }} profile={null} onAnswered={onAnswered} />);
  submit("2026년 129 기준, 14일 3권은?");
  const log = screen.getByRole("log");
  await within(log).findByText(/가상 \[개인정보 가림\]/);
  expect(log).not.toHaveTextContent("991399-1234567");
  expect(log).not.toHaveTextContent("321-00-000001");
  expect(within(log).getByText(/원문 그대로의 인용이 아닙니다/)).toBeInTheDocument();
  expect(JSON.stringify(onAnswered.mock.calls)).not.toContain("991399-1234567");
  expect(answer.evidence[0].quote).toBe("991399-1234567");
  expect(ask).toHaveBeenCalledOnce();
});

it("관리자 상담 이력은 메모리에만 남긴다", async () => {
  const api = { ...createMockApi({ latencyMs: 0 }), ask: vi.fn().mockResolvedValue({ kind: "answer", text: "문서 답변", services: [], suggestions: [] }) };
  render(<MemoryRouter><UserPage api={api} privateSession /></MemoryRouter>);
  submit("정상 질문");
  await within(screen.getByRole("log")).findByText("문서 답변");
  expect(localStorage.getItem("welfare.history")).toBeNull();
});

it.each([
  [new ApiError("가상 내부 원문", 422, "sensitive_input"), SENSITIVE_INPUT_MESSAGE],
  [new ApiError("가상 내부 원문", 401, "session_expired"), "관리자 세션이 없거나 만료됐습니다. 다시 로그인해 주세요."],
  [new ApiError("가상 내부 원문", 503, "document_generation_failed"), "문서 검색이나 답변 처리에 실패했습니다. 잠시 후 다시 질문해 주세요."],
  [new Error("Vite private stack"), "서버에 연결하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요."],
])("사용자 오류는 원문 대신 원인별 문구를 표시한다", (error, message) => {
  expect(chatError(error)).toBe(message);
  expect(chatError(error)).not.toMatch(/가상 내부 원문|Vite|백엔드|129/);
});
