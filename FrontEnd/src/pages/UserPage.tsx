import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { createDocumentChatApi } from "../api/documentChatApi";
import { documentError, documentRequest, localDocumentAccess } from "../api/documentApi";
import type { DocumentStatus } from "../api/documentApi";
import type { ChatAnswer, UserProfile, WelfareApi } from "../api/types";
import { ChatPanel } from "../components/ChatPanel";
import { ConditionForm } from "../components/ConditionForm";
import { Header } from "../components/Header";
import { HistorySidebar } from "../components/HistorySidebar";
import { appendHistory, buildEntry, clearHistory, loadHistory } from "../lib/history";
import { describeProfile } from "../lib/profile";
import { STORAGE_KEYS, readJson, removeKey, writeJson } from "../lib/storage";

export function UserPage({ api, documentId }: { api: WelfareApi; documentId?: string }) {
  return documentId === undefined ? <WelfareUserPage api={api} /> : <DocumentUserPage key={documentId} documentId={documentId} />;
}

function DocumentUserPage({ documentId }: { documentId: string }) {
  const [document, setDocument] = useState<DocumentStatus | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<ReturnType<typeof loadHistory>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const api = useMemo(() => createDocumentChatApi(documentId), [documentId]);

  useEffect(() => {
    const controller = new AbortController();
    if (!localDocumentAccess()) {
      setError("문서 질문은 로컬 개발 주소에서 사용할 수 있습니다. 공개 문서 접근에는 서버 관리자 인증이 필요합니다.");
    } else if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(documentId)) {
      setError("올바른 문서 ID가 아닙니다. 문서 관리에서 게시된 문서를 다시 선택하세요.");
    } else {
      void documentRequest<DocumentStatus>(`/${documentId}?limit=1`, controller.signal).then(status => {
        if (controller.signal.aborted) return;
        if (!status.active_job_id || !status.jobs.some(job => job.job_id === status.active_job_id && job.state === "succeeded")) {
          setError("아직 게시된 원문이 없습니다. 문서 관리에서 처리 상태를 확인하세요.");
        } else {
          setDocument(status);
        }
      }).catch(cause => { if (!controller.signal.aborted) setError(documentError(cause)); });
    }
    return () => controller.abort();
  }, [documentId]);

  function handleAnswered(question: string, answer: ChatAnswer) {
    const entry = { ...buildEntry(question, answer), summary: answer.kind === "answer" ? "이 문서의 원문 답변" : "문서 근거 확인 필요" };
    setHistory(entries => [entry, ...entries].slice(0, 50));
  }

  return <div className="page">
    <Header>
      <Link to="/">일반 복지 상담으로 돌아가기</Link>
      <button type="button" className="btn btn--primary btn--sm history-toggle" aria-expanded={historyOpen} aria-controls="history-drawer" onClick={() => setHistoryOpen(value => !value)}>문서 대화 기록</button>
    </Header>
    <main className="user-layout">
      <div className="user-layout__main">
        <section className="card" aria-label="현재 문서 범위">
          <h1>{document ? `${document.name} 문서 질문` : "문서 질문"}</h1>
          <p>선택한 문서 한 건의 게시된 원문을 검색해 질문합니다. 복지 조건과 일반 상담 기록은 사용하지 않습니다.</p>
          <p className="muted small">문서 변경·새로고침·일반 상담으로 이동하면 이 문서의 대화는 초기화됩니다.</p>
          <Link to={`/admin/documents?document=${encodeURIComponent(documentId)}`}>문서 관리에서 확인</Link>
        </section>
        {error ? <p role="alert">{error}</p> : document
          ? <ChatPanel api={api} profile={null} documentName={document.name} onAnswered={handleAnswered} />
          : <p role="status">문서와 게시 상태를 확인하고 있습니다.</p>}
      </div>
      <div id="history-drawer" className={historyOpen ? "user-layout__side is-open" : "user-layout__side"}>
        <HistorySidebar entries={history} onClear={() => setHistory([])} onClose={() => setHistoryOpen(false)} />
      </div>
    </main>
  </div>;
}

function WelfareUserPage({ api }: { api: WelfareApi }) {
  const [profile, setProfile] = useState<UserProfile | null>(() => readJson<UserProfile | null>(STORAGE_KEYS.profile, null));
  const [editing, setEditing] = useState(profile === null);
  const [history, setHistory] = useState(loadHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatKey, setChatKey] = useState(0);

  function saveProfile(next: UserProfile) {
    writeJson(STORAGE_KEYS.profile, next);
    setProfile(next);
    setEditing(false);
    setChatKey((k) => k + 1);
  }

  function clearProfile() {
    removeKey(STORAGE_KEYS.profile);
    setProfile(null);
    setChatKey((k) => k + 1);
  }

  function handleAnswered(question: string, answer: ChatAnswer) {
    setHistory(appendHistory(buildEntry(question, answer)));
  }

  function handleClearHistory() {
    clearHistory();
    setHistory([]);
  }

  return (
    <div className="page">
      <Header>
        {!editing && (
          <button type="button" className="btn btn--soft btn--sm" onClick={() => setEditing(true)}>
            내 조건
          </button>
        )}
        <button
          type="button"
          className="btn btn--primary btn--sm history-toggle"
          aria-expanded={historyOpen}
          aria-controls="history-drawer"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          지난 상담
        </button>
      </Header>

      <main className="user-layout">
        <div className="user-layout__main">
          {editing ? (
            <ConditionForm
              initial={profile}
              onSubmit={saveProfile}
              onSkip={() => setEditing(false)}
              onClear={profile ? clearProfile : undefined}
            />
          ) : (
            <>
              <p className="profile-line">
                {profile ? (
                  <>
                    <span className="muted">내 조건</span> {describeProfile(profile)}
                  </>
                ) : (
                  <span className="muted">조건 없이 상담 중이에요. 조건을 입력하면 더 맞춤으로 안내해 드려요.</span>
                )}
              </p>
              <ChatPanel key={chatKey} api={api} profile={profile} onAnswered={handleAnswered} />
            </>
          )}
        </div>
        <div id="history-drawer" className={historyOpen ? "user-layout__side is-open" : "user-layout__side"}>
          <HistorySidebar entries={history} onClear={handleClearHistory} onClose={() => setHistoryOpen(false)} />
        </div>
      </main>
    </div>
  );
}
