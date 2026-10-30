import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../App";
import { createHttpApi } from "../api/httpApi";
import { SESSION_KEY } from "../auth/session";
import { STORAGE_KEYS } from "../lib/storage";

function mount() {
  return render(
    <MemoryRouter initialEntries={["/"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App api={createHttpApi({ baseUrl: "" })} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  document.documentElement.removeAttribute("data-text");
});

it("비로그인 재방문 시 조건·지난 상담 원문·글자 크기를 복원하고 메인 채팅과 근거는 복원하지 않는다", async () => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv("PROD", false);
  const profile = { age: 67, income: "under100", household: "couple", region: "부산광역시", disability: true };
  const question = "가상 문서의 지원 대상은 누구인가요?";
  const answerText = "로컬 복원 검증용 가상 답변입니다. 실제 복지 정보가 아닙니다.";
  const context = "이 원문은 근거 저장 여부를 구분하는 가상 자료입니다.";
  const answer = {
    kind: "answer", text: answerText, services: [], suggestions: [],
    evidence: [{
      chunk_id: "local-chunk", document_id: "00000000-0000-0000-0000-000000000001",
      role: "retrieved", quote: "", context, pages: [7], source_blocks: ["local-block"],
      source_url: "https://evidence.invalid/local-only",
    }],
  };
  // 실제 fetch를 호출하지 않으며 예상하지 않은 경로도 메모리 대역에서 차단한다.
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input !== "/api/v1/chat" || init?.method !== "POST") throw new Error("예상하지 않은 요청입니다.");
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const blockedNetwork = vi.fn(() => { throw new Error("실제 네트워크 연결은 금지됩니다."); });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("XMLHttpRequest", blockedNetwork);
  vi.stubGlobal("WebSocket", blockedNetwork);
  vi.stubGlobal("EventSource", blockedNetwork);

  const user = userEvent.setup();
  const firstVisit = mount();
  await user.click(await screen.findByRole("button", { name: "내 조건" }));
  await user.type(screen.getByLabelText("나이"), String(profile.age));
  await user.selectOptions(screen.getByLabelText("소득 구간"), profile.income);
  await user.selectOptions(screen.getByLabelText("가구 형태"), profile.household);
  await user.selectOptions(screen.getByLabelText("사는 곳"), profile.region);
  await user.click(screen.getByRole("radio", { name: "예" }));
  await user.click(screen.getByRole("button", { name: "이 조건으로 시작하기" }));
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.profile)!)).toEqual(profile);
  await user.click(screen.getByRole("button", { name: "글자 크게" }));
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.largeText)!)).toBe(true);

  await user.type(screen.getByLabelText("궁금한 내용"), question);
  await user.click(screen.getByRole("button", { name: "질문 보내기" }));
  const firstLog = screen.getByRole("log", { name: "상담 내용" });
  expect(await within(firstLog).findByText(answerText)).toBeInTheDocument();
  await user.click(within(firstLog).getByText("원문 근거 보기 (1건)"));
  expect(within(firstLog).getByText(context)).toBeVisible();
  expect(within(firstLog).getByText("쪽: 7 · 원문 블록: local-block")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("/api/v1/chat");
  expect(JSON.parse(String(options?.body))).toEqual({ query: question });
  expect(new Headers(options?.headers).has("Authorization")).toBe(false);

  const savedHistory = JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!);
  expect(savedHistory).toEqual([{
    id: expect.any(String), at: expect.any(String), question, summary: "등록 문서 답변", answerText, fallback: false,
  }]);
  expect(Number.isNaN(Date.parse(savedHistory[0].at))).toBe(false);
  expect(savedHistory[0]).not.toHaveProperty("evidence");
  expect(JSON.stringify(savedHistory)).not.toContain(context);
  expect(Object.keys(localStorage).sort()).toEqual([
    STORAGE_KEYS.profile, STORAGE_KEYS.history, STORAGE_KEYS.largeText,
  ].sort());
  expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  expect(screen.queryByRole("button", { name: "로그아웃" })).not.toBeInTheDocument();

  // 저장소는 유지하고 React 상태와 DOM 표시값만 초기화해 재방문을 재현한다.
  firstVisit.unmount();
  document.documentElement.dataset.text = "normal";
  mount();
  expect(await screen.findByText(/67세 · 부부 · 부산광역시 · 장애 있음/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "글자 보통" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.dataset.text).toBe("large");
  await user.click(screen.getByRole("button", { name: "내 조건" }));
  expect(screen.getByLabelText("나이")).toHaveValue(profile.age);
  expect(screen.getByLabelText("소득 구간")).toHaveValue(profile.income);
  expect(screen.getByLabelText("가구 형태")).toHaveValue(profile.household);
  expect(screen.getByLabelText("사는 곳")).toHaveValue(profile.region);
  expect(screen.getByRole("radio", { name: "예" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "취소" }));

  const restoredLog = screen.getByRole("log", { name: "상담 내용" });
  expect(within(restoredLog).getByText("등록한 문서에 대해 궁금한 내용을 질문해 주세요.")).toBeInTheDocument();
  expect(within(restoredLog).queryByText(question)).not.toBeInTheDocument();
  expect(within(restoredLog).queryByText(answerText)).not.toBeInTheDocument();
  expect(within(restoredLog).queryByText(/원문 근거 보기/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "지난 상담" }));
  const history = screen.getByRole("complementary", { name: "지난 상담" });
  expect(within(history).getByText(question)).toBeInTheDocument();
  expect(within(history).getByText("등록 문서 답변")).toBeInTheDocument();
  await user.click(within(history).getByText("원문 펼쳐보기"));
  expect(within(history).getByText(answerText)).toBeVisible();
  expect(within(history).queryByText(context)).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(savedHistory);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.profile)!)).toEqual(profile);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.largeText)!)).toBe(true);
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByRole("button", { name: "로그아웃" })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(blockedNetwork).not.toHaveBeenCalled();
}, 15000);
