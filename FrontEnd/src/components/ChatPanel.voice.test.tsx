import { act, screen } from "@testing-library/react";
import { renderApp } from "../test/renderApp";

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {}
  abort() {
    this.onend?.();
  }
  say(text: string) {
    this.onresult?.({ results: [[{ transcript: text }]] });
    this.onend?.();
  }
  fail() {
    this.onerror?.();
    this.onend?.();
  }
}

describe("음성 입력 (FR-2)", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
  });

  afterEach(() => {
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  });

  async function openChat() {
    const ctx = renderApp();
    await ctx.user.click(screen.getByRole("button", { name: "나중에 입력할게요" }));
    return ctx;
  }

  it("말한 내용이 입력창에 채워진다", async () => {
    const { user } = await openChat();
    await user.click(screen.getByRole("button", { name: "말로 질문하기" }));
    act(() => FakeRecognition.instances[0].say("병원비가 걱정돼요"));
    expect(screen.getByLabelText("궁금한 내용")).toHaveValue("병원비가 걱정돼요");
    expect(FakeRecognition.instances[0].lang).toBe("ko-KR");
  });

  it("두 번 실패하면 버튼으로 고르도록 안내한다", async () => {
    const { user } = await openChat();
    for (let i = 0; i < 2; i += 1) {
      await user.click(screen.getByRole("button", { name: "말로 질문하기" }));
      act(() => FakeRecognition.instances[i].fail());
    }
    expect(screen.getByText(/아래 버튼을 눌러 질문을 골라 보세요/)).toBeInTheDocument();
  });

  it("음성 인식을 지원하지 않는 브라우저에서는 마이크 버튼을 숨긴다", async () => {
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    await openChat();
    expect(screen.queryByRole("button", { name: "말로 질문하기" })).not.toBeInTheDocument();
  });
});
