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

it("실제 모델 단계 오류를 DB 비밀번호 오류로 안내하지 않는다", () => {
  expect(new DocumentApiError(503, "document_generation_failed").message).toContain("답변 모델");
  expect(new DocumentApiError(503, "document_embedding_failed").message).toContain("질문 임베딩");
  expect(new DocumentApiError(503, "document_reranker_failed").message).toContain("순위 계산");
});
