import { authenticatedFetch, checkAdminAccess } from "./auth";
import { documentRequest } from "./documentApi";
import { createHttpApi } from "./httpApi";
import { readAdminSession, saveAdminSession, SESSION_KEY } from "../auth/session";

beforeEach(() => saveAdminSession({ access_token: "admin-token", session_id: "session-one", expires_at: Date.now() / 1000 + 3600 }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("관리자 API·업로드·기본 채팅에 같은 서버 세션 Bearer를 전달한다", async () => {
  const fetch = vi.fn(async (url: string, _options: RequestInit) => new Response(JSON.stringify(url.endsWith("/departments") ? [] : { kind: "answer", services: [], suggestions: [] }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const body = new FormData(); body.set("file", new File(["test"], "source.md"));
  await documentRequest("", new AbortController().signal, { method: "POST", body });
  const api = createHttpApi(); await api.listDepartments(); await api.ask("원문 질문", null);
  for (const [, options] of fetch.mock.calls) expect(new Headers(options.headers).get("Authorization")).toBe("Bearer admin-token");
  expect(fetch.mock.calls[0][1].body).toBe(body);
  expect(new Headers(fetch.mock.calls[0][1].headers).has("Content-Type")).toBe(false);
});

it("만료·거절된 세션을 삭제하고 익명 요청으로 재시도하지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 })); vi.stubGlobal("fetch", fetch);
  await expect(authenticatedFetch("/api/v1/admin/session")).rejects.toMatchObject({ code: "session_expired" });
  expect(fetch).toHaveBeenCalledTimes(1); expect(readAdminSession()).toBeNull();
  saveAdminSession({ access_token: "expired", session_id: "old", expires_at: 1 });
  await expect(authenticatedFetch("/api/v1/chat")).rejects.toMatchObject({ code: "session_expired" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("localhost 화면에서도 EC2 서버의 권한 확인을 통과해야 한다", async () => {
  vi.stubEnv("DEV", true); vi.stubEnv("VITE_API_BASE_URL", "https://ec2.example.invalid"); vi.resetModules();
  const remote = await import("./auth");
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 })); vi.stubGlobal("fetch", fetch);
  await expect(remote.checkAdminAccess(new AbortController().signal)).rejects.toMatchObject({ status: 403 });
  expect(fetch.mock.calls[0][0]).toBe("https://ec2.example.invalid/api/v1/admin/session");
});

it("세션이 없어도 서버 확인 없이 관리자 접근을 허용하지 않는다", async () => {
  sessionStorage.removeItem(SESSION_KEY);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
  await expect(checkAdminAccess(new AbortController().signal)).rejects.toMatchObject({ status: 401 });
});

it("늦게 도착한 이전 요청의 401이 새 로그인 세션을 지우지 않는다", async () => {
  let complete: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
  const request = authenticatedFetch("/api/v1/admin/session");
  saveAdminSession({ access_token: "new-token", session_id: "new-session", expires_at: Date.now() / 1000 + 3600 });
  complete(new Response(null, { status: 401 }));
  await expect(request).rejects.toMatchObject({ code: "session_expired" });
  expect(readAdminSession()?.session_id).toBe("new-session");
});
