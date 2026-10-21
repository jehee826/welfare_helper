import { screen, within } from "@testing-library/react";
import { STORAGE_KEYS } from "../lib/storage";
import { renderApp } from "../test/renderApp";

const savedProfile = { age: 70, income: "under50", household: "single", region: "서울특별시", disability: false };

describe("이용자 화면", () => {
  it("첫 방문이면 조건 입력 화면을 보여주고, 입력하면 상담을 시작한다 (FR-1)", async () => {
    const { user } = renderApp();
    expect(screen.getByRole("heading", { name: /나에게 맞는 복지를/ })).toBeInTheDocument();

    await user.type(screen.getByLabelText("나이"), "70");
    await user.click(screen.getByRole("button", { name: "이 조건으로 시작하기" }));

    expect(screen.getByRole("log", { name: "상담 내용" })).toBeInTheDocument();
    expect(screen.getByText(/70세/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.profile)!).age).toBe(70);
  });

  it("나이를 비우면 오류를 알려준다", async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "이 조건으로 시작하기" }));
    expect(screen.getByRole("alert")).toHaveTextContent("나이를");
  });

  it("다시 방문하면 저장된 조건으로 바로 상담 화면이 열린다", () => {
    localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(savedProfile));
    renderApp();
    expect(screen.getByRole("log", { name: "상담 내용" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "어르신이 받을 수 있는 연금" })).toBeInTheDocument();
  });

  it("내 정보 지우기를 누르면 저장된 조건이 삭제된다", async () => {
    localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(savedProfile));
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "내 조건" }));
    await user.click(screen.getByRole("button", { name: "내 정보 지우기" }));
    expect(localStorage.getItem(STORAGE_KEYS.profile)).toBeNull();
  });

  it("추천 질문 버튼만으로 대화를 이어갈 수 있다 (FR-3)", async () => {
    localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(savedProfile));
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "어르신이 받을 수 있는 연금" }));

    const log = screen.getByRole("log", { name: "상담 내용" });
    expect(await within(log).findByRole("heading", { name: "기초연금" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "기초연금 신청 방법" }));
    expect(await within(log).findByText("확인이 필요해요")).toBeInTheDocument();
  });

  it("근거가 없는 질문에는 연락처와 상담원 연결 버튼을 보여준다 (FR-4)", async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "나중에 입력할게요" }));
    await user.type(screen.getByLabelText("궁금한 내용"), "반려동물 미용 할인");
    await user.click(screen.getByRole("button", { name: "질문 보내기" }));

    expect(await screen.findByText("확인이 필요해요")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /129/ }).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "상담원 연결 요청" }));
    expect(screen.getByText(/상담원 연결 요청을 받았어요/)).toBeInTheDocument();
  });

  it("질문하면 지난 상담에 요약이 쌓이고 원문을 펼쳐볼 수 있다 (FR-5)", async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "나중에 입력할게요" }));
    await user.click(screen.getByRole("button", { name: "일자리를 찾고 있어요" }));

    const history = screen.getByRole("complementary", { name: "지난 상담" });
    expect(await within(history).findByText("일자리를 찾고 있어요")).toBeInTheDocument();
    expect(within(history).getByText(/안내$/)).toBeInTheDocument();
    expect(within(history).getByText("원문 펼쳐보기")).toBeInTheDocument();

    await user.click(within(history).getByRole("button", { name: "기록 지우기" }));
    expect(within(history).getByText(/아직 상담 기록이 없어요/)).toBeInTheDocument();
  });
});
