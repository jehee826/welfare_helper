import { createHttpApi } from "./httpApi";
import { createMockApi } from "./mockApi";

describe("httpApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("질문과 조건을 /api/v1/chat에 보내고 응답을 그대로 돌려준다", async () => {
    const answer = { kind: "fallback", text: "확인 필요", contacts: [{ label: "보건복지상담센터", phone: "129" }], suggestions: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = createHttpApi({ fallback: createMockApi({ latencyMs: 0 }) });
    const result = await api.ask("연금", null);

    expect(result).toEqual(answer);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/chat");
    expect(JSON.parse(init.body)).toEqual({ query: "연금", profile: null });
  });

  it("서버 오류면 서버가 준 안내 문구로 예외를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "보건복지상담센터 129로 문의해 주세요." }), { status: 503 })),
    );
    const api = createHttpApi({ fallback: createMockApi({ latencyMs: 0 }) });
    await expect(api.ask("연금", null)).rejects.toThrow("129");
  });

  it("관리자 기능은 목업에 맡긴다", async () => {
    const api = createHttpApi({ fallback: createMockApi({ latencyMs: 0 }) });
    expect((await api.listPrograms()).length).toBe(20);
  });
});
