import { describe, expect, it } from "vitest";
import { apiBase, parseChatResponse, queryLength } from "./chatApi";

describe("apiBase", () => {
  it("https 주소만 허용하고 없으면 localhost로 대체하지 않는다", () => {
    expect(apiBase("https://15.164.190.21/")).toBe("https://15.164.190.21");
    expect(apiBase("https://api.example.test/base/")).toBe("https://api.example.test/base");
    expect(apiBase(null)).toBeNull();
    expect(apiBase("  ")).toBeNull();
    expect(apiBase("http://localhost:8000")).toBeNull();
    expect(apiBase("https://user:pw@api.example.test")).toBeNull();
    expect(apiBase("not a url")).toBeNull();
  });
});

describe("parseChatResponse", () => {
  it("필요한 필드만 남기고 추가 필드는 무시한다", () => {
    expect(parseChatResponse({ kind: "answer", text: "답", evidence: [1], contacts: "x" })).toEqual({ kind: "answer", text: "답", contacts: [] });
  });

  it("형식이 다른 응답은 응답 오류로 본다", () => {
    expect(() => parseChatResponse({ kind: "other", text: "답" })).toThrow("response");
    expect(() => parseChatResponse({ kind: "answer" })).toThrow("response");
    expect(() => parseChatResponse(null)).toThrow("response");
  });
});

describe("queryLength", () => {
  it("앞뒤 공백을 빼고 코드 포인트로 센다", () => {
    expect(queryLength("  가나다  ")).toBe(3);
    expect(queryLength("😀")).toBe(1);
  });
});
