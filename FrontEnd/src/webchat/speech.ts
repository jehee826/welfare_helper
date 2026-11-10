import type { ChatResponse } from "./chatApi";

/** 기존 확장과 같은 규칙으로 기호를 정리해 읽기 쉬운 문장으로 만든다. */
export function speechText(text: string): string {
  return String(text || "")
    .split("\n")
    .map((line) =>
      line
        .replace(/[①-⑳]/g, (mark) => ` ${mark.charCodeAt(0) - 0x245f}번 `)
        .replace(/\s*~\s*/g, "부터 ")
        .replace(/(\d)([.,:-])(?=\d)/g, "$1\u0000$2")
        .replace(/\u0000([.,:-])|[^\p{L}\p{N}\s.,?!%]|(?<!\S)[.,:-](?!\S)/gu, (_match, kept: string | undefined) => kept || " ")
        .replace(/\s+([.,?!%])/g, "$1")
        .replace(/([.,?!])[.,?!]+/g, "$1")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line && !/^[.,?!%\s]+$/.test(line))
    .join("\n");
}

/** 긴 문장이 중간에 끊기지 않도록 180자 안쪽에서 나눈다. */
export function speechChunks(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split(/\n+/)) {
    let rest = line.trim();
    while (rest) {
      if (rest.length <= 180) {
        parts.push(rest);
        break;
      }
      const cut = [rest.lastIndexOf(". ", 179), rest.lastIndexOf(", ", 179), rest.lastIndexOf(" ", 179)].find((index) => index >= 60) ?? 179;
      parts.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
  }
  return parts;
}

export const spokenPhone = (phone: string) =>
  phone
    .split("-")
    .map((group) => group.split("").join(" "))
    .join(", ");

export const contactKindLabel = (kind: "general" | "service") => (kind === "general" ? "일반 복지상담" : "서비스 문의처");

/** 답변 본문과 연락처를 함께 읽을 문장을 만든다. */
export function spokenAnswer(response: ChatResponse): string {
  const contacts = response.contacts.map(
    (contact) => `${contactKindLabel(contact.kind)}, ${contact.label}. 전화 ${spokenPhone(contact.phone)}.${contact.hours ? ` ${contact.hours}.` : ""}`,
  );
  return [response.text, ...(contacts.length ? ["문의처 안내.", ...contacts] : [])].join("\n");
}
