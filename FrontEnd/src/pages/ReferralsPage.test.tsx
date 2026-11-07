import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { readAdminSession, saveAdminSession } from "../auth/session";
import { ReferralsPage } from "./ReferralsPage";
import type { ReferralResult } from "../api/referralApi";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function result(next_offset: number | null = null): ReferralResult {
  return { items: [{ response_id: "response-one", contact_version: "contact-one", department_id: 1,
    department_name: "합성 부서", ministry_name: "합성 기관", label: "업무 문의처", phone: "02-123-4567",
    source_url: "https://example.go.kr/service", document_id: "doc-one", document_version: "v1", created_at: "2026-11-07T00:00:00Z" }],
    departments: [{ department_id: 1, department_name: "합성 부서", ministry_name: "합성 기관", response_count: 2 }],
    response_count: 2, contact_count: 3, next_offset, retention_days: 90, failed_writes_since_restart: 0 };
}
const empty = (): ReferralResult => ({ ...result(), items: [], departments: [], response_count: 0, contact_count: 0 });
beforeEach(() => saveAdminSession({ access_token: "synthetic-token", session_id: "synthetic-session", expires_at: Date.now() / 1000 + 3600 }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("연락처·출처·서버 생성 지표를 표시하고 기간·부서 필터를 인증 요청으로 보낸다", async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => json(result())); vi.stubGlobal("fetch", fetch);
  render(<ReferralsPage />);
  await screen.findByText("안내 응답 2건 · 연락처 3건");
  expect(screen.getByText(/실제 이용자·화면 수신·전화 발신·신청 횟수가 아닙니다/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "연락처 증명 출처" })).toHaveAttribute("href", "https://example.go.kr/service");
  fireEvent.change(screen.getByLabelText("시작일 (한국 시각)"), { target: { value: "2026-11-01" } });
  fireEvent.change(screen.getByLabelText("종료일 (한국 시각)"), { target: { value: "2026-11-07" } });
  fireEvent.change(screen.getByLabelText("담당 부서"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: /^조회$/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const [url, options] = fetch.mock.calls[1];
  expect(url).toContain("date_from=2026-11-01&date_to=2026-11-07&department_id=1");
  expect(new Headers(options.headers).get("Authorization")).toBe("Bearer synthetic-token");
  expect(options.cache).toBe("no-store");
});

it("다음 페이지를 가져와도 집계는 API의 전체 조건 집계를 유지한다", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(result(50))).mockResolvedValueOnce(json(result()));
  vi.stubGlobal("fetch", fetch); render(<ReferralsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "다음 기록" }));
  await screen.findByRole("button", { name: "이전 기록" });
  expect(fetch.mock.calls[1][0]).toContain("offset=50");
  expect(screen.getByText("안내 응답 2건 · 연락처 3건")).toBeInTheDocument();
});

it("필터 결과가 비어도 선택한 부서를 전체 부서로 잘못 표시하지 않는다", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(result())).mockResolvedValueOnce(json(empty())));
  render(<ReferralsPage />);
  await screen.findByText("안내 응답 2건 · 연락처 3건");
  fireEvent.change(screen.getByLabelText("담당 부서"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: /^조회$/ }));
  await screen.findByText("해당 기간의 연락처 안내 기록이 없습니다.");
  expect(screen.getByLabelText("담당 부서")).toHaveValue("1");
});

it("삭제는 취소할 수 있고 명시 확인 후에만 실행하며 감소한 집계를 다시 조회한다", async () => {
  let deleted = false;
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === "DELETE") { deleted = true; return json({ deleted_contacts: 3 }); }
    return json(deleted ? empty() : result());
  });
  vi.stubGlobal("fetch", fetch); render(<ReferralsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "조회 조건의 기록 삭제" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("되돌릴 수 없습니다");
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "조회 조건의 기록 삭제" }));
  fireEvent.click(screen.getByRole("button", { name: "해당 기록 영구 삭제" }));
  expect(await screen.findByText("안내 응답 0건 · 연락처 0건")).toBeInTheDocument();
  expect(screen.getByText("해당 기간의 연락처 안내 기록이 없습니다.")).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
});

it("기록 비활성/장애는 오류를 표시하고 무한 재시도하지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValue(json({}, 503)); vi.stubGlobal("fetch", fetch);
  render(<ReferralsPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("기록 활성화 상태와 연결");
  expect(screen.getByRole("button", { name: /^조회$/ })).toBeEnabled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("구세션 401은 토큰을 지우고 익명 요청으로 재시도하지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValue(json({}, 401)); vi.stubGlobal("fetch", fetch);
  render(<ReferralsPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("세션이 만료되었습니다");
  expect(readAdminSession()).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});

it("실제 앱의 직접 경로도 인증이 실패하면 기록 페이지를 열지 않는다", async () => {
  const fetch = vi.fn().mockResolvedValue(json({}, 401)); vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter initialEntries={["/admin/referrals"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><App /></MemoryRouter>);
  expect(await screen.findByLabelText("비밀번호")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "연락처 안내 기록" })).not.toBeInTheDocument();
  expect(fetch.mock.calls.every(([url]) => !String(url).includes("/referrals"))).toBe(true);
});

it("화면을 떠나면 대기 중인 목록 요청을 취소한다", async () => {
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ReferralsPage />);
  await act(async () => view.unmount());
  expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
});
