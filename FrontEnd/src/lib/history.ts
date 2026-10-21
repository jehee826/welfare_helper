import type { ChatAnswer } from "../api/types";
import { STORAGE_KEYS, readJson, removeKey, writeJson } from "./storage";

export interface HistoryEntry {
  id: string;
  at: string;
  question: string;
  summary: string;
  answerText: string;
  fallback: boolean;
}

const MAX_ENTRIES = 50;

export function loadHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>(STORAGE_KEYS.history, []);
}

export function buildEntry(question: string, answer: ChatAnswer, now = new Date()): HistoryEntry {
  const summary =
    answer.kind === "answer"
      ? `${answer.services.map((s) => s.name).join(", ")} 안내`
      : `담당 기관 연락처 안내 (${answer.contacts.map((c) => c.label).join(", ")})`;
  return {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    at: now.toISOString(),
    question,
    summary,
    answerText: answer.text,
    fallback: answer.kind === "fallback",
  };
}

export function appendHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...loadHistory()].slice(0, MAX_ENTRIES);
  writeJson(STORAGE_KEYS.history, next);
  return next;
}

export function clearHistory(): void {
  removeKey(STORAGE_KEYS.history);
}
