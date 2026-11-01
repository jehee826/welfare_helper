import { act, render, screen } from "@testing-library/react";
import { ApiError, createHttpApi } from "../../api/httpApi";
import { createMockApi } from "../../api/mockApi";
import type { MonthlyStat } from "../../api/types";
import { StatsPanel } from "./StatsPanel";

function deferred() {
  let resolve!: (stats: MonthlyStat[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<MonthlyStat[]>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.unstubAllGlobals(); });

it("운영 통계는 로딩 뒤 미연동을 알리고 수치나 상담원 연결을 만들어내지 않는다", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<StatsPanel api={createHttpApi()} />);
  expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");
  expect(await screen.findByText("실제 문의·상담원 연결 통계는 제공하지 않습니다.")).toBeInTheDocument();
  expect(screen.getByText("이용 통계는 아직 서버와 연동되지 않았습니다.")).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByText(/0건|해결한 비율/)).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("실패는 안전한 오류로 표시하며 원시 오류나 목업 수치를 표시하지 않는다", async () => {
  const pending = deferred();
  render(<StatsPanel api={{ ...createMockApi(), getMonthlyStats: () => pending.promise }} />);
  await act(async () => { pending.reject(new Error("private-stack-marker")); });
  expect(screen.getByRole("alert")).toHaveTextContent("통계를 불러오지 못했습니다");
  expect(screen.queryByText(/private-stack-marker/)).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("빈 응답은 영구 로딩이나 가짜 0건 대신 빈 상태를 표시한다", async () => {
  render(<StatsPanel api={{ ...createMockApi(), getMonthlyStats: async () => [] }} />);
  expect(await screen.findByText("표시할 통계가 없습니다.")).toBeInTheDocument();
  expect(screen.queryByText(/불러오는 중|0건/)).not.toBeInTheDocument();
});

it("직접 주입한 테스트 통계는 운영 미연동과 테스트 자료임을 함께 표시한다", async () => {
  render(<StatsPanel api={createMockApi({ latencyMs: 0 })} />);
  expect(await screen.findByRole("table", { name: "테스트용 월별 문의와 연결 건수" })).toBeInTheDocument();
  expect(screen.getByText(/아래 값은 테스트로 전달된 자료/)).toBeInTheDocument();
  expect(screen.getByText("이용 통계는 아직 서버와 연동되지 않았습니다.")).toBeInTheDocument();
  expect(screen.queryByText(/해결한 비율/)).not.toBeInTheDocument();
});

it("API가 바뀌면 이전 완료 결과를 숨기고 새 상태를 기다린다", async () => {
  const first = deferred(), second = deferred();
  const a = { ...createMockApi(), getMonthlyStats: () => first.promise };
  const b = { ...createMockApi(), getMonthlyStats: () => second.promise };
  const view = render(<StatsPanel api={a} />);
  await act(async () => { first.resolve([{ month: "이전 자료", inquiries: 10, connections: 2 }]); });
  expect(screen.getByText("이전 자료")).toBeInTheDocument();
  view.rerender(<StatsPanel api={b} />);
  expect(screen.queryByText("이전 자료")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");
  await act(async () => { second.reject(new ApiError("미연동", 503, "stats_unavailable")); });
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByText("실제 문의·상담원 연결 통계는 제공하지 않습니다.")).toBeInTheDocument();
});

it("이전 API의 늦은 응답이 새 API의 결과를 덮지 않는다", async () => {
  const pending = deferred();
  const view = render(<StatsPanel api={{ ...createMockApi(), getMonthlyStats: () => pending.promise }} />);
  view.rerender(<StatsPanel api={{ ...createMockApi(), getMonthlyStats: async () => [] }} />);
  await screen.findByText("표시할 통계가 없습니다.");
  await act(async () => { pending.resolve([{ month: "이전 서버", inquiries: 10, connections: 2 }]); });
  expect(screen.queryByText("이전 서버")).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByText("표시할 통계가 없습니다.")).toBeInTheDocument();
});

for (const outcome of ["resolve", "reject"] as const) it(`해제 뒤 ${outcome}는 다시 열린 패널에 반영하지 않는다`, async () => {
  const pending = deferred();
  const view = render(<StatsPanel api={{ ...createMockApi(), getMonthlyStats: () => pending.promise }} />);
  view.unmount();
  render(<StatsPanel api={createHttpApi()} />);
  await act(async () => {
    if (outcome === "resolve") pending.resolve([{ month: "늦은 자료", inquiries: 99, connections: 3 }]);
    else pending.reject(new Error("late-private-marker"));
  });
  expect(screen.queryByText(/늦은 자료|late-private-marker/)).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByText("실제 문의·상담원 연결 통계는 제공하지 않습니다.")).toBeInTheDocument();
});
