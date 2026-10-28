import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../api/httpApi";
import { createMockApi } from "../api/mockApi";
import type { AdminProgram, WelfareApi } from "../api/types";
import { ProgramManager } from "../components/admin/ProgramManager";
import { renderApp } from "../test/renderApp";

async function login() {
  const ctx = renderApp("/admin");
  await ctx.user.type(screen.getByLabelText("관리자 키"), "test-key");
  await ctx.user.click(screen.getByRole("button", { name: "들어가기" }));
  return ctx;
}

const linked: AdminProgram = {
  programId: 7,
  serviceId: "WLF00001164",
  externalServiceId: "WLF00001164",
  name: "기초연금",
  summary: "노인 생활 안정",
  departmentId: 1,
  departmentName: "기초연금과",
  ministryName: "보건복지부",
  contacts: [{ label: "국민연금공단", phone: "1355" }],
  sourceUrl: null,
  sourceUpdatedAt: null,
  testOnly: false,
  updatedAt: "2026-10-28T01:02:03.456789+00:00",
  documentCount: 2,
  publishedCount: 1,
};

function fakeApi(overrides: Partial<WelfareApi> = {}): WelfareApi {
  return {
    ...createMockApi({ latencyMs: 0 }),
    listPrograms: vi.fn().mockResolvedValue({ items: [linked], hasMore: false }),
    listDepartments: vi.fn().mockResolvedValue([{ id: 1, name: "기초연금과", ministry: "보건복지부" }]),
    ...overrides,
  };
}

describe("관리자 화면", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ADMIN_DEMO_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("키가 틀리면 들어갈 수 없다", async () => {
    const { user } = renderApp("/admin");
    await user.type(screen.getByLabelText("관리자 키"), "wrong");
    await user.click(screen.getByRole("button", { name: "들어가기" }));
    expect(screen.getByRole("alert")).toHaveTextContent("일치하지 않아요");
  });

  it("새 제도를 추가하면 목록과 이용자 검색에 반영된다 (FR-6)", async () => {
    const { user } = await login();
    expect(await screen.findByText("기초연금")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ 새 제도 추가" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("제도명 *"), "행복복지관 반찬나눔");
    await user.type(within(dialog).getByLabelText("요약"), "홀로 사는 어르신께 반찬을 전달합니다.");
    await user.selectOptions(within(dialog).getByLabelText("담당 부서 *"), within(dialog).getAllByRole("option")[1]);
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    expect(await screen.findByRole("cell", { name: /행복복지관 반찬나눔/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "확인" }));
    expect(await screen.findByText("안내 가능")).toBeInTheDocument();
  });

  it("상세 자격·신청 방법은 직접 입력받지 않고 원문 문서 검토로 안내한다", async () => {
    const { user } = await login();
    await user.click(await screen.findByRole("button", { name: "+ 새 제도 추가" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByLabelText("신청 방법")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("신청 자격")).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent("원문 문서");
  });

  it("제도를 삭제하면 목록에서 빠진다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = await login();
    await user.click(await screen.findByRole("button", { name: "에너지바우처 삭제" }));
    expect(screen.queryByRole("cell", { name: /에너지바우처/ })).not.toBeInTheDocument();
  });

  it("이용 통계 탭에서 월별 문의와 연결 건수를 본다", async () => {
    const { user } = await login();
    await user.click(screen.getByRole("tab", { name: "이용 통계" }));
    expect(await screen.findByRole("table", { name: "월별 문의와 상담원 연결 건수" })).toBeInTheDocument();
  });
});

describe("제도 관리와 원문 문서", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("원문 문서 수를 보여주고, 문서가 있는 제도는 이름과 서비스 ID를 잠근다", async () => {
    const user = userEvent.setup();
    render(<ProgramManager api={fakeApi()} />);
    const row = (await screen.findByRole("button", { name: "기초연금 수정" })).closest("tr")!;
    expect(row).toHaveTextContent("2건 (게시 1)");

    await user.click(within(row).getByRole("button", { name: "기초연금 수정" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("제도명 *")).toBeDisabled();
    expect(within(dialog).getByLabelText("외부 서비스 ID")).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: /테스트용 제도/ })).toBeDisabled();
    expect(within(dialog).getByLabelText("요약")).toBeEnabled();
  });

  it("수정하면 바뀐 항목만 보낸다", async () => {
    const user = userEvent.setup();
    const updateProgram = vi.fn().mockResolvedValue({ ...linked, summary: "새 요약" });
    render(<ProgramManager api={fakeApi({ updateProgram })} />);
    await user.click(await screen.findByRole("button", { name: "기초연금 수정" }));
    const summary = within(screen.getByRole("dialog")).getByLabelText("요약");
    await user.clear(summary);
    await user.type(summary, "새 요약");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(updateProgram).toHaveBeenCalledWith(linked, { summary: "새 요약" });
    expect(await screen.findByRole("status")).toHaveTextContent("다음 질문부터");
  });

  it("서버가 거절한 이유를 쉬운 말로 알려준다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    const deleteProgram = vi.fn().mockRejectedValue(new ApiError("program_has_documents", 409, "program_has_documents"));
    render(<ProgramManager api={fakeApi({ deleteProgram })} />);
    await user.click(await screen.findByRole("button", { name: "기초연금 삭제" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("원문 문서가 연결돼 있어");
    expect(screen.getByRole("button", { name: "기초연금 수정" })).toBeInTheDocument();
  });

  it("다른 사람이 먼저 고쳤으면 다시 불러오라고 알려준다", async () => {
    const user = userEvent.setup();
    const updateProgram = vi.fn().mockRejectedValue(new ApiError("program_changed", 409, "program_changed"));
    render(<ProgramManager api={fakeApi({ updateProgram })} />);
    await user.click(await screen.findByRole("button", { name: "기초연금 수정" }));
    await user.type(within(screen.getByRole("dialog")).getByLabelText("요약"), " 추가");
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("다른 곳에서 먼저 수정");
  });
});
