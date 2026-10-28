import { useState } from "react";
import type { ChatAnswer, UserProfile, WelfareApi } from "../api/types";
import { ChatPanel } from "../components/ChatPanel";
import { ConditionForm } from "../components/ConditionForm";
import { Header } from "../components/Header";
import { HistorySidebar } from "../components/HistorySidebar";
import { appendHistory, buildEntry, clearHistory, loadHistory } from "../lib/history";
import { describeProfile } from "../lib/profile";
import { STORAGE_KEYS, readJson, removeKey, writeJson } from "../lib/storage";

export function UserPage({ api }: { api: WelfareApi }) {
  const [profile, setProfile] = useState<UserProfile | null>(() => readJson<UserProfile | null>(STORAGE_KEYS.profile, null));
  const [editing, setEditing] = useState(false);
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
    const entry = buildEntry(question, answer);
    if (answer.kind === "answer" && !answer.services.length) entry.summary = "등록 문서 답변";
    setHistory(appendHistory(entry));
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
                  <span className="muted">등록된 문서의 원문을 검색해 답변합니다.</span>
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
