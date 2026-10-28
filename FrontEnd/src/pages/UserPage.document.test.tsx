import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { App } from "../App";
import { createMockApi } from "../api/mockApi";
import type { DocumentStatus } from "../api/documentApi";
import { STORAGE_KEYS } from "../lib/storage";

const first = "00000000-0000-0000-0000-000000000011";
const second = "00000000-0000-0000-0000-000000000012";
const json = (body: unknown) => ({ ok: true, headers: new Headers({ "content-type":"application/json" }), json: async () => body });
const document = (id: string): DocumentStatus => ({
  document_id:id, name:id === first ? "선택한 PDF" : "다른 PDF", service_id:"TEST_SCOPE", source_url:"https://example.invalid",
  source_organization:"기관", basis_year:null, source_updated_at:null, test_only:true,
  active_job_id:"published", jobs:[{ job_id:"published", state:"succeeded", error_code:null }],
});

function Navigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/?document=${second}`)}>다른 문서 선택</button>;
}

function mount(path = `/?document=${first}`) {
  const mock = createMockApi({ latencyMs:0 });
  const ask = vi.spyOn(mock, "ask");
  const view = render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition:true, v7_relativeSplatPath:true }}><Navigation /><App api={mock} /></MemoryRouter>);
  return { ...view, ask };
}

beforeEach(() => vi.stubEnv("DEV", true));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("기존 채팅에서 선택 PDF만 질문하고 복지 조건·추천·일반 이력을 섞지 않는다", async () => {
  const oldHistory = [{ id:"old", at:"2026-10-28T00:00:00Z", question:"기존 복지 질문", summary:"기존 복지 안내", answerText:"기존 복지 답변", fallback:false }];
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(oldHistory));
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    if (!url.endsWith("/query")) return json(document(first));
    return JSON.parse(String(options.body)).query === "문서의 내용은?"
      ? json({ scope_document_id:first, response:{ kind:"answer", text:"모델의 문서 답변입니다.", evidence:[{
        chunk_id:"chunk", role:"retrieved", document_id:first, quote:"", context:"기준은 A입니다. 예외는 B이며 <script>실행하지 않음</script>.", pages:[2], source_blocks:["b1"], source_url:"https://example.invalid",
      }, {
        chunk_id:"required", role:"required_context", required_by:["chunk"], document_id:first,
        quote:"", context:"필수 조건은 C이고 제외 대상은 D입니다.", pages:[3], source_blocks:["condition"], source_url:"https://example.invalid/required",
      }] } })
      : json({ scope_document_id:first, response:{ kind:"fallback", text:"PDF에 해당 내용은 없습니다.", contacts:[{ label:"상담센터", phone:"129" }], suggestions:["복지 추천 질문"] } });
  });
  vi.stubGlobal("fetch", fetch);
  const { ask } = mount();
  await screen.findByRole("heading", { name:"선택한 PDF 문서 질문" });
  expect(screen.queryByLabelText("나이")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name:"내 조건" })).not.toBeInTheDocument();
  expect(screen.queryByText("기존 복지 질문")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target:{ value:"문서의 내용은?" } });
  fireEvent.click(screen.getByRole("button", { name:"질문 보내기" }));
  const log = screen.getByRole("log", { name:"문서 대화" });
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
  expect(fetch).toHaveBeenCalledWith(`/api/v1/admin/documents/${first}/query`, expect.objectContaining({ method:"POST", body:JSON.stringify({ query:"문서의 내용은?" }) }));
  expect(ask).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(oldHistory);
  expect(screen.getByRole("link", { name:"일반 복지 상담으로 돌아가기" })).toHaveAttribute("href", "/");
});

it("선택 문서 변경 시 요청을 취소하고 이전 답변과 대화 기록을 버린다", async () => {
  let resolveOld: ((value: unknown) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith(`/${first}/query`)) {
      oldSignal = options.signal as AbortSignal;
      return new Promise(resolve => { resolveOld = resolve; });
    }
    return json(document(url.includes(second) ? second : first));
  }));
  mount();
  await screen.findByRole("heading", { name:"선택한 PDF 문서 질문" });
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target:{ value:"첫 문서 질문" } });
  fireEvent.click(screen.getByRole("button", { name:"질문 보내기" }));
  fireEvent.click(screen.getByRole("button", { name:"다른 문서 선택" }));
  await screen.findByRole("heading", { name:"다른 PDF 문서 질문" });
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { resolveOld!(json({ scope_document_id:first, response:{ kind:"answer", text:"이전 문서의 늦은 답변" } })); });
  expect(screen.queryByText("첫 문서 질문")).not.toBeInTheDocument();
  expect(screen.queryByText("이전 문서의 늦은 답변")).not.toBeInTheDocument();
});

it("권한 오류를 문서 안내로 표시하고 일반 상담이나 모델 요청으로 우회하지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok:false, status:403, json:async () => ({ detail:"private secret" }) });
  vi.stubGlobal("fetch", fetch);
  const { ask } = mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("접근이 거부");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private secret");
  expect(screen.queryByRole("button", { name:"질문 보내기" })).not.toBeInTheDocument();
  expect(ask).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([[false, first], [true, "invalid-document"]])("개발 접근=%s, 문서=%s에서 부적절한 요청을 차단한다", async (dev, id) => {
  vi.stubEnv("DEV", dev);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await act(async () => { mount(`/?document=${id}`); });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
