import { screen, within } from "@testing-library/react";
import { renderApp } from "../test/renderApp";

async function login() {
  const ctx = renderApp("/admin");
  await ctx.user.type(screen.getByLabelText("관리자 키"), "test-key");
  await ctx.user.click(screen.getByRole("button", { name: "들어가기" }));
  return ctx;
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
    await user.type(within(dialog).getByLabelText("요약 *"), "홀로 사는 어르신께 반찬을 전달합니다.");
    await user.type(within(dialog).getByLabelText("검색 키워드 (쉼표로 구분)"), "반찬, 식사");
    await user.type(within(dialog).getByLabelText("신청 방법"), "복지관 1층 안내데스크 방문");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    expect(screen.getByRole("cell", { name: /행복복지관 반찬나눔/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "확인" }));
    expect(await screen.findByText("안내 가능")).toBeInTheDocument();
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
