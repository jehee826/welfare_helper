import { authenticatedFetch } from "./auth";
import { documentRequest } from "./documentApi";
import { createHttpApi } from "./httpApi";

const mock = vi.hoisted(() => ({ getSession: vi.fn(), refreshSession: vi.fn() }));
vi.mock("../auth/supabase", () => ({ getSupabase: () => ({ auth: mock }) }));

beforeEach(() => {
  mock.getSession.mockResolvedValue({ data: { session: { access_token: "old-token" } }, error: null });
  mock.refreshSession.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("관리자 API·파일 업로드·기본 채팅에 같은 세션의 Bearer를 전달한다", async () => {
  const fetch = vi.fn(async (url: string, _options: RequestInit) => new Response(JSON.stringify(url.endsWith("/departments") ? [] : { kind: "answer", services: [], suggestions: [] }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const body = new FormData(); body.set("file", new File(["test"], "source.md"));
  await documentRequest("", new AbortController().signal, { method: "POST", body });
  const api = createHttpApi();
  await api.listDepartments(); await api.ask("원문 질문", null);
  for (const [, options] of fetch.mock.calls) expect(new Headers(options.headers).get("Authorization")).toBe("Bearer old-token");
  expect(fetch.mock.calls[0][1].body).toBe(body);
  expect(new Headers(fetch.mock.calls[0][1].headers).has("Content-Type")).toBe(false);
});

it("401은 세션 갱신 후 한 번만 재요청하고 403은 우회하지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  mock.refreshSession.mockResolvedValue({ data: { session: { access_token: "new-token" } }, error: null });
  expect((await authenticatedFetch("/api/v1/admin/session")).status).toBe(403);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer new-token");
  expect(mock.refreshSession).toHaveBeenCalledTimes(1);
});

it("만료 세션 갱신 실패를 익명 요청으로 바꾸지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  mock.refreshSession.mockResolvedValue({ data: { session: null }, error: new Error("private refresh token") });
  await expect(authenticatedFetch("/api/v1/admin/session")).rejects.toMatchObject({ code: "session_expired", status: 401 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("localhost 화면에서도 EC2 서버 권한 확인이 실패하면 허용하지 않는다", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_API_BASE_URL", "https://ec2.example.invalid");
  vi.resetModules();
  const remote = await import("./auth");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  await expect(remote.checkAdminAccess(new AbortController().signal)).rejects.toMatchObject({ status: 403 });
  expect(fetch.mock.calls[0][0]).toBe("https://ec2.example.invalid/api/v1/admin/session");
});
