import { render, screen } from "@testing-library/react";
import type { WelfareProgram } from "../api/types";
import { AnswerCard } from "./AnswerCard";

const service: WelfareProgram = {
  id: "PROGRAM_3",
  name: "행복 반찬나눔",
  summary: "홀로 사는 어르신께 반찬을 전달합니다.",
  ministry: "행복복지관",
  department: "사례관리팀",
  contacts: [],
  url: "",
  updatedAt: "",
  category: "",
  keywords: [],
  eligibility: "",
  benefit: "",
  howToApply: "",
};

describe("AnswerCard", () => {
  it("원자료 기준일이 없으면 빈 기준일 문구를 보여주지 않는다", () => {
    render(<AnswerCard text="안내" services={[service]} />);
    expect(screen.queryByText(/기준일/)).not.toBeInTheDocument();
  });

  it("원자료 기준일이 있으면 함께 보여준다", () => {
    render(<AnswerCard text="안내" services={[{ ...service, updatedAt: "2025-03-25" }]} />);
    expect(screen.getByText("기준일 2025-03-25")).toBeInTheDocument();
  });
});
