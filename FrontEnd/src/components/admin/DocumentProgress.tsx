import { useEffect, useState } from "react";
import type { Job } from "../../api/documentApi";

const states: Record<string, { title: string; detail: string; step: number; tone: string }> = {
  queued: { title: "접수 완료 · 작업 대기", detail: "워커가 문서 분석을 시작할 차례를 기다리고 있습니다.", step: 0, tone: "working" },
  parsing: { title: "모델 준비·원문 분석 중", detail: "처음에는 분석 모델 준비·다운로드에 시간이 걸릴 수 있습니다. 세부 진행률과 남은 시간은 제공되지 않습니다.", step: 1, tone: "working" },
  awaiting_review: { title: "이전 검토 방식의 대기 작업", detail: "이 작업은 자동 재처리하지 않습니다. 같은 문서 ID로 원문을 다시 첨부하면 자동 처리합니다.", step: -1, tone: "attention" },
  embedding: { title: "자동 청크 분할·임베딩 중", detail: "원문 구조를 보존해 나눈 청크를 검색 근거로 저장하고 있습니다. 저장 건수는 서버에서 확인한 값입니다.", step: 2, tone: "working" },
  ready: { title: "저장 완료 · 게시 준비", detail: "문서와 작업의 일치 여부를 확인한 뒤 게시합니다.", step: 3, tone: "working" },
  succeeded: { title: "게시 완료", detail: "선택한 작업이 현재 게시본과 일치하면 검색과 질의를 사용할 수 있습니다.", step: 3, tone: "success" },
  failed: { title: "처리 실패 · 작업 종료", detail: "실패 원인을 해결한 뒤 다시 등록하세요. 이 작업은 더 이상 처리 중이 아닙니다.", step: -1, tone: "error" },
  cancelled: { title: "취소됨 · 작업 종료", detail: "후보가 취소됐습니다. 기존 게시본은 유지됩니다.", step: -1, tone: "error" },
};

export function jobFailureMessage(code: string) {
  if (code === "ModuleNotFoundError" || code === "document_dependency_missing") return "문서 분석에 필요한 서버 의존성이 누락됐습니다. 워커 구성을 수정한 뒤 파일을 다시 등록하세요.";
  if (code.includes("timeout")) return "서버의 단계별 처리 제한 시간을 넘었습니다. 워커 상태와 문서 크기·쪽 수를 확인한 뒤 다시 등록하세요.";
  if (code.includes("quality") || code.includes("ocr")) return "원문 분석 품질을 확인할 수 없습니다. 스캔·표·글자 상태를 확인하고 읽기 쉬운 원문으로 다시 등록하세요.";
  return "문서를 처리하지 못했습니다. 아래 오류 코드를 관리자에게 전달하고 원인을 해결한 뒤 다시 등록하세요.";
}

function dateLabel(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "미제공";
  return new Date(value).toLocaleString("ko-KR");
}

function duration(start?: string, end?: string | null, now = Date.now()) {
  if (!start || !Number.isFinite(Date.parse(start))) return "미제공";
  const elapsed = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  if (!Number.isFinite(elapsed)) return "미제공";
  return `${Math.floor(elapsed / 60)}분 ${elapsed % 60}초`;
}

export function DocumentProgress({ job, updatedAt, error }: { job: Job | null; updatedAt: number | null; error: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!job || ["failed", "cancelled", "succeeded", "awaiting_review"].includes(job.state)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job?.job_id, job?.state]);
  const state = error && job && !["failed", "cancelled"].includes(job.state)
    ? { title: "상태 갱신 지연 · 마지막 확인 정보", detail: "새 상태를 확인하지 못했습니다. 아래 시각은 마지막 성공한 조회 기준이며 검색은 잠시 중지됩니다.", step: -1, tone: "attention" }
    : job ? states[job.state] ?? { title: job.state, detail: "서버 상태를 확인하세요.", step: -1, tone: "attention" }
      : { title: error ? "상태 확인 중단" : "작업 상태 조회 중", detail: error ? "연결을 확인하고 상태를 다시 불러오세요." : "서버 응답을 기다리고 있습니다.", step: -1, tone: error ? "error" : "working" };
  return <div className={`document-progress document-progress--${state.tone}`}>
    <div role="status" aria-live="polite"><strong>{state.title}</strong><p>{state.detail}</p></div>
    <ol className="document-steps" aria-label="문서 처리 순서">
      {["접수", "모델 준비·분석", "청크 분할·임베딩", "게시"].map((label, i) => <li key={label} aria-current={i === state.step ? "step" : undefined} data-complete={state.step > i}>{label}</li>)}
    </ol>
    <dl className="document-metrics">
      <div><dt>접수 후 경과</dt><dd>{duration(job?.created_at, job?.finished_at, now)}</dd></div>
      <div><dt>저장 청크</dt><dd>{job?.progress?.stored ?? "미제공"}</dd></div>
      <div><dt>접수 시각</dt><dd>{dateLabel(job?.created_at)}</dd></div>
      <div><dt>마지막 상태 확인</dt><dd>{updatedAt ? new Date(updatedAt).toLocaleTimeString("ko-KR") : "미확인"}</dd></div>
    </dl>
    {job?.state === "failed" && <div role="alert"><p>{jobFailureMessage(job.error_code ?? "unknown")}</p><p>오류 코드: <code>{job.error_code ?? "미제공"}</code></p></div>}
  </div>;
}
