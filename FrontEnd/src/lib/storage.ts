export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    return;
  }
}

export const STORAGE_KEYS = {
  profile: "welfare.profile",
  history: "welfare.history",
  programs: "welfare.mock.programs",
  largeText: "welfare.largeText",
} as const;
