import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { createMockApi } from "../api/mockApi";
import type { DocumentStatus, Job } from "../api/documentApi";

const id = "00000000-0000-0000-0000-000000000001";
const jobId = "00000000-0000-0000-0000-000000000002";
const json = (body: unknown) => ({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => body });
const makeJob = (state = "parsing"): Job => ({
  job_id: jobId, state, error_code: null, processing_mode: "automatic",
  created_at: "2026-10-28T01:23:36Z", progress: { stored: state === "succeeded" ? 4 : 0 },
});
const makeDoc = (job: Job): DocumentStatus => ({
  document_id: id, name: "등록 문서", service_id: "WLF_SAMPLE", source_url: "https://example.invalid",
  source_organization: "입력한 기관", basis_year: null, source_updated_at: null, test_only: false,
  active_job_id: job.state === "succeeded" ? jobId : null, jobs: [job],
});
function mount(path = "/admin/documents") {
  return render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter>);
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("검토 승인 없이 업로드하고 게시된 원문을 검색·질의한다", async () => {
  vi.stubEnv("DEV", true);
  let state = "parsing";
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/processing")) return json({ ready: true, mode: "automatic" });
    if (url.includes("/programs?")) return json({ items: [{ service_id: "WLF_SAMPLE", program_name: "일반 제도", test_only: false }], next_offset: null });
    if (url.endsWith("/documents") && options.method === "POST") {
      expect(JSON.parse(String((options.body as FormData).get("metadata")))).toMatchObject({ test_only: false, basis_year: null, source_updated_at: null });
      return json({ document_id: id, job_id: jobId });
    }
    if (url.includes("/jobs/")) return json(makeJob(state));
    if (url.endsWith("/search")) return json({ chunks: [{ chunk_id: "c1", text: "신청은 안내 창구에서 합니다.", section: "content", similarity: 0.83, pages: [1], source_blocks: ["b1"], start: 0, end: 17 }] });
    if (url.endsWith("/query")) return json({ response: { kind: "fallback", text: "원문에서 확인할 수 없습니다.", reason: "insufficient_evidence" }, diagnostics: {} });
    return json(makeDoc(makeJob(state)));
  });
  vi.stubGlobal("fetch", fetch);
  mount();
  await screen.findByRole("option", { name: /일반 제도/ });
  fireEvent.change(screen.getByLabelText("연결할 제도"), { target: { value: "WLF_SAMPLE" } });
  for (const [label, value] of [["문서명", "등록 문서"], ["공개 원문 URL (HTTPS)", "https://example.invalid"], ["발행 기관", "입력한 기관"]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.change(screen.getByLabelText(/원문 파일/), { target: { files: [new File(["%PDF-"], "source.pdf")] } });
  fireEvent.submit(screen.getByRole("button", { name: "업로드·자동 처리" }).closest("form")!);
  await screen.findByText("모델 준비·원문 분석 중");
  expect(screen.getByRole("button", { name: "실행" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /검토 승인/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/검토 메모/)).not.toBeInTheDocument();
  expect(screen.getByText("자동 처리 · 사람 검토 아님")).toBeInTheDocument();
  state = "succeeded";
  fireEvent.click(screen.getByRole("button", { name: "상태 새로 확인" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "실행" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("질문"), { target: { value: "신청 방법은?" } });
  fireEvent.click(screen.getByRole("button", { name: "실행" }));
  await screen.findByText("신청은 안내 창구에서 합니다.");
  fireEvent.change(screen.getByLabelText("확인 방식"), { target: { value: "query" } });
  fireEvent.click(screen.getByRole("button", { name: "실행" }));
  await screen.findByText("원문에서 확인할 수 없습니다.");
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/index"))).toBe(false);
  expect(screen.getByRole("link", { name: "일반 상담으로 이동" })).toHaveAttribute("href", "/?source=documents");
});

it("DB 자동 처리 설정이 없으면 새 업로드를 막고 적용 안내를 보여준다", async () => {
  vi.stubEnv("DEV", true);
  const fetch = vi.fn(async (url: string) => url.endsWith("/processing")
    ? json({ ready: false }) : json({ items: [{ service_id: "WLF_SAMPLE", program_name: "일반 제도", test_only: false }], next_offset: null }));
  vi.stubGlobal("fetch", fetch); mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("0005");
  expect(screen.getByRole("button", { name: "업로드·자동 처리" })).toBeDisabled();
  fireEvent.submit(screen.getByRole("button", { name: "업로드·자동 처리" }).closest("form")!);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/documents"))).toBe(false);
});

it.each(["awaiting_review", "failed"])("기존 %s 문서는 몰래 재처리하지 않고 같은 ID 재첨부를 제공한다", async state => {
  vi.stubEnv("DEV", true);
  const job = { ...makeJob(state), processing_mode: "manual" as const, error_code: state === "failed" ? "ModuleNotFoundError" : null, finished_at: state === "failed" ? "2026-10-28T01:25:28Z" : null };
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/processing")) return json({ ready: true });
    if (url.includes("/programs?")) return json({ items: [], next_offset: null });
    if (url.includes("/jobs/")) return json(job);
    return json(makeDoc(job));
  });
  vi.stubGlobal("fetch", fetch); mount("/admin/documents?document=" + id + "&job=" + jobId);
  await screen.findByRole("button", { name: "같은 문서에 원문 다시 올리기" });
  if (state === "failed") {
    expect(screen.getByText("처리 실패 · 작업 종료")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("의존성이 누락");
    expect(screen.getByText("1분 52초")).toBeInTheDocument();
  } else expect(screen.getByText("이전 검토 방식의 대기 작업")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "실행" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "같은 문서에 원문 다시 올리기" }));
  expect(screen.getByLabelText("교체할 문서 ID (신규 등록은 비움)")).toHaveValue(id);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/retry") || url.endsWith("/index"))).toBe(false);
});

it("일시 조회 실패는 마지막 상태를 보존하고 재조회로 회복한다", async () => {
  vi.stubEnv("DEV", true); vi.useFakeTimers();
  let fail = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/processing")) return json({ ready: true });
    if (url.includes("/programs?")) return json({ items: [], next_offset: null });
    if (fail) throw new TypeError("network");
    if (url.includes("/jobs/")) return json(makeJob("queued"));
    return json(makeDoc(makeJob("queued")));
  }));
  await act(async () => { mount("/admin/documents?document=" + id); });
  expect(screen.getByText("접수 완료 · 작업 대기")).toBeInTheDocument();
  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("상태 갱신 지연 · 마지막 확인 정보")).toBeInTheDocument();
  expect(screen.getByText("등록 문서")).toBeInTheDocument();
  fail = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("접수 완료 · 작업 대기")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("문서에서 이동한 일반 상담은 목업 설정과 무관하게 실제 API를 사용한다", async () => {
  vi.stubEnv("VITE_USE_MOCK", "true");
  const mock = createMockApi({ latencyMs: 0 }); const ask = vi.spyOn(mock, "ask");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ kind: "fallback", text: "실제 상담 응답", contacts: [], suggestions: [] }) });
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter initialEntries={["/?source=documents"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App api={mock} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "나중에 입력할게요" }));
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target: { value: "제도 지원 내용" } });
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
  await within(screen.getByRole("log", { name: "상담 내용" })).findByText("실제 상담 응답");
  expect(fetch).toHaveBeenCalledWith("/api/v1/chat", expect.objectContaining({ method: "POST" }));
  expect(ask).not.toHaveBeenCalled();
});

it("공개 모드에서는 문서 API를 호출하지 않는다", async () => {
  vi.stubEnv("DEV", false); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await act(async () => { mount(); });
  expect(screen.getByRole("alert")).toHaveTextContent("로컬 개발 서버");
  expect(fetch).not.toHaveBeenCalled();
});
