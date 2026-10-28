import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { App } from "../App";
import { STORAGE_KEYS } from "../lib/storage";

const state = vi.hoisted(() => ({ session: null as Session | null, listener: undefined as ((event: AuthChangeEvent, session: Session | null) => void) | undefined, signIn: vi.fn() }));
vi.mock("../auth/supabase", () => ({ getSupabase: () => ({ auth: {
  getSession: async () => ({ data: { session: state.session }, error: null }),
  onAuthStateChange: (callback: typeof state.listener) => { state.listener = callback; return { data: { subscription: { unsubscribe: () => { state.listener = undefined; } } } }; },
  signInWithPassword: async (credentials: unknown) => {
    const result = await state.signIn(credentials);
    if (!result.error) { state.session = result.data.session; state.listener?.("SIGNED_IN", state.session); }
    return result;
  },
  signOut: async () => { state.session = null; state.listener?.("SIGNED_OUT", null); return { error: null }; },
} }) }));

const session = (id = "admin-a", token = "admin-token") => ({ user: { id }, access_token: token, token_type: "bearer", expires_in: 3600, refresh_token: "dummy-refresh" }) as Session;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const documentId = "00000000-0000-0000-0000-000000000001";
const jobId = "00000000-0000-0000-0000-000000000002";
const oldHistory = [{ id: "public", at: "2026-01-01T00:00:00Z", question: "기존 공개 질문", summary: "공개 안내", answerText: "공개 응답", fallback: false }];
function mount(path = "/admin/documents") {
  return render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter>);
}
beforeEach(() => {
  state.session = null; state.listener = undefined;
  state.signIn.mockResolvedValue({ data: { session: session() }, error: null });
  vi.stubEnv("DEV", false);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("공개 로그인부터 업로드·게시 상태·기본 채팅과 로그아웃까지 같은 관리자 토큰을 사용한다", async () => {
  let phase = "parsing";
  const job = () => ({ job_id: jobId, state: phase, error_code: null, processing_mode: "automatic" });
  const doc = () => ({ document_id: documentId, name: "등록 문서", service_id: "WLF_PUBLIC", source_url: "https://example.invalid/source", source_organization: "기관", basis_year: null, source_updated_at: null, test_only: false, active_job_id: phase === "succeeded" ? jobId : null, jobs: [job()] });
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    const token = new Headers(options.headers).get("Authorization");
    if (url.endsWith("/session")) return token ? json({ is_admin: true, access_mode: "authenticated" }) : json({}, 401);
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
  fireEvent.change(await screen.findByLabelText("이메일"), { target: { value: "admin@example.invalid" } });
  fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "dummy-password" } });
  fireEvent.click(screen.getByRole("button", { name: "들어가기" }));
  await screen.findByRole("option", { name: /공개 제도/ });
  fireEvent.change(screen.getByLabelText("연결할 제도"), { target: { value: "WLF_PUBLIC" } });
  for (const [label, value] of [["문서명", "등록 문서"], ["공개 원문 URL (HTTPS)", "https://example.invalid/source"], ["발행 기관", "기관"]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const checks = fetch.mock.calls.filter(([url]) => url.endsWith("/session")).length;
  act(() => { state.session = session("admin-a", "renewed-token"); state.listener?.("TOKEN_REFRESHED", state.session); });
  expect(screen.getByLabelText("문서명")).toHaveValue("등록 문서");
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/session"))).toHaveLength(checks);
  fireEvent.change(screen.getByLabelText(/원문 파일/), { target: { files: [new File(["# 원문"], "source.md")] } });
  fireEvent.submit(screen.getByRole("button", { name: "업로드·자동 처리" }).closest("form")!);
  await screen.findByText("모델 준비·원문 분석 중");
  phase = "succeeded";
  fireEvent.click(screen.getByRole("button", { name: "상태 새로 확인" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "실행" })).toBeEnabled());
  fireEvent.click(screen.getByRole("link", { name: "기본 채팅으로 이동" }));
  fireEvent.change(screen.getByLabelText("궁금한 내용"), { target: { value: "관리자 자료 질문" } });
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
  const log = screen.getByRole("log", { name: "상담 내용" });
  await within(log).findByText("관리자 자료의 응답");
  fireEvent.click(within(log).getByText("원문 근거 보기 (1건)"));
  expect(within(log).getByText(/쪽: 1/)).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(oldHistory);
  fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
  await waitFor(() => expect(screen.queryByText("관리자 자료의 응답")).not.toBeInTheDocument());
  expect(screen.getByText("기존 공개 질문")).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(oldHistory);
});

it("로그인된 비관리자는 서버 403으로 문서 기능을 열지 못한다", async () => {
  state.session = session("non-admin");
  const fetch = vi.fn(async () => json({}, 403));
  vi.stubGlobal("fetch", fetch);
  mount("/admin/programs");
  expect(await screen.findByRole("alert")).toHaveTextContent("활성 관리자 권한이 없습니다");
  expect(screen.queryByRole("button", { name: "+ 새 제도 추가" })).not.toBeInTheDocument();
  expect(fetch.mock.calls).toHaveLength(1);
});

it("계정을 바꾸면 이전 관리자 응답을 새 계정 화면이나 공개 이력에 남기지 않는다", async () => {
  state.session = session();
  vi.stubGlobal("fetch", vi.fn(async () => json({ kind: "answer", text: "이전 계정 원문", services: [], suggestions: [] })));
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(oldHistory));
  mount("/");
  fireEvent.change(await screen.findByLabelText("궁금한 내용"), { target: { value: "관리자 질문" } });
  fireEvent.click(screen.getByRole("button", { name: "질문 보내기" }));
  await within(screen.getByRole("log", { name: "상담 내용" })).findByText("이전 계정 원문");
  act(() => { state.session = session("admin-b"); state.listener?.("SIGNED_IN", state.session); });
  expect(screen.queryByText("이전 계정 원문")).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(oldHistory);
});
