import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebChatPage } from "./WebChatPage";

const BASE = "https://api.example.test";

type Reply = { status: number; body?: unknown } | (() => Promise<Response>);

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function installFetch(chat: Reply[], capability: Reply | Reply[] = { status: 200, body: { referral_records_enabled: false } }) {
  const queue = Array.isArray(capability) ? [...capability] : [];
  const fallback = Array.isArray(capability) ? capability[capability.length - 1] : capability;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = url.endsWith("/api/v1/chat/capabilities") ? queue.shift() ?? fallback : chat.shift();
    if (!reply) throw new Error(`unexpected ${url}`);
    if (typeof reply === "function") {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        reply().then(resolve, reject);
      });
    }
    return json(reply.status, reply.body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function chatCalls(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/chat"));
}

const answer = (text: string, extra: Record<string, unknown> = {}) => ({ status: 200, body: { kind: "answer", text, ...extra } });

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = screen.getByLabelText("질문");
  await user.clear(box);
  await user.type(box, text);
  await user.click(screen.getByRole("button", { name: /보내기|보내는 중/ }));
}

beforeEach(() => {
  vi.stubGlobal("speechSynthesis", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("연결 설정", () => {
  it("API 주소가 없으면 연결 설정 오류를 보이고 요청하지 않는다", () => {
    const fetchMock = installFetch([]);
    render(<WebChatPage baseUrl={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("연결 설정 오류");
    expect(screen.getByRole("button", { name: "보내기" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("질문 전송", () => {
  it("연속 질문에도 현재 질문과 기한만 보낸다", async () => {
    const fetchMock = installFetch([answer("첫 답변"), answer("둘째 답변")]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);

    await ask(user, "기초연금 신청 방법 알려줘");
    expect(await screen.findByText("첫 답변")).toBeInTheDocument();
    await ask(user, "  장애인 연금 문의처는?  ");
    expect(await screen.findByText("둘째 답변")).toBeInTheDocument();
    expect(screen.queryByText("첫 답변")).not.toBeInTheDocument();

    const calls = chatCalls(fetchMock);
    expect(calls).toHaveLength(2);
    expect(calls.map(([, init]) => JSON.parse(String(init!.body)))).toEqual([
      { query: "기초연금 신청 방법 알려줘", timeout_seconds: 600 },
      { query: "장애인 연금 문의처는?", timeout_seconds: 600 },
    ]);
    for (const [, init] of calls) {
      expect(init!.credentials).toBe("omit");
      expect(init!.headers).toEqual({ "Content-Type": "application/json" });
    }
  });

  it("빈 질문과 300자 초과는 보내지 않는다", async () => {
    const fetchMock = installFetch([]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "보내기" }));
    expect(screen.getByRole("alert")).toHaveTextContent("질문을 입력해 주세요.");

    fireEvent.change(screen.getByLabelText("질문"), { target: { value: "가".repeat(301) } });
    await user.click(screen.getByRole("button", { name: "보내기" }));
    expect(screen.getByRole("alert")).toHaveTextContent("300자 이내");
    expect(chatCalls(fetchMock)).toHaveLength(0);
  });

  it("처리 중 중복 전송을 막는다", async () => {
    const pending = deferred<Response>();
    const fetchMock = installFetch([() => pending.promise]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    await screen.findByText("답변을 준비하고 있습니다.");
    await user.click(screen.getByRole("button", { name: "보내는 중" }));
    await user.type(screen.getByLabelText("질문"), "{Enter}");
    expect(chatCalls(fetchMock)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("질문"), { target: { value: "다음 질문 초안" } });
    await act(async () => pending.resolve(json(200, { kind: "answer", text: "답" })));
    expect(await screen.findByText("답")).toBeInTheDocument();
    expect(screen.getByLabelText("질문")).toHaveValue("다음 질문 초안");
  });
});

describe("응답 표시", () => {
  it("자료 없음 안내는 오류가 아니라 안내로 보인다", async () => {
    installFetch([{ status: 200, body: { kind: "fallback", text: "관련 공식 자료를 찾지 못했습니다.", reason: "no_evidence", extra: 1 } }]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "우주 여행 지원");
    expect(await screen.findByRole("heading", { name: "안내" })).toHaveFocus();
    expect(screen.getByText("관련 공식 자료를 찾지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "문의처" })).not.toBeInTheDocument();
  });

  it("검증된 연락처만 tel 링크로 표시하고 출처·확인일은 보이지 않는다", async () => {
    installFetch([
      answer("기초연금 안내", {
        contacts: [
          { label: "국민연금공단", phone: "1355", kind: "service", source_url: "https://www.mohw.go.kr/a", checked_at: "2026-11-01", hours: "평일 9시~18시" },
          { label: "보건복지상담센터", phone: "129", kind: "general", source_url: "https://www.129.go.kr", checked_at: "2026-11-01" },
          { label: "잘못된 번호", phone: "010-1234-5678", kind: "service", source_url: "https://x.go.kr", checked_at: "2026-11-01" },
          { label: "<img src=x onerror=alert(1)>", phone: "02-123-4567", kind: "service", source_url: "https://x.go.kr", checked_at: "bad" },
        ],
      }),
    ]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금 문의처");
    await screen.findByText("기초연금 안내");
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["tel:1355", "tel:129"]);
    expect(screen.getByText("운영시간: 평일 9시~18시")).toBeInTheDocument();
    expect(screen.queryByText(/010-1234-5678/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2026-11-01/)).not.toBeInTheDocument();
    expect(screen.queryByText(/mohw\.go\.kr/)).not.toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("서버 텍스트의 HTML을 실행하지 않고 글자로 보인다", async () => {
    installFetch([answer("<b>굵게</b><img src=x>")]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "질문");
    expect(await screen.findByText("<b>굵게</b><img src=x>")).toBeInTheDocument();
    expect(document.querySelector("img, b")).toBeNull();
  });
});

describe("취소와 실패", () => {
  it("취소한 요청의 늦은 응답은 새 요청을 종료하거나 표시하지 않는다", async () => {
    const late = deferred<Response>();
    const next = deferred<Response>();
    const replies = [late, next];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/capabilities")) return json(404);
      return replies.shift()!.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    await screen.findByText("답변을 준비하고 있습니다.");
    await user.click(screen.getByRole("button", { name: "요청 취소" }));
    expect(screen.getByText(/요청을 취소했습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("질문")).toHaveValue("기초연금");
    await ask(user, "장애인 연금");
    await screen.findByText("답변을 준비하고 있습니다.");
    await act(async () => late.resolve(json(200, { kind: "answer", text: "늦은 답변" })));
    expect(screen.queryByText("늦은 답변")).not.toBeInTheDocument();
    expect(screen.getByText("답변을 준비하고 있습니다.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "보내는 중" }));
    expect(chatCalls(fetchMock)).toHaveLength(2);
    await act(async () => next.resolve(json(200, { kind: "answer", text: "현재 답변" })));
    expect(await screen.findByText("현재 답변")).toBeInTheDocument();
  });

  it.each(["check", "answer"] as const)("%s 단계에서 화면을 떠나면 진행 중인 요청을 중단한다", async (stage) => {
    const pending = deferred<Response>();
    const fetchMock = stage === "check"
      ? installFetch([], [{ status: 404 }, () => pending.promise])
      : installFetch([() => pending.promise], { status: 404 });
    const user = userEvent.setup();
    const { unmount } = render(<WebChatPage baseUrl={BASE} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await ask(user, "기초연금");
    await screen.findByText(stage === "check" ? "연결을 확인하고 있습니다." : "답변을 준비하고 있습니다.");
    const signal = fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1]!.signal!;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(json(200, { kind: "answer", text: "떠난 화면의 답변" })));
    expect(chatCalls(fetchMock)).toHaveLength(stage === "check" ? 0 : 1);
  });

  it.each([
    [422, { detail: [{ type: "string_too_long" }] }, "질문 형식을 확인해 주세요"],
    [422, { detail: "sensitive_input" }, "개인정보를 빼고"],
    [422, { detail: [{ type: "sensitive_input" }] }, "개인정보를 빼고"],
    [429, { detail: "too many" }, "요청이 많아"],
    [503, { detail: "x" }, "서버에서 답변을 만들지 못했습니다"],
  ])("%s 오류를 구분해 안내하고 입력을 보존한다", async (status, body, message) => {
    const fetchMock = installFetch([{ status, body }]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText("질문")).toHaveValue("기초연금");
    expect(chatCalls(fetchMock)).toHaveLength(1);
  });

  it("네트워크 오류 후 자동 재전송 없이 다시 보낼 수 있다", async () => {
    const fetchMock = installFetch([() => Promise.reject(new TypeError("Failed to fetch")), answer("재시도 답변")]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    expect(await screen.findByRole("alert")).toHaveTextContent("서버에 연결하지 못했습니다");
    expect(chatCalls(fetchMock)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "보내기" }));
    expect(await screen.findByText("재시도 답변")).toBeInTheDocument();
    expect(chatCalls(fetchMock)).toHaveLength(2);
  });

  it("600초가 지나면 시간 초과로 안내한다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch([() => new Promise<Response>(() => undefined)], { status: 404 });
    render(<WebChatPage baseUrl={BASE} />);
    fireEvent.change(screen.getByLabelText("질문"), { target: { value: "기초연금" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByText("답변을 준비하고 있습니다.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("기다리는 시간(10분)");
  });
});

describe("연락처 기록 수집 상태", () => {
  it("활성일 때만 수집 안내를 표시한다", async () => {
    installFetch([answer("답")], { status: 200, body: { referral_records_enabled: true, profile_context_supported: true } });
    render(<WebChatPage baseUrl={BASE} />);
    expect(await screen.findByText(/90일 뒤 자동 삭제/)).toBeInTheDocument();
  });

  it("404는 비활성으로 보고 질문을 보낸다", async () => {
    const fetchMock = installFetch([answer("답")], { status: 404 });
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    expect(await screen.findByText("답")).toBeInTheDocument();
    expect(screen.queryByText(/90일/)).not.toBeInTheDocument();
    expect(chatCalls(fetchMock)).toHaveLength(1);
  });

  it("전송 직전 확인이 실패하면 질문을 보내지 않는다", async () => {
    const fetchMock = installFetch([answer("답")], [{ status: 200, body: { referral_records_enabled: false } }, { status: 500 }]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    expect(await screen.findByRole("alert")).toHaveTextContent("질문을 보내지 않았습니다");
    expect(chatCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByLabelText("질문")).toHaveValue("기초연금");
  });

  it("전송 직전 설정 확인이 15초를 넘으면 질문을 보내지 않고 입력을 보존한다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = installFetch([], [{ status: 404 }, () => new Promise<Response>(() => undefined)]);
    render(<WebChatPage baseUrl={BASE} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("질문"), { target: { value: "기초연금" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByText("연결을 확인하고 있습니다.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("질문을 보내지 않았습니다");
    expect(chatCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByLabelText("질문")).toHaveValue("기초연금");
  });

  it("수집이 꺼져 있어도 연락처는 표시한다", async () => {
    installFetch([answer("답", { contacts: [{ label: "보건복지상담센터", phone: "129", kind: "general", source_url: "https://www.129.go.kr", checked_at: "2026-11-01" }] })]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    expect(await screen.findByRole("link", { name: /보건복지상담센터/ })).toHaveAttribute("href", "tel:129");
  });
});

describe("저장하지 않음", () => {
  it("상담 후 브라우저 저장소와 쿠키에 남기지 않는다", async () => {
    localStorage.clear();
    sessionStorage.clear();
    installFetch([answer("답")]);
    const user = userEvent.setup();
    const { unmount } = render(<WebChatPage baseUrl={BASE} />);
    await ask(user, "기초연금");
    await screen.findByText("답");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    unmount();
    const next = installFetch([]);
    render(<WebChatPage baseUrl={BASE} />);
    await waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("답")).not.toBeInTheDocument();
    expect(screen.getByLabelText("질문")).toHaveValue("");
  });
});
