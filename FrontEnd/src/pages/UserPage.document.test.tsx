import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { STORAGE_KEYS } from "../lib/storage";

const first = "00000000-0000-0000-0000-000000000011";
const json = (body: unknown) => ({ ok: true, headers: new Headers({ "content-type":"application/json" }), json: async () => body });
function mount(path = "/") {
  return render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition:true, v7_relativeSplatPath:true }}><App /></MemoryRouter>);
}

beforeEach(() => vi.stubEnv("DEV", true));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("기본 채팅에서 조건 입력 없이 문서를 질문하고 검색 원문·페이지와 기존 이력을 표시한다", async () => {
  const oldHistory = [{ id:"old", at:"2026-10-28T00:00:00Z", question:"기존 복지 질문", summary:"기존 복지 안내", answerText:"기존 복지 답변", fallback:false }];
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(oldHistory));
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe("/api/v1/chat");
    return JSON.parse(String(options.body)).query === "문서의 내용은?"
      ? json({ kind:"answer", text:"모델의 문서 답변입니다.", services:[], suggestions:[], evidence:[{
        chunk_id:"chunk", role:"retrieved", document_id:first, quote:"", context:"기준은 A입니다. 예외는 B이며 <script>실행하지 않음</script>.", pages:[2], source_blocks:["b1"], source_url:"https://example.invalid",
      }, {
        chunk_id:"required", role:"required_context", required_by:["chunk"], document_id:first,
        quote:"", context:"필수 조건은 C이고 제외 대상은 D입니다.", pages:[3], source_blocks:["condition"], source_url:"https://example.invalid/required",
      }] })
      : json({ kind:"fallback", text:"PDF에 해당 내용은 없습니다.", contacts:[], suggestions:[] });
  });
  vi.stubGlobal("fetch", fetch);
  mount();
  expect(screen.getByText("등록된 문서의 원문을 검색해 답변합니다.")).toBeInTheDocument();
  expect(screen.queryByLabelText("나이")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name:"내 조건" })).toBeInTheDocument();
  expect(screen.getByText("기존 복지 질문")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target:{ value:"문서의 내용은?" } });
  fireEvent.click(screen.getByRole("button", { name:"질문 보내기" }));
  const log = screen.getByRole("log", { name:"상담 내용" });
  await within(log).findByText("모델의 문서 답변입니다.");
  fireEvent.click(within(log).getByText("원문 근거 보기 (2건)"));
  expect(within(log).getByText(/예외는 B이며 <script>/)).toBeInTheDocument();
  expect(window.document.querySelector("script")).toBeNull();
  expect(within(log).getByText(/쪽: 2 · 원문 블록: b1/)).toBeInTheDocument();
  expect(within(log).getByText("검색 원문")).toBeInTheDocument();
  expect(within(log).getByText(/정확한 인용으로 검증한 내용은 아닙니다/)).toBeInTheDocument();
  expect(within(log).getByText("필수 원문 맥락")).toBeInTheDocument();
  expect(within(log).getByText("필수 조건은 C이고 제외 대상은 D입니다.")).toBeInTheDocument();
  expect(within(log).getByText(/쪽: 3 · 원문 블록: condition/)).toBeInTheDocument();
  expect(within(log).getByText("출처: https://example.invalid/required")).toBeInTheDocument();
  expect(log.querySelectorAll("blockquote")).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target:{ value:"없는 내용은?" } });
  fireEvent.click(screen.getByRole("button", { name:"질문 보내기" }));
  await within(log).findByText("PDF에 해당 내용은 없습니다.");
  expect(within(log).getByText("문서에서 확인하지 못했어요")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name:"복지 추천 질문" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name:/129/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name:"상담원 연결 요청" })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith("/api/v1/chat", expect.objectContaining({ method:"POST", body:JSON.stringify({ query:"문서의 내용은?" }) }));
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(expect.arrayContaining(oldHistory));
  expect(screen.getByText("등록 문서 답변")).toBeInTheDocument();
});

it("기본 채팅을 벗어나면 요청을 취소하고 늦게 도착한 답변을 새 채팅에 표시하지 않는다", async () => {
  let resolveOld: ((value: unknown) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    if (url === "/api/v1/chat") {
      oldSignal = options.signal as AbortSignal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    throw new Error("예상하지 않은 API 경로");
  }));
  const view = mount();
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target:{ value:"첫 문서 질문" } });
  fireEvent.click(screen.getByRole("button", { name:"질문 보내기" }));
  view.unmount();
  mount();
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { resolveOld!(json({ kind:"answer", text:"이전 문서의 늦은 답변", services:[], suggestions:[] })); });
  expect(screen.queryByText("첫 문서 질문")).not.toBeInTheDocument();
  expect(screen.queryByText("이전 문서의 늦은 답변")).not.toBeInTheDocument();
});

it("기본 채팅의 권한 오류에서 서버 비밀 문구를 노출하거나 다른 API로 우회하지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok:false, status:403, json:async () => ({ detail:"private secret" }) });
  vi.stubGlobal("fetch", fetch);
  mount();
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target:{ value:"문서 질문" } });
  fireEvent.click(screen.getByRole("button", { name:"질문 보내기" }));
  const log = screen.getByRole("log", { name:"상담 내용" });
  expect(await within(log).findByText(/서버에 연결하지 못했습니다/)).toBeInTheDocument();
  expect(log).not.toHaveTextContent("private secret");
  expect(fetch).toHaveBeenCalledWith("/api/v1/chat", expect.objectContaining({ method:"POST" }));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([[false, first], [true, "invalid-document"]])("개발 접근=%s, 이전 문서 인자=%s와 무관하게 기본 채팅을 표시한다", async (dev, id) => {
  vi.stubEnv("DEV", dev);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await act(async () => { mount(`/?document=${id}`); });
  expect(screen.getByRole("log", { name:"상담 내용" })).toBeInTheDocument();
  expect(screen.getByLabelText("궁금한 내용")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
