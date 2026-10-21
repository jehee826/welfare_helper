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

export interface WelfareApi {
  ask(query: string, profile: UserProfile | null): Promise<ChatAnswer>;
  initialSuggestions(profile: UserProfile | null): string[];
  listPrograms(): Promise<WelfareProgram[]>;
  savePrograms(programs: WelfareProgram[]): Promise<void>;
  getMonthlyStats(): Promise<MonthlyStat[]>;
}
