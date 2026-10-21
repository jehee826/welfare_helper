import type { HistoryEntry } from "../lib/history";

interface Props {
  entries: HistoryEntry[];
  onClear: () => void;
  onClose?: () => void;
}

const formatter = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function HistorySidebar({ entries, onClear, onClose }: Props) {
  return (
    <aside className="history card" aria-labelledby="history-title">
      <div className="history__head">
        <h2 id="history-title" className="history__title">
          지난 상담
        </h2>
        {onClose && (
          <button type="button" className="icon-btn" aria-label="지난 상담 닫기" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="muted">아직 상담 기록이 없어요. 질문을 하면 여기에 요약이 쌓여요.</p>
      ) : (
        <>
          <ol className="history__list">
            {entries.map((e) => (
              <li key={e.id} className={e.fallback ? "history__item is-fallback" : "history__item"}>
                <p className="muted small">{formatter.format(new Date(e.at))}</p>
                <p className="history__question">{e.question}</p>
                <p className="history__summary">{e.summary}</p>
                <details>
                  <summary>원문 펼쳐보기</summary>
                  <p className="history__answer">{e.answerText}</p>
                </details>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>
            기록 지우기
          </button>
        </>
      )}
    </aside>
  );
}
