import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatPage } from "./WebChatPage";

const BASE = "https://api.example.test";

function json(status: number, body?: unknown) {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = true;
  interimResults = true;
  maxAlternatives = 0;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
  say(text: string) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] });
  }
}

class FakeUtterance {
  voice: unknown = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

function installSynth(voices: Partial<SpeechSynthesisVoice>[]) {
  const synth = {
    getVoices: vi.fn(() => voices),
    speak: vi.fn(),
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return synth;
}

function installFetch(bodies: unknown[]) {
  const fetchMock = vi.fn(async (url: string) => (url.endsWith("/capabilities") ? json(404) : json(200, bodies.shift())));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.last = null;
});

describe("음성 입력", () => {
  it("미지원 브라우저에서는 안내하고 직접 입력을 유지한다", async () => {
    installFetch([]);
    render(<WebChatPage baseUrl={BASE} />);
    expect(screen.getByRole("button", { name: "음성 입력" })).toBeDisabled();
    expect(screen.getByText(/음성 입력을 지원하지 않습니다/)).toBeInTheDocument();
    await userEvent.setup().type(screen.getByLabelText("질문"), "직접 입력");
    expect(screen.getByLabelText("질문")).toHaveValue("직접 입력");
  });

  it("인식 결과를 기존 내용 뒤에 붙이고 자동 전송하지 않는다", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const fetchMock = installFetch([]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await user.type(screen.getByLabelText("질문"), "서울 거주 70세");
    await user.click(screen.getByRole("button", { name: "음성 입력" }));
    const recognition = FakeRecognition.last!;
    expect(recognition.lang).toBe("ko-KR");
    expect(screen.getByText(/외부 음성 인식 서비스로 전송될 수 있습니다/)).toBeInTheDocument();
    act(() => recognition.say("기초연금 신청 방법"));
    await user.click(screen.getByRole("button", { name: "말하기 끝" }));
    expect(screen.getByLabelText("질문")).toHaveValue("서울 거주 70세 기초연금 신청 방법");
    expect(screen.getByText(/확인·수정한 뒤 직접 보내 주세요/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => /\/api\/v1\/chat(\/stream)?$/.test(String(url)))).toHaveLength(0);
  });

  it("취소하면 결과를 넣지 않고 권한 거부는 안내한다", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    installFetch([]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await user.click(screen.getByRole("button", { name: "음성 입력" }));
    const first = FakeRecognition.last!;
    await user.click(screen.getByRole("button", { name: "음성 취소" }));
    expect(first.abort).toHaveBeenCalled();
    act(() => first.say("늦은 결과"));
    expect(screen.getByLabelText("질문")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "음성 입력" }));
    act(() => FakeRecognition.last!.onerror?.({ error: "not-allowed" }));
    expect(screen.getByText(/마이크 사용이 허용되지 않았습니다/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("질문"), "직접");
    expect(screen.getByLabelText("질문")).toHaveValue("직접");
  });

  it("30초가 지나면 듣기를 마친다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    installFetch([]);
    render(<WebChatPage baseUrl={BASE} />);
    act(() => screen.getByRole("button", { name: "음성 입력" }).click());
    const recognition = FakeRecognition.last!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(recognition.stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "음성 입력" })).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("답변 읽기", () => {
  const body = {
    kind: "answer",
    text: "기초연금은 주민센터에서 신청합니다.",
    contacts: [{ label: "보건복지상담센터", phone: "129", kind: "general", source_url: "https://www.129.go.kr", checked_at: "2026-11-01" }],
  };

  it("기기 내 한국어 음성으로 답변과 연락처를 읽고 정지한다", async () => {
    const synth = installSynth([
      { lang: "ko-KR", localService: false, name: "원격" } as SpeechSynthesisVoice,
      { lang: "ko-KR", localService: true, name: "기기" } as SpeechSynthesisVoice,
    ]);
    installFetch([body, body]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await user.type(screen.getByLabelText("질문"), "기초연금");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await user.click(await screen.findByRole("button", { name: "답변 읽기" }));
    const spoken = synth.speak.mock.calls.map(([utterance]) => utterance as FakeUtterance);
    expect(spoken.every((utterance) => (utterance.voice as SpeechSynthesisVoice).name === "기기")).toBe(true);
    expect(spoken.map((utterance) => utterance.text).join(" ")).toContain("보건복지상담센터");
    expect(spoken.map((utterance) => utterance.text).join(" ")).toContain("1 2 9");
    const cancels = synth.cancel.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "읽기 정지" }));
    expect(synth.cancel.mock.calls.length).toBeGreaterThan(cancels);

    await user.click(screen.getByRole("button", { name: "답변 읽기" }));
    const beforeSubmit = synth.cancel.mock.calls.length;
    await user.type(screen.getByLabelText("질문"), "다음 질문");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    expect(synth.cancel.mock.calls.length).toBeGreaterThan(beforeSubmit);
  });

  it("기기 내 한국어 음성이 없으면 사유를 표시한다", async () => {
    const synth = installSynth([{ lang: "en-US", localService: true } as SpeechSynthesisVoice, { lang: "ko-KR", localService: false } as SpeechSynthesisVoice]);
    installFetch([body]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await user.type(screen.getByLabelText("질문"), "기초연금");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await user.click(await screen.findByRole("button", { name: "답변 읽기" }));
    expect(await screen.findByText(/한국어 음성이 없어 읽을 수 없습니다/)).toBeInTheDocument();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("speechSynthesis 미지원이면 사유를 표시한다", async () => {
    vi.stubGlobal("speechSynthesis", undefined);
    installFetch([body]);
    const user = userEvent.setup();
    render(<WebChatPage baseUrl={BASE} />);
    await user.type(screen.getByLabelText("질문"), "기초연금");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await user.click(await screen.findByRole("button", { name: "답변 읽기" }));
    expect(screen.getByText(/답변 읽기를 지원하지 않습니다/)).toBeInTheDocument();
  });
});
