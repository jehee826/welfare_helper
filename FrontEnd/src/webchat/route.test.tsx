import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { App } from "../App";

const { checkAdminAccess } = vi.hoisted(() => ({ checkAdminAccess: vi.fn() }));
vi.mock("../api/auth", async original => ({ ...await original<typeof import("../api/auth")>(), checkAdminAccess }));

function Location() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("/webchat은 관리자 권한 확인 없이 사용자 웹 챗봇을 연다", async () => {
  const fetch = vi.fn(async (_url: string) => new Response("", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("speechSynthesis", undefined);
  render(<MemoryRouter initialEntries={["/webchat"]}><App /><Location /></MemoryRouter>);
  expect(screen.getByRole("heading", { level: 1, name: "복지 안내 질문하기" })).toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent("/webchat");
  expect(screen.queryByText("관리자 권한 확인 중")).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(checkAdminAccess).not.toHaveBeenCalled();
  expect(document.title).toBe("곁에 · 복지 안내");
  await waitFor(() => expect(fetch.mock.calls.every(([url]) => !String(url).includes("/admin"))).toBe(true));
});
