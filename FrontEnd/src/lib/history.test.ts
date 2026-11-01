import { appendHistory, buildEntry, loadHistory, type HistoryEntry } from "./history";
import { STORAGE_KEYS } from "./storage";

const entry = (index: number): HistoryEntry => ({ id: `id-${index}`, at: `2026-11-01T00:00:${String(index).padStart(2,"0")}Z`,
  question: "2026년 129 기준", summary: "14일 안내", answerText: "1355에 문의", fallback: false });

afterEach(() => vi.restoreAllMocks());

it("기존 이력의 세 문자열을 정제·재저장하고 순서·시각·ID와 최대 50건을 보존한다", () => {
  const raw = Array.from({ length: 52 }, (_, i) => entry(i));
  raw[0] = { ...raw[0], question: "991399-1234567", summary: "010-0000-0000", answerText: "계좌번호: 321-00-000001" };
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(raw));
  const safe = loadHistory();
  expect(safe).toHaveLength(50);
  expect(safe[0]).toEqual({ ...raw[0], question: "[개인정보 가림]", summary: "[개인정보 가림]", answerText: "[개인정보 가림]" });
  expect(safe.slice(1)).toEqual(raw.slice(1,50));
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.history)!)).toEqual(safe);
  expect(loadHistory()).toEqual(safe);
});

it("새 이력 저장도 정제하고 빈 연락처 요약에 괄호를 만들지 않는다", () => {
  const built = buildEntry("가상 010-0000-0000", { kind: "fallback", text: "991399-1234567", contacts: [], suggestions: [] });
  expect(built.summary).toBe("문서에서 확인하지 못한 질문");
  expect(built.question).not.toContain("010-");
  const safe = appendHistory({ ...entry(1), answerText: "계좌 123456789" });
  expect(safe[0].answerText).toBe("[개인정보 가림]");
  expect(loadHistory()).toEqual(safe);
});

it.each(["{broken", "null", "{}", '[{"question":"991399-1234567"}]'])("손상 이력에서 원문을 표시하지 않고 앱 동작을 유지한다: %s", raw => {
  localStorage.setItem(STORAGE_KEYS.history, raw);
  expect(loadHistory()).toEqual([]);
});

it("재저장 거부 시에도 표시되는 기존 이력은 정제한다", () => {
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify([{ ...entry(0), question: "010-0000-0000" }]));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("가상 저장 제한"); });
  expect(loadHistory()[0].question).toBe("[개인정보 가림]");
  expect(loadHistory()[0].question).toBe("[개인정보 가림]");
  expect(appendHistory(entry(1))).toHaveLength(2);
});
