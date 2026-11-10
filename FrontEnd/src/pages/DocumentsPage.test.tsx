import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import type { DocumentStatus, Job } from "../api/documentApi";
import { ApiError } from "../api/errors";

const { checkAdminAccess } = vi.hoisted(() => ({ checkAdminAccess: vi.fn() }));
vi.mock("../api/auth", async original => ({ ...await original<typeof import("../api/auth")>(), checkAdminAccess }));
beforeEach(() => checkAdminAccess.mockResolvedValue({ is_admin: true, access_mode: "shared_password" }));

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
  expect(screen.queryByRole("link", { name: "기본 채팅으로 이동" })).not.toBeInTheDocument();
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

it.each([false, true])("검색 결과의 가림 표시=%s와 원문 위치·참조를 함께 보존한다", async redacted => {
  const chunkId = "chunk-9913991234567", blockId = "block-9913991234567";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/processing")) return json({ ready: true });
    if (url.includes("/programs?")) return json({ items: [], next_offset: null });
    if (url.includes("/jobs/")) return json(makeJob("succeeded"));
    if (url.endsWith("/search")) return json({ chunks: [{ chunk_id: chunkId, text: redacted ? "[개인정보 가림]" : "안전한 본문", section: "content", similarity: .8,
      pages: [1], source_blocks: [blockId], start: 10, end: 27, ...(redacted ? { redacted: true } : {}) }] });
    return json(makeDoc(makeJob("succeeded")));
  }));
  mount("/admin/documents?document=" + id);
  await waitFor(() => expect(screen.getByRole("button", { name: "실행" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("질문"), { target: { value: "2026년 문서 내용" } });
  fireEvent.click(screen.getByRole("button", { name: "실행" }));
  const results = await screen.findByRole("region", { name: "검색 결과" });
  expect(within(results).getByText(redacted ? "[개인정보 가림]" : "안전한 본문")).toBeInTheDocument();
  expect(results).toHaveTextContent(chunkId);
  expect(results).toHaveTextContent(`원문 블록: ${blockId} · 위치: 10–27`);
  expect(within(results).queryByText(/원문 그대로의 인용이 아닙니다/)).toBe(redacted ? within(results).getByText(/원문 그대로의 인용이 아닙니다/) : null);
  if (redacted) expect(results).toHaveTextContent("위치는 가리기 전 원문 기준입니다.");
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

it("공개 모드에서 서버가 관리자 권한을 거부하면 문서 API를 호출하지 않는다", async () => {
  vi.stubEnv("DEV", false); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  checkAdminAccess.mockRejectedValue(new ApiError("관리자 로그인이 필요합니다.", 401));
  await act(async () => { mount(); });
  expect(screen.getByRole("heading", { name: "관리자 로그인" })).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});


it.each(["http503", "network"])("설정 조회 %s 실패는 미설정이나 빈 제도로 단정하지 않는다", async failure => {
  vi.stubEnv("DEV", true);
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/processing")) {
      if (failure === "network") throw new TypeError("synthetic network failure");
      return { ...json({ detail: "processing_unavailable" }), ok: false, status: 503 };
    }
    return json({ items: [], next_offset: null });
  });
  vi.stubGlobal("fetch", fetch); mount();
  await screen.findByRole("alert");
  expect(screen.queryByText(/0005 마이그레이션/)).not.toBeInTheDocument();
  expect(screen.queryByText(/제도 등록·관리에서 먼저 등록/)).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => url.includes("/programs?"))).toBe(false);
  expect(screen.getByRole("button", { name: "업로드·자동 처리" })).toBeDisabled();
  await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "업로드·자동 처리" }).closest("form")!); });
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/documents"))).toBe(false);
});

it.each([false, true])("목록 조회 실패는 업로드를 막고 성공 재조회로 회복한다: 이전 목록=%s", async previous => {
  vi.stubEnv("DEV", true);
  let ready = previous;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/processing")) return json({ ready: true });
    if (url.includes("/programs?")) return ready
      ? json({ items: [{ service_id: "WLF_SAMPLE", program_name: "일반 제도", test_only: false }], next_offset: null })
      : { ...json({ detail: "programs_unavailable" }), ok: false, status: 503 };
    throw new Error("unexpected request");
  });
  vi.stubGlobal("fetch", fetch); mount();
  if (previous) {
    await screen.findByRole("option", { name: /일반 제도/ });
    fireEvent.change(screen.getByLabelText("연결할 제도"), { target: { value: "WLF_SAMPLE" } });
    fireEvent.change(screen.getByLabelText("문서명"), { target: { value: "보존할 문서명" } });
    ready = false;
    fireEvent.click(screen.getByRole("button", { name: "설정·제도 목록 다시 불러오기" }));
  }
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "업로드·자동 처리" })).toBeDisabled();
  expect(screen.queryByText(/0005 마이그레이션|제도 등록·관리에서 먼저 등록/)).not.toBeInTheDocument();
  if (previous) {
    expect(screen.getByLabelText("문서명")).toHaveValue("보존할 문서명");
    expect(screen.getByLabelText("연결할 제도")).toHaveValue("WLF_SAMPLE");
  }
  await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "업로드·자동 처리" }).closest("form")!); });
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/documents"))).toBe(false);
  ready = true;
  fireEvent.click(screen.getByRole("button", { name: "설정·제도 목록 다시 불러오기" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "업로드·자동 처리" })).toBeEnabled());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  if (previous) expect(screen.getByLabelText("문서명")).toHaveValue("보존할 문서명");
});

it("업로드 자체의 실패는 확인된 설정과 목록을 무효화하지 않고 재시도를 허용한다", async () => {
  vi.stubEnv("DEV", true);
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/processing")) return json({ ready: true });
    if (url.includes("/programs?")) return json({ items: [{ service_id: "WLF_SAMPLE", program_name: "일반 제도", test_only: false }], next_offset: null });
    if (url.endsWith("/documents") && options.method === "POST") {
      posts++;
      return posts === 1 ? { ...json({ detail: "temporary_failure" }), ok: false, status: 503 }
        : json({ document_id: id, job_id: jobId });
    }
    if (url.includes("/jobs/")) return json(makeJob("queued"));
    return json(makeDoc(makeJob("queued")));
  }));
  mount();
  await screen.findByRole("option", { name: /일반 제도/ });
  fireEvent.change(screen.getByLabelText("연결할 제도"), { target: { value: "WLF_SAMPLE" } });
  const button = screen.getByRole("button", { name: "업로드·자동 처리" });
  fireEvent.submit(button.closest("form")!);
  await screen.findByRole("alert");
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.submit(button.closest("form")!);
  await waitFor(() => expect(posts).toBe(2));
});
