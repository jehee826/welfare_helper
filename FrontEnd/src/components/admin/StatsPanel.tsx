import { useEffect, useState } from "react";
import { ApiError } from "../../api/errors";
import type { MonthlyStat, WelfareApi } from "../../api/types";

type Result = { api: WelfareApi } & (
  | { status: "ready"; stats: MonthlyStat[] }
  | { status: "unavailable" | "error" }
);

export function StatsPanel({ api }: { api: WelfareApi }) {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let active = true;
    void api.getMonthlyStats().then(stats => {
      if (active) setResult({ api, status: "ready", stats });
    }).catch((error: unknown) => {
      if (active) setResult({ api, status: error instanceof ApiError && error.code === "stats_unavailable" ? "unavailable" : "error" });
    });
    return () => { active = false; };
  }, [api]);

  const current = result?.api === api ? result : null;
  return (
    <section className="card" aria-labelledby="stats-title" aria-busy={!current}>
      <h2 id="stats-title">이용 통계</h2>
      <p className="muted">이용 통계는 아직 서버와 연동되지 않았습니다.</p>
      {!current && <p role="status">통계를 불러오는 중이에요…</p>}
      {current?.status === "unavailable" && <p role="status">실제 문의·상담원 연결 통계는 제공하지 않습니다.</p>}
      {current?.status === "error" && <p role="alert">통계를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>}
      {current?.status === "ready" && (current.stats.length === 0 ? <p role="status">표시할 통계가 없습니다.</p> : (
        <>
          <p className="muted small">아래 값은 테스트로 전달된 자료입니다. 실제 상담원 연결 기능은 제공하지 않습니다.</p>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">테스트용 월별 문의와 연결 건수</caption>
              <thead><tr><th scope="col">월</th><th scope="col" className="num">문의</th><th scope="col" className="num">연결 집계(테스트)</th></tr></thead>
              <tbody>{[...current.stats].reverse().map(stat => (
                <tr key={stat.month}><th scope="row">{stat.month}</th><td className="num">{stat.inquiries.toLocaleString()}</td><td className="num">{stat.connections.toLocaleString()}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ))}
    </section>
  );
}
