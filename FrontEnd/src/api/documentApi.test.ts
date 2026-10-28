import { documentRequest, DocumentApiError } from "./documentApi";
afterEach(() => vi.unstubAllGlobals());

it("서버 예외 본문은 노출하지 않는다", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: "password=SECRET" }) }));
  await expect(documentRequest("/processing", new AbortController().signal)).rejects.toMatchObject({ status: 503, code: "http_503" });
  expect(new DocumentApiError(503, "http_503").message).not.toContain("SECRET");
});

it("자동 처리 DB 준비와 이전 작업 재등록 오류를 구분한다", () => {
  expect(new DocumentApiError(503, "automatic_processing_schema_required").message).toContain("0005");
  expect(new DocumentApiError(409, "legacy_review_requires_reupload").message).toContain("다시 첨부");
});
