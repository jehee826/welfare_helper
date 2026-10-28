export interface Contact {
  label: string;
  phone: string;
}

export interface WelfareProgram {
  id: string;
  name: string;
  summary: string;
  ministry: string;
  department: string;
  contacts: Contact[];
  url: string;
  updatedAt: string;
  category: string;
  keywords: string[];
  eligibility: string;
  benefit: string;
  howToApply: string;
}

export type IncomeBracket = "under50" | "under100" | "under150" | "over150" | "unknown";
export type Household = "single" | "couple" | "withChildren" | "singleParent" | "grandparent" | "other";

export interface UserProfile {
  age: number;
  income: IncomeBracket;
  household: Household;
  region: string;
  disability: boolean;
}

export type ChatAnswer =
  | { kind: "answer"; text: string; services: WelfareProgram[]; suggestions: string[] }
  | { kind: "fallback"; text: string; contacts: Contact[]; suggestions: string[] };

export interface MonthlyStat {
  month: string;
  inquiries: number;
  connections: number;
}

export interface Department {
  id: number;
  name: string;
  ministry: string;
}

export interface AdminProgram {
  programId: number;
  serviceId: string;
  externalServiceId: string | null;
  name: string;
  summary: string;
  departmentId: number;
  departmentName: string;
  ministryName: string;
  contacts: Contact[];
  sourceUrl: string | null;
  sourceUpdatedAt: string | null;
  testOnly: boolean;
  updatedAt: string;
  documentCount: number;
  publishedCount: number;
}

export interface ProgramInput {
  name: string;
  summary: string;
  departmentId: number;
  externalServiceId: string | null;
  sourceUrl: string | null;
  sourceUpdatedAt: string | null;
  contacts: Contact[];
  testOnly: boolean;
}

export interface ProgramPage {
  items: AdminProgram[];
  hasMore: boolean;
}

export interface WelfareApi {
  ask(query: string, profile: UserProfile | null): Promise<ChatAnswer>;
  initialSuggestions(profile: UserProfile | null): string[];
  listPrograms(query?: string): Promise<ProgramPage>;
  listDepartments(): Promise<Department[]>;
  createProgram(input: ProgramInput): Promise<AdminProgram>;
  updateProgram(program: AdminProgram, changes: Partial<ProgramInput>): Promise<AdminProgram>;
  deleteProgram(programId: number): Promise<void>;
  getMonthlyStats(): Promise<MonthlyStat[]>;
}
