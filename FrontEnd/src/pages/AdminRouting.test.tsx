import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { App } from "../App";
import { saveAdminSession } from "../auth/session";

const { checkAdminAccess } = vi.hoisted(() => ({ checkAdminAccess: vi.fn() }));
vi.mock("../api/auth", async original => ({ ...await original<typeof import("../api/auth")>(), checkAdminAccess }));
function Location() { const location = useLocation(); return <span data-testid="location">{location.pathname}</span>; }
function Back() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>뒤로 테스트</button>; }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(["/", "/admin", "/admin/unknown"])("%s는 문서 관리로 이동하며 권한 확인 전 관리 데이터를 읽지 않는다", async path => {
  vi.stubEnv("DEV", false); checkAdminAccess.mockImplementation(() => new Promise(() => {}));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter>);
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/admin/documents"));
  expect(screen.getByRole("status")).toHaveTextContent("관리자 권한 확인 중");
  expect(screen.queryByRole("button", { name: "업로드·자동 처리" })).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["/admin/documents", "/admin/programs"])("%s 직접 진입도 권한 확인 전 컴포넌트를 열지 않는다", async path => {
  vi.stubEnv("DEV", false); checkAdminAccess.mockImplementation(() => new Promise(() => {}));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("관리자 권한 확인 중"));
  expect(screen.getByTestId("location")).toHaveTextContent(path);
  expect(screen.queryByRole("button", { name: "+ 새 제도 추가" })).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("세션 전환 뒤 이전 권한 확인이 늦게 성공해도 관리 데이터를 열지 않는다", async () => {
  vi.stubEnv("DEV", false); let resolveOld!: (value: {is_admin: boolean; access_mode: string}) => void;
  checkAdminAccess.mockReset().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockImplementation(() => new Promise(() => {}));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  saveAdminSession({ access_token: "old", session_id: "old", expires_at: Date.now()/1000+600 });
  render(<MemoryRouter initialEntries={["/admin/documents"]}><App /></MemoryRouter>);
  await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  act(() => saveAdminSession({ access_token: "new", session_id: "new", expires_at: Date.now()/1000+600 }));
  await waitFor(() => expect(checkAdminAccess).toHaveBeenCalledTimes(2));
  await act(async () => resolveOld({is_admin:true,access_mode:"shared_password"}));
  expect(screen.queryByRole("button", { name: "업로드·자동 처리" })).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("문서에서 제도로 이동할 때 공통 권한 확인을 반복하지 않는다", async () => {
  vi.stubEnv("DEV", false); checkAdminAccess.mockReset().mockResolvedValue({is_admin:true,access_mode:"shared_password"});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("processing")?{ready:true}:{items:[],next_offset:null}),{headers:{"content-type":"application/json"}})));
  render(<MemoryRouter initialEntries={["/admin/documents"]}><App /><Location /></MemoryRouter>);
  await screen.findByRole("heading",{name:"문서 관리"});fireEvent.click(screen.getByRole("link",{name:"제도 관리"}));
  await screen.findByRole("heading",{name:"제도 등록·관리"});expect(checkAdminAccess).toHaveBeenCalledTimes(1);
});

it("기본 진입 replace는 뒤로 갈 때 이전 경로를 다시 방문한다", async () => {
  vi.stubEnv("DEV", false); checkAdminAccess.mockReset().mockImplementation(() => new Promise(() => {}));
  render(<MemoryRouter initialEntries={["/admin/programs","/"]} initialIndex={1}><App /><Location /><Back /></MemoryRouter>);
  await waitFor(()=>expect(screen.getByTestId("location")).toHaveTextContent("/admin/documents"));
  fireEvent.click(screen.getByRole("button",{name:"뒤로 테스트"}));expect(screen.getByTestId("location")).toHaveTextContent("/admin/programs");
});

it("관리 데이터가 열린 후 세션 만료 시 즉시 로그인으로 돌아간다", async () => {
  vi.stubEnv("DEV", false);vi.useFakeTimers();checkAdminAccess.mockReset().mockResolvedValue({is_admin:true,access_mode:"shared_password"});
  vi.stubGlobal("fetch",vi.fn(async (url:string)=>new Response(JSON.stringify(url.includes("processing")?{ready:true}:{items:[],next_offset:null}),{headers:{"content-type":"application/json"}})));
  try {
    saveAdminSession({access_token:"old",session_id:"old",expires_at:Date.now()/1000+10});
    await act(async()=>{render(<MemoryRouter initialEntries={["/admin/documents"]}><App /></MemoryRouter>);await Promise.resolve();await Promise.resolve();});
    expect(screen.getByRole("heading",{name:"문서 관리"})).toBeInTheDocument();
    checkAdminAccess.mockRejectedValue(new Error("expired"));
    await act(async()=>{await vi.advanceTimersByTimeAsync(10001);});
    expect(screen.queryByRole("button",{name:"업로드·자동 처리"})).not.toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
  } finally {vi.useRealTimers();}
});

it("이전 세션의 지연된 관리 데이터는 새 세션 화면에 표시되지 않는다", async () => {
  vi.stubEnv("DEV", false);checkAdminAccess.mockReset().mockResolvedValue({is_admin:true,access_mode:"shared_password"});
  let resolveOld!: (value: Response)=>void;let calls=0;let oldSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch",vi.fn((url:string,options:RequestInit)=>{if(url.includes("processing")&&calls++===0){oldSignal=options.signal as AbortSignal;return new Promise<Response>(resolve=>{resolveOld=resolve;});}return new Promise<Response>(()=>{});}));
  saveAdminSession({access_token:"old",session_id:"old",expires_at:Date.now()/1000+600});
  render(<MemoryRouter initialEntries={["/admin/documents"]}><App /></MemoryRouter>);
  await waitFor(()=>expect(resolveOld).toBeTypeOf("function"));
  act(()=>saveAdminSession({access_token:"new",session_id:"new",expires_at:Date.now()/1000+600}));
  await waitFor(()=>expect(checkAdminAccess).toHaveBeenCalledTimes(2));
  expect(oldSignal?.aborted).toBe(true);
  await act(async()=>resolveOld(new Response(JSON.stringify({ready:true}),{headers:{"content-type":"application/json"}})));
  expect(screen.queryByRole("option",{name:/이전 세션/})).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:"업로드·자동 처리"})).toBeDisabled();
});
