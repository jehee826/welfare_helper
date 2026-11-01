import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel";
import type { DocumentChatAnswer } from "../api/types";
import { ApiError, chatError } from "../api/errors";
import { DocumentApiError } from "../api/documentApi";

function deferred() {
  let resolve!: (answer: DocumentChatAnswer) => void, reject!: (error: Error) => void;
  const promise = new Promise<DocumentChatAnswer>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const answer = (text: string): DocumentChatAnswer => ({ kind: "answer", text, services: [], suggestions: [] });
function send(text: string) {
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["answer", "error"])("취소 후 늦은 %s가 새 요청·상담 이력·타이머를 덮지 않는다", async late => {
  vi.useFakeTimers();
  const first = deferred(), second = deferred(), onAnswered = vi.fn();
  const ask = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  render(<ChatPanel api={{ ask, initialSuggestions: () => [] }} profile={null} onAnswered={onAnswered} />);
  send("첫 질문");
  const signal = ask.mock.calls[0][2] as AbortSignal;
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("timer")).toHaveTextContent("2초 경과");
  fireEvent.click(screen.getByRole("button", { name: "답변 요청 취소" }));
  expect(signal.aborted).toBe(true);
  expect(screen.getByText("요청을 취소했습니다. 다시 질문할 수 있습니다.")).toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
  send("새 질문");
  await act(async () => {
    if (late === "answer") first.resolve(answer("늦은 예전 답변"));
    else first.reject(new Error("가상 예전 내부 예외"));
  });
  expect(screen.queryByText("늦은 예전 답변")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "답변 요청 취소" })).toBeInTheDocument();
  expect(onAnswered).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole("timer")).toHaveTextContent("1초 경과");
  await act(async () => { second.resolve(answer("새 문서 답변")); });
  expect(screen.getByText("새 문서 답변")).toBeInTheDocument();
  expect(onAnswered).toHaveBeenCalledTimes(1);
  expect(onAnswered).toHaveBeenCalledWith("새 질문", answer("새 문서 답변"));
  expect(vi.getTimerCount()).toBe(0);
  expect(ask).toHaveBeenCalledTimes(2);
});

it("unmount는 요청과 경과 타이머를 정리하고 늦은 답변을 저장하지 않는다", async () => {
  vi.useFakeTimers();
  const pending = deferred(), onAnswered = vi.fn(), ask = vi.fn((_query: string, _profile: unknown, _signal?: AbortSignal) => pending.promise);
  const view = render(<ChatPanel api={{ ask, initialSuggestions: () => [] }} profile={null} onAnswered={onAnswered} />);
  send("문서 질문");
  const signal = ask.mock.calls[0][2] as AbortSignal;
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { pending.resolve(answer("이전 화면 답변")); });
  expect(onAnswered).not.toHaveBeenCalled();
});

it.each([[429, "다른 요청을 처리 중"], [504, "요청 처리 시간을 넘었습니다"], [499, "요청이 취소되었습니다"]])("상태 %s를 사용자·관리자 문서 오류에서 구분한다", (status, message) => {
  expect(chatError(new ApiError("가상 내부 비밀", status, "private_code"))).toContain(message);
  expect(new DocumentApiError(status, "private_code").message).toContain(message);
  expect(chatError(new ApiError("가상 내부 비밀", status))).not.toContain("가상 내부 비밀");
});
