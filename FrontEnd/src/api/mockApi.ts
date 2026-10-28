import seedPrograms from "./programs.json";
import { ApiError } from "./errors";
import type {
  AdminProgram,
  ChatAnswer,
  Contact,
  Department,
  MonthlyStat,
  ProgramInput,
  UserProfile,
  WelfareApi,
  WelfareProgram,
} from "./types";
import { describeProfile } from "../lib/profile";
import { STORAGE_KEYS, readJson, writeJson } from "../lib/storage";

const GENERAL_CONTACT: Contact = { label: "보건복지상담센터", phone: "129" };
const DIRECT_MATCH_SCORE = 10;
const MIN_SCORE = 3;
const MAX_RESULTS = 3;

const STOPWORDS = new Set([
  "지원", "서비스", "받을", "있는", "있나요", "있을까요", "어떻게", "방법", "신청", "문의처", "문의",
  "다른", "알려줘", "알려주세요", "조건", "자격", "대상", "제가", "저는", "필요해요", "궁금해요",
]);

const MOCK_STATS: MonthlyStat[] = [
  { month: "2026-05", inquiries: 412, connections: 61 },
  { month: "2026-06", inquiries: 458, connections: 57 },
  { month: "2026-07", inquiries: 503, connections: 49 },
  { month: "2026-08", inquiries: 547, connections: 52 },
  { month: "2026-09", inquiries: 621, connections: 44 },
  { month: "2026-10", inquiries: 389, connections: 27 },
];

const normalize = (text: string) => text.replace(/\s+/g, "").toLowerCase();

function tokenize(query: string): string[] {
  return query
    .split(/[\s,.?!·()]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const MISMATCH_PENALTY = 4;

function profileBoost(program: WelfareProgram, profile: UserProfile | null, query: string): number {
  if (!profile) return 0;
  const has = (...words: string[]) => words.some((w) => program.keywords.includes(w));
  const asked = (...words: string[]) => words.some((w) => query.includes(w));
  let boost = 0;
  if (profile.age >= 65 && has("노인", "어르신")) boost += 1;
  if (profile.age >= 19 && profile.age <= 34 && has("청년")) boost += 1;
  if (profile.disability && has("장애")) boost += 1;
  if (profile.household === "singleParent" && has("한부모")) boost += 1;
  if (profile.household === "withChildren" && has("아이", "아동")) boost += 1;
  if (!profile.disability && has("장애") && !asked("장애")) boost -= MISMATCH_PENALTY;
  if (profile.age >= 40 && has("청년") && !asked("청년")) boost -= MISMATCH_PENALTY;
  if (profile.age < 60 && has("노인", "어르신") && !asked("노인", "어르신")) boost -= MISMATCH_PENALTY;
  return boost;
}

function scoreProgram(program: WelfareProgram, query: string, tokens: string[]): number {
  let score = normalize(query).includes(normalize(program.name)) ? DIRECT_MATCH_SCORE : 0;
  for (const token of tokens) {
    if (program.name.includes(token)) score += 3;
    if (program.keywords.some((kw) => token.includes(kw) || kw.includes(token))) score += 2;
    if (token.includes(program.category)) score += 2;
    if (program.summary.includes(token)) score += 1;
  }
  return score;
}

function uniqueContacts(contacts: Contact[]): Contact[] {
  const seen = new Set<string>();
  return contacts.filter((c) => {
    const key = c.phone || c.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function followUps(program: WelfareProgram): string[] {
  return [`${program.name} 신청 방법`, `${program.name} 받을 수 있는 조건`, `${program.name} 문의처`];
}

function detailAnswer(
  program: WelfareProgram,
  field: "howToApply" | "eligibility",
  title: string,
  suggestions: string[],
): ChatAnswer {
  const value = program[field].trim();
  if (value) {
    return { kind: "answer", text: `${program.name} ${title}: ${value}`, services: [program], suggestions };
  }
  return {
    kind: "fallback",
    text: `${program.name}의 ${title}은(는) 확인된 정보가 없어 추측해서 안내하지 않을게요. 아래 담당 기관에 문의하면 정확하게 안내받을 수 있어요.`,
    contacts: uniqueContacts([...program.contacts, GENERAL_CONTACT]),
    suggestions,
  };
}

type MockProgram = WelfareProgram & {
  programId: number;
  externalServiceId: string | null;
  sourceUpdatedAt: string | null;
  testOnly: boolean;
  documentCount: number;
  publishedCount: number;
};

function withAdminFields(records: WelfareProgram[]): MockProgram[] {
  let next = records.reduce((max, r) => Math.max(max, (r as Partial<MockProgram>).programId ?? 0), 0);
  return records.map((record) => {
    const r = record as WelfareProgram & Partial<MockProgram>;
    return {
      ...record,
      programId: r.programId ?? ++next,
      externalServiceId: r.externalServiceId !== undefined ? r.externalServiceId : record.id.startsWith("WLF") ? record.id : null,
      sourceUpdatedAt: r.sourceUpdatedAt !== undefined ? r.sourceUpdatedAt : record.updatedAt || null,
      testOnly: r.testOnly ?? false,
      documentCount: r.documentCount ?? 0,
      publishedCount: r.publishedCount ?? 0,
    };
  });
}

function departmentsOf(records: WelfareProgram[]): Department[] {
  const pairs = new Map<string, { ministry: string; name: string }>();
  for (const r of records) pairs.set(JSON.stringify([r.ministry, r.department]), { ministry: r.ministry, name: r.department });
  return [...pairs.values()]
    .sort((a, b) => a.ministry.localeCompare(b.ministry, "ko") || a.name.localeCompare(b.name, "ko"))
    .map((d, i) => ({ id: i + 1, ...d }));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createMockApi(options: { latencyMs?: number; seed?: WelfareProgram[] } = {}): WelfareApi {
  const latencyMs = options.latencyMs ?? 600;
  const seed = options.seed ?? (seedPrograms as WelfareProgram[]);
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, latencyMs));
  const loadAll = () => withAdminFields(readJson<WelfareProgram[]>(STORAGE_KEYS.programs, seed));
  const load = () => loadAll().filter((p) => !p.testOnly);
  const save = (records: MockProgram[]) => writeJson(STORAGE_KEYS.programs, records);
  const departments = () => departmentsOf([...seed, ...loadAll()]);

  function toAdmin(record: MockProgram): AdminProgram {
    const department = departments().find((d) => d.ministry === record.ministry && d.name === record.department);
    return {
      programId: record.programId,
      serviceId: record.externalServiceId ?? `PROGRAM_${record.programId}`,
      externalServiceId: record.externalServiceId,
      name: record.name,
      summary: record.summary,
      departmentId: department?.id ?? 0,
      departmentName: record.department,
      ministryName: record.ministry,
      contacts: record.contacts,
      sourceUrl: record.url || null,
      sourceUpdatedAt: record.sourceUpdatedAt,
      testOnly: record.testOnly,
      updatedAt: record.updatedAt,
      documentCount: record.documentCount,
      publishedCount: record.publishedCount,
    };
  }

  function apply(record: MockProgram, changes: Partial<ProgramInput>): MockProgram {
    const department = changes.departmentId === undefined ? undefined : departments().find((d) => d.id === changes.departmentId);
    if (changes.departmentId !== undefined && !department) throw new ApiError("department_not_found", 422, "department_not_found");
    const externalServiceId = changes.externalServiceId !== undefined ? changes.externalServiceId : record.externalServiceId;
    return {
      ...record,
      id: externalServiceId ?? `PROGRAM_${record.programId}`,
      externalServiceId,
      name: changes.name ?? record.name,
      summary: changes.summary ?? record.summary,
      ministry: department?.ministry ?? record.ministry,
      department: department?.name ?? record.department,
      contacts: changes.contacts ?? record.contacts,
      url: changes.sourceUrl !== undefined ? (changes.sourceUrl ?? "") : record.url,
      sourceUpdatedAt: changes.sourceUpdatedAt !== undefined ? changes.sourceUpdatedAt : record.sourceUpdatedAt,
      testOnly: changes.testOnly ?? record.testOnly,
      updatedAt: today(),
    };
  }

  function find(records: MockProgram[], programId: number): MockProgram {
    const record = records.find((r) => r.programId === programId);
    if (!record) throw new ApiError("program_not_found", 404, "program_not_found");
    return record;
  }

  function initialSuggestions(profile: UserProfile | null): string[] {
    const picks: string[] = [];
    if (profile) {
      if (profile.age >= 65) picks.push("어르신이 받을 수 있는 연금");
      if (profile.age >= 19 && profile.age <= 34) picks.push("청년 주거 지원");
      if (profile.disability) picks.push("장애인 지원 서비스");
      if (profile.household === "singleParent") picks.push("한부모 양육 지원");
      if (profile.household === "withChildren") picks.push("아이 돌봄 지원");
    }
    picks.push("생활비가 부족해요", "병원비가 걱정돼요", "일자리를 찾고 있어요");
    return [...new Set(picks)].slice(0, 4);
  }

  return {
    initialSuggestions,

    async ask(query, profile) {
      await wait();
      const tokens = tokenize(query);
      const ranked = load()
        .map((program) => {
          const base = scoreProgram(program, query, tokens);
          return { program, base, score: base > 0 ? base + profileBoost(program, profile, query) : 0 };
        })
        .sort((a, b) => b.score - a.score);

      const direct = ranked.find((r) => r.base >= DIRECT_MATCH_SCORE);
      if (direct) {
        const p = direct.program;
        const suggestions = followUps(p);
        if (query.includes("신청")) return detailAnswer(p, "howToApply", "신청 방법", suggestions);
        if (/자격|조건|대상/.test(query)) return detailAnswer(p, "eligibility", "신청 자격", suggestions);
        if (/문의|연락|전화/.test(query)) {
          const list = p.contacts.map((c) => `${c.label} ${c.phone}`.trim()).join(", ");
          return { kind: "answer", text: `${p.name} 문의처는 ${list}입니다.`, services: [p], suggestions };
        }
      }

      const hits = ranked.filter((r) => r.score >= MIN_SCORE).slice(0, MAX_RESULTS);
      if (hits.length === 0) {
        const weak = ranked.filter((r) => r.score > 0).slice(0, 2);
        return {
          kind: "fallback",
          text: "질문에 맞는 정보를 확실하게 찾지 못했어요. 잘못된 안내를 드리지 않도록 추측해서 답하지 않을게요. 아래 연락처로 문의하면 정확하게 안내받을 수 있어요.",
          contacts: uniqueContacts([...weak.flatMap((r) => r.program.contacts), GENERAL_CONTACT]),
          suggestions: initialSuggestions(profile),
        };
      }

      const services = hits.map((r) => r.program);
      const prefix = profile ? `${describeProfile(profile)} 조건을 참고해 ` : "";
      return {
        kind: "answer",
        text: `${prefix}관련된 복지서비스 ${services.length}개를 찾았어요. 실제로 받을 수 있는지는 담당 기관에서 최종 확인해 주세요.`,
        services,
        suggestions: followUps(services[0]),
      };
    },

    async listPrograms(query = "") {
      const needle = query.trim().toLowerCase();
      const items = loadAll()
        .filter(
          (r) => !needle || [r.name, r.department, r.ministry, r.externalServiceId ?? ""].some((v) => v.toLowerCase().includes(needle)),
        )
        .map(toAdmin);
      return { items, hasMore: false };
    },

    async listDepartments() {
      return departments();
    },

    async createProgram(input) {
      const records = loadAll();
      const programId = records.reduce((max, r) => Math.max(max, r.programId), 0) + 1;
      const blank: MockProgram = {
        id: "",
        name: "",
        summary: "",
        ministry: "",
        department: "",
        contacts: [],
        url: "",
        updatedAt: today(),
        category: "",
        keywords: [],
        eligibility: "",
        benefit: "",
        howToApply: "",
        programId,
        externalServiceId: null,
        sourceUpdatedAt: null,
        testOnly: false,
        documentCount: 0,
        publishedCount: 0,
      };
      const created = apply(blank, input);
      save([created, ...records]);
      return toAdmin(created);
    },

    async updateProgram(program, changes) {
      const records = loadAll();
      const current = find(records, program.programId);
      const renamed =
        (changes.name !== undefined && changes.name !== current.name) ||
        (changes.externalServiceId !== undefined && changes.externalServiceId !== current.externalServiceId);
      if (renamed && current.documentCount > 0) throw new ApiError("program_has_documents", 409, "program_has_documents");
      const updated = apply(current, changes);
      save(records.map((r) => (r.programId === updated.programId ? updated : r)));
      return toAdmin(updated);
    },

    async deleteProgram(programId) {
      const records = loadAll();
      if (find(records, programId).documentCount > 0) throw new ApiError("program_has_documents", 409, "program_has_documents");
      save(records.filter((r) => r.programId !== programId));
    },

    async getMonthlyStats() {
      return MOCK_STATS;
    },
  };
}

