import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthProvider";
import { clearAdminSession, readAdminSession, saveAdminSession } from "../../auth/session";
import { PasswordRotation } from "./PasswordRotation";

const password = "Synthetic_New_" + "a".repeat(18);
const rotationToken = "synthetic-grant-" + "a".repeat(32);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function save(id = "owner") {
  saveAdminSession({ access_token: `${id}-token`, session_id: id, expires_at: Date.now() / 1000 + 3600 });
}
async function begin() {
  const view = render(<AuthProvider><PasswordRotation /></AuthProvider>);
  const button = await screen.findByRole("button", { name: "비밀번호 재발급" });
  button.focus(); fireEvent.click(button);
  const input = screen.getByLabelText("기존 비밀번호");
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "synthetic-current" } });
  fireEvent.submit(input.closest("form")!);
  return view;
}

beforeEach(() => {
  save();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("현재 비밀번호 확인 뒤 자동 적용하고 로그아웃해도 한 번 표시와 복사를 유지한다", async () => {
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer owner-token");
    expect(options.cache).toBe("no-store"); expect(options.redirect).toBe("error");
    if (url.endsWith("/issue")) {
      expect(JSON.parse(options.body as string)).toEqual({ current_password: "synthetic-current" });
      return json({ password, rotation_token: rotationToken });
    }
    expect(JSON.parse(options.body as string)).toEqual({ rotation_token: rotationToken });
    return json({ applied: true });
  });
  vi.stubGlobal("fetch", fetch);
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal("navigator", { clipboard });
  await begin();
  await screen.findByText(/기존 관리자 세션을 종료했습니다/);
  expect(screen.getByLabelText("새 비밀번호")).toHaveValue(password);
  expect(screen.getByLabelText("새 비밀번호")).toHaveFocus();
  expect(readAdminSession()).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "비밀번호 재발급" })).not.toBeInTheDocument();
  expect(JSON.stringify([localStorage, sessionStorage])).not.toContain(password);
  fireEvent.click(screen.getByRole("button", { name: "복사하고 닫기" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  expect(clipboard.writeText).toHaveBeenCalledWith(password);
});

it.each([403, 429, 503])("발급 실패 %i에서는 적용하지 않고 현재 입력을 비운다", async status => {
  const fetch = vi.fn().mockResolvedValue(json({ detail: "current_password_invalid" }, status));
  vi.stubGlobal("fetch", fetch);
  await begin();
  await screen.findByRole("alert");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("기존 비밀번호")).toHaveValue("");
  expect(readAdminSession()?.session_id).toBe("owner");
  fireEvent.click(screen.getByRole("button", { name: "닫기" }));
  expect(screen.getByRole("button", { name: "비밀번호 재발급" })).toHaveFocus();
});

it("적용 응답이 유실돼도 받은 비밀번호를 닫기 전까지 보존하고 불확실성을 안내한다", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ password, rotation_token: rotationToken }))
    .mockRejectedValueOnce(new Error("synthetic-network-failure")));
  await begin();
  expect(await screen.findByRole("alert")).toHaveTextContent("적용 여부를 확인하지 못했습니다");
  expect(screen.getByLabelText("새 비밀번호")).toHaveValue(password);
  expect(screen.getByRole("button", { name: "복사하고 닫기" })).toBeEnabled();
});

it("중복 발급을 막고 발급 응답 전에 세션이 바뀌면 늦은 응답을 적용하지 않는다", async () => {
  let resolve: (response: Response) => void = () => undefined;
  const fetch = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetch);
  await begin();
  fireEvent.submit(screen.getByLabelText("기존 비밀번호").closest("form")!);
  expect(fetch).toHaveBeenCalledTimes(1);
  act(() => { clearAdminSession(); save("new-owner"); });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  await act(async () => resolve(json({ password, rotation_token: rotationToken })));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(readAdminSession()?.session_id).toBe("new-owner");
  expect(screen.getByRole("button", { name: "비밀번호 재발급" })).toBeEnabled();
});

it("화면을 벗어나면 진행 중인 발급 요청을 취소한다", async () => {
  const fetch = vi.fn((_url: string, _options: RequestInit) => new Promise<Response>(() => undefined));
  vi.stubGlobal("fetch", fetch);
  const view = await begin(); view.unmount();
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
});

it("적용 요청이 멈추면 30초 뒤 받은 값을 보존하며 복사·닫기를 다시 허용한다", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ password, rotation_token: rotationToken }))
    .mockImplementationOnce((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await begin();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(screen.getByRole("alert")).toHaveTextContent("적용 여부를 확인하지 못했습니다");
  expect(screen.getByLabelText("새 비밀번호")).toHaveValue(password);
  expect(screen.getByRole("button", { name: "복사하고 닫기" })).toBeEnabled();
});
