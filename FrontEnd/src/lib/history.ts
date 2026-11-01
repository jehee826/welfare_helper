import type { ChatAnswer } from "../api/types";
import { STORAGE_KEYS, readJson, removeKey, writeJson } from "./storage";
import { maskText } from "./privacy";

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
  const raw = readJson<unknown>(STORAGE_KEYS.history, []);
  if (!Array.isArray(raw)) return [];
  const safe = raw.filter((entry): entry is HistoryEntry => !!entry &&
    ["id", "at", "question", "summary", "answerText"].every(key => typeof entry[key] === "string") &&
    typeof entry.fallback === "boolean").slice(0, MAX_ENTRIES).map(sanitizeEntry);
  if (JSON.stringify(safe) !== JSON.stringify(raw)) writeJson(STORAGE_KEYS.history, safe);
  return safe;
}

function sanitizeEntry(entry: HistoryEntry): HistoryEntry {
  return { id: entry.id, at: entry.at, fallback: entry.fallback,
    question: maskText(entry.question, true), summary: maskText(entry.summary, true),
    answerText: maskText(entry.answerText, true) };
}

export function buildEntry(question: string, answer: ChatAnswer, now = new Date()): HistoryEntry {
  const summary =
    answer.kind === "answer"
      ? `${answer.services.map((s) => s.name).join(", ")} 안내`
      : answer.contacts.length ? `담당 기관 연락처 안내 (${answer.contacts.map((c) => c.label).join(", ")})`
        : "문서에서 확인하지 못한 질문";
  return sanitizeEntry({
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    at: now.toISOString(),
    question,
    summary,
    answerText: answer.text,
    fallback: answer.kind === "fallback",
  });
}

export function appendHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = [sanitizeEntry(entry), ...loadHistory()].slice(0, MAX_ENTRIES);
  writeJson(STORAGE_KEYS.history, next);
  return next;
}

export function clearHistory(): void {
  removeKey(STORAGE_KEYS.history);
}
