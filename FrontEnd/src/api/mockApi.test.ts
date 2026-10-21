import { createMockApi } from "./mockApi";
import type { UserProfile } from "./types";

const senior: UserProfile = {
  age: 70,
  income: "under50",
  household: "single",
  region: "서울특별시",
  disability: false,
};

describe("mockApi.ask", () => {
  it("관련 서비스가 있으면 answer와 서비스 카드를 돌려준다", async () => {
    const api = createMockApi({ latencyMs: 0 });
    const result = await api.ask("어르신 연금", senior);
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.services.map((s) => s.name)).toContain("기초연금");
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("조건과 맞지 않는 대상 제도는 질문에 그 대상이 없으면 빼고, 직접 물으면 안내한다", async () => {
    const api = createMockApi({ latencyMs: 0 });
    const general = await api.ask("어르신 연금", senior);
    if (general.kind !== "answer") throw new Error("answer 기대");
    expect(general.services.map((s) => s.name)).not.toContain("장애인연금");

    const explicit = await api.ask("장애인 연금", senior);
    if (explicit.kind !== "answer") throw new Error("answer 기대");
    expect(explicit.services.map((s) => s.name)).toContain("장애인연금");
  });

  it("근거가 없는 질문에는 추측하지 않고 연락처를 안내한다 (FR-4)", async () => {
    const api = createMockApi({ latencyMs: 0 });
    const result = await api.ask("반려동물 미용 할인", null);
    expect(result.kind).toBe("fallback");
    if (result.kind !== "fallback") return;
    expect(result.contacts.some((c) => c.phone === "129")).toBe(true);
  });

  it("신청 방법 정보가 없는 서비스는 해당 서비스 담당 연락처로 안내한다", async () => {
    const api = createMockApi({ latencyMs: 0 });
    const result = await api.ask("기초연금 신청 방법", null);
    expect(result.kind).toBe("fallback");
    if (result.kind !== "fallback") return;
    expect(result.contacts.map((c) => c.label)).toContain("국민연금공단");
  });

  it("신청 방법 정보가 있으면 그 내용으로 답한다", async () => {
    const api = createMockApi({ latencyMs: 0 });
    const programs = await api.listPrograms();
    const updated = programs.map((p) =>
      p.name === "기초연금" ? { ...p, howToApply: "주민센터 방문 또는 복지로 온라인 신청" } : p,
    );
    await api.savePrograms(updated);
    const result = await api.ask("기초연금 신청 방법", null);
    expect(result.kind).toBe("answer");
    expect(result.text).toContain("주민센터 방문 또는 복지로 온라인 신청");
  });
});

describe("mockApi 관리", () => {
  it("관리자가 추가한 제도가 이용자 검색에 반영된다 (FR-6)", async () => {
    const api = createMockApi({ latencyMs: 0 });
    const programs = await api.listPrograms();
    await api.savePrograms([
      ...programs,
      {
        id: "LOCAL-1",
        name: "행복복지관 반찬나눔",
        summary: "홀로 사는 어르신께 주 2회 반찬을 전달합니다.",
        ministry: "행복복지관",
        department: "사례관리팀",
        contacts: [{ label: "행복복지관 사례관리팀", phone: "02-000-0000" }],
        url: "",
        updatedAt: "2026-10-21",
        category: "생활",
        keywords: ["반찬", "식사"],
        eligibility: "",
        benefit: "",
        howToApply: "",
      },
    ]);
    const result = await createMockApi({ latencyMs: 0 }).ask("반찬 지원", null);
    expect(result.kind).toBe("answer");
    if (result.kind !== "answer") return;
    expect(result.services[0].name).toBe("행복복지관 반찬나눔");
  });

  it("삭제한 제도는 더 이상 검색되지 않는다", async () => {
    const api = createMockApi({ latencyMs: 0 });
    const programs = await api.listPrograms();
    await api.savePrograms(programs.filter((p) => p.name !== "에너지바우처"));
    const result = await api.ask("에너지바우처", null);
    if (result.kind === "answer") {
      expect(result.services.map((s) => s.name)).not.toContain("에너지바우처");
    }
  });

  it("조건에 맞는 첫 추천 질문을 만든다", () => {
    const api = createMockApi({ latencyMs: 0 });
    expect(api.initialSuggestions(senior).join(" ")).toContain("어르신");
    expect(api.initialSuggestions(null).length).toBeGreaterThan(0);
  });
});
