import { useEffect, useState } from "react";
import type { MonthlyStat, WelfareApi } from "../../api/types";

const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((1 - part / whole) * 100)}%`);

export function StatsPanel({ api }: { api: WelfareApi }) {
  const [stats, setStats] = useState<MonthlyStat[]>([]);

  useEffect(() => {
    void api.getMonthlyStats().then(setStats);
  }, [api]);

  if (stats.length === 0) return <p className="muted">통계를 불러오는 중이에요…</p>;
  const latest = stats[stats.length - 1];
  const previous = stats[stats.length - 2];

  return (
    <section className="card" aria-labelledby="stats-title">
      <h2 id="stats-title">이용 통계</h2>
      <p className="muted small">목업 데이터예요. 실제 수치는 상담 기록이 쌓이면 집계돼요.</p>
      <div className="tiles">
        <div className="tile">
          <p className="tile__label">{latest.month} 챗봇 문의</p>
          <p className="tile__value">{latest.inquiries.toLocaleString()}건</p>
        </div>
        <div className="tile">
          <p className="tile__label">{latest.month} 상담원 연결</p>
          <p className="tile__value">{latest.connections.toLocaleString()}건</p>
          {previous && <p className="tile__delta">전월 {previous.connections}건</p>}
        </div>
        <div className="tile">
          <p className="tile__label">챗봇으로 해결한 비율</p>
          <p className="tile__value">{percent(latest.connections, latest.inquiries)}</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">월별 문의와 상담원 연결 건수</caption>
          <thead>
            <tr>
              <th scope="col">월</th>
              <th scope="col" className="num">
                챗봇 문의
              </th>
              <th scope="col" className="num">
                상담원 연결
              </th>
              <th scope="col" className="num">
                챗봇 해결률
              </th>
            </tr>
          </thead>
          <tbody>
            {[...stats].reverse().map((s) => (
              <tr key={s.month}>
                <th scope="row">{s.month}</th>
                <td className="num">{s.inquiries.toLocaleString()}</td>
                <td className="num">{s.connections.toLocaleString()}</td>
                <td className="num">{percent(s.connections, s.inquiries)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
