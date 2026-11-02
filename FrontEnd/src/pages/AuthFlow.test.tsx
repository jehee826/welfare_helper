import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { saveAdminSession } from "../auth/session";
import { App } from "../App";
import { STORAGE_KEYS } from "../lib/storage";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const documentId = "00000000-0000-0000-0000-000000000001";
const jobId = "00000000-0000-0000-0000-000000000002";
const oldHistory = [{ id: "public", at: "2026-01-01T00:00:00Z", question: "기존 공개 질문", summary: "공개 안내", answerText: "공개 응답", fallback: false }];
function mount(path = "/admin/documents") {
  return render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter>);
}
beforeEach(() => vi.stubEnv("DEV", false));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("관리자 로그인부터 업로드·게시 상태와 로그아웃까지 같은 토큰을 사용한다", async () => {
  let phase = "parsing";
  const job = () => ({ job_id: jobId, state: phase, error_code: null, processing_mode: "automatic" });
  const doc = () => ({ document_id: documentId, name: "등록 문서", service_id: "WLF_PUBLIC", source_url: "https://example.invalid/source", source_organization: "기관", basis_year: null, source_updated_at: null, test_only: false, active_job_id: phase === "succeeded" ? jobId : null, jobs: [job()] });
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    const token = new Headers(options.headers).get("Authorization");
    if (url.endsWith("/login")) return json({ access_token: "admin-token", session_id: "first-session", expires_at: Date.now() / 1000 + 3600 });
    if (url.endsWith("/logout")) return new Response(null, { status: 204 });
    if (url.endsWith("/session")) return token ? json({ is_admin: true, access_mode: "shared_password" }) : json({}, 401);
    expect(token).toMatch(/^Bearer (admin-token|renewed-token)$/);
    if (url.endsWith("/processing")) return json({ ready: true });
    if (url.includes("/programs?")) return json({ items: [{ service_id: "WLF_PUBLIC", program_name: "공개 제도", test_only: false }], next_offset: null });
    if (url.endsWith("/documents") && options.method === "POST") {
      expect(JSON.parse(String((options.body as FormData).get("metadata")))).toMatchObject({ test_only: false });
      return json({ document_id: documentId, job_id: jobId });
    }
    if (url.includes("/jobs/")) return json(job());
    if (url.endsWith("/chat")) return json({ kind: "answer", text: "관리자 자료의 응답", services: [], suggestions: [], evidence: [{ chunk_id: "c1", document_id: documentId, role: "retrieved", quote: "", context: "원문 내용", pages: [1], source_blocks: ["b1"], source_url: "https://example.invalid/source" }] });
    return json(doc());
  });
  vi.stubGlobal("fetch", fetch);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(oldHistory));
  mount();
  expect(screen.getByRole("link", { name: "문서 관리" })).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText("비밀번호"), { target: { value: "dummy-password" } });
  fireEvent.click(screen.getByRole("button", { name: "들어가기" }));
  await screen.findByRole("option", { name: /공개 제도/ });
  fireEvent.change(screen.getByLabelText("연결할 제도"), { target: { value: "WLF_PUBLIC" } });
  for (const [label, value] of [["문서명", "등록 문서"], ["공개 원문 URL (HTTPS)", "https://example.invalid/source"], ["발행 기관", "기관"]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const checks = fetch.mock.calls.filter(([url]) => url.endsWith("/session")).length;
  act(() => saveAdminSession({ access_token: "admin-token", session_id: "first-session", expires_at: Date.now() / 1000 + 3600 }));
  expect(screen.getByLabelText("문서명")).toHaveValue("등록 문서");
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/session"))).toHaveLength(checks);
  fireEvent.change(screen.getByLabelText(/원문 파일/), { target: { files: [new File(["# 원문"], "source.md")] } });
  fireEvent.submit(screen.getByRole("button", { name: "업로드·자동 처리" }).closest("form")!);
  await screen.findByText("모델 준비·원문 분석 중");
  phase = "succeeded";
  fireEvent.click(screen.getByRole("button", { name: "상태 새로 확인" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "실행" })).toBeEnabled());
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(oldHistory);
  fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
  await screen.findByLabelText("비밀번호");
  expect(screen.queryByRole("button", { name: "업로드·자동 처리" })).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(oldHistory);
});

it("서버가 세션을 거부하면 문서 기능을 열지 못한다", async () => {
  saveAdminSession({ access_token: "invalid-token", session_id: "invalid", expires_at: Date.now() / 1000 + 3600 });
  const fetch = vi.fn(async () => json({}, 401));
  vi.stubGlobal("fetch", fetch);
  mount("/admin/programs");
  expect(await screen.findByLabelText("비밀번호")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "+ 새 제도 추가" })).not.toBeInTheDocument();
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
});

it("문서 관리 직접 진입의 비밀번호 실패는 입력을 비우고 업로드를 열지 않는다", async () => {
  const fetch = vi.fn(async (_url: string) => json({}, 401));
  vi.stubGlobal("fetch", fetch);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(oldHistory));
  mount();
  fireEvent.change(await screen.findByLabelText("비밀번호"), { target: { value: "synthetic-wrong-password" } });
  fireEvent.click(screen.getByRole("button", { name: "들어가기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("관리자 비밀번호가 일치하지 않습니다.");
  expect(screen.getByLabelText("비밀번호")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "업로드·자동 처리" })).not.toBeInTheDocument();
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/login") || String(url).endsWith("/session"))).toBe(true);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(oldHistory);
});
