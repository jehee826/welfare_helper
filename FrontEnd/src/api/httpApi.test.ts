import { ApiError, createHttpApi } from "./httpApi";
import { createMockApi } from "./mockApi";
import type { AdminProgram } from "./types";

const rawProgram = {
  program_id: 7,
  service_id: "WLF00001164",
  external_service_id: "WLF00001164",
  program_name: "기초연금",
  summary: "노인 생활 안정",
  department_id: 3,
  department_name: "기초연금과",
  ministry_name: "보건복지부",
  contacts: [{ label: "국민연금공단", phone: "1355" }],
  source_url: "https://www.bokjiro.go.kr/x",
  source_updated_at: "2025-03-25",
  test_only: false,
  updated_at: "2026-10-28T01:02:03.456789+00:00",
  document_count: 1,
  published_count: 0,
};

const program: AdminProgram = {
  programId: 7,
  serviceId: "WLF00001164",
  externalServiceId: "WLF00001164",
  name: "기초연금",
  summary: "노인 생활 안정",
  departmentId: 3,
  departmentName: "기초연금과",
  ministryName: "보건복지부",
  contacts: [{ label: "국민연금공단", phone: "1355" }],
  sourceUrl: "https://www.bokjiro.go.kr/x",
  sourceUpdatedAt: "2025-03-25",
  testOnly: false,
  updatedAt: "2026-10-28T01:02:03.456789+00:00",
  documentCount: 1,
  publishedCount: 0,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  responses.forEach((r) => fetchMock.mockResolvedValueOnce(r));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const api = () => createHttpApi({ fallback: createMockApi({ latencyMs: 0 }) });

describe("httpApi 채팅", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("질문과 조건을 /api/v1/chat에 보내고 응답을 그대로 돌려준다", async () => {
    const answer = { kind: "fallback", text: "확인 필요", contacts: [{ label: "보건복지상담센터", phone: "129" }], suggestions: [] };
    const fetchMock = stubFetch(json(answer));

    const result = await api().ask("연금", null);

    expect(result).toEqual(answer);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/chat");
    expect(JSON.parse(init.body)).toEqual({ query: "연금", profile: null });
  });

  it("서버 오류면 서버가 준 안내 문구로 예외를 던진다", async () => {
    stubFetch(json({ detail: "보건복지상담센터 129로 문의해 주세요." }, 503));
    await expect(api().ask("연금", null)).rejects.toThrow("129");
  });
});

describe("httpApi 관리자 제도", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("검색어로 실제 제도 목록을 받아 화면 형식으로 바꾼다", async () => {
    const fetchMock = stubFetch(json({ items: [rawProgram], offset: 0, limit: 200, next_offset: 200 }));

    const page = await api().listPrograms("연금");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/programs?query=%EC%97%B0%EA%B8%88&limit=200");
    expect(page).toEqual({ items: [program], hasMore: true });
  });

  it("담당 부서 목록을 받는다", async () => {
    const fetchMock = stubFetch(json([{ department_id: 3, department_name: "기초연금과", ministry_name: "보건복지부" }]));
    expect(await api().listDepartments()).toEqual([{ id: 3, name: "기초연금과", ministry: "보건복지부" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/departments");
  });

  it("새 제도를 서버 형식으로 보낸다", async () => {
    const fetchMock = stubFetch(json(rawProgram, 201));

    const created = await api().createProgram({
      name: "기초연금",
      summary: "노인 생활 안정",
      departmentId: 3,
      externalServiceId: "WLF00001164",
      sourceUrl: "https://www.bokjiro.go.kr/x",
      sourceUpdatedAt: "2025-03-25",
      contacts: [{ label: "국민연금공단", phone: "1355" }],
      testOnly: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/admin/programs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      program_name: "기초연금",
      summary: "노인 생활 안정",
      department_id: 3,
      external_service_id: "WLF00001164",
      source_url: "https://www.bokjiro.go.kr/x",
      source_updated_at: "2025-03-25",
      contacts: [{ label: "국민연금공단", phone: "1355" }],
      test_only: false,
    });
    expect(created).toEqual(program);
  });

  it("수정은 바뀐 항목과 마지막으로 본 수정 시각만 보낸다", async () => {
    const fetchMock = stubFetch(json({ ...rawProgram, summary: "새 요약" }));

    const updated = await api().updateProgram(program, { summary: "새 요약" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/admin/programs/7");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ summary: "새 요약", expected_updated_at: program.updatedAt });
    expect(updated.summary).toBe("새 요약");
  });

  it("삭제 요청을 보낸다", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await api().deleteProgram(7);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/admin/programs/7");
    expect(init.method).toBe("DELETE");
  });

  it("서버가 거절하면 오류 코드를 담아 예외를 던진다", async () => {
    stubFetch(json({ detail: "program_has_documents" }, 409));
    const error = await api().deleteProgram(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "program_has_documents" });
  });

  it("입력 검증 오류는 invalid_request 코드로 바꾼다", async () => {
    stubFetch(json({ detail: [{ loc: ["body", "program_name"], msg: "too short" }] }, 422));
    await expect(api().listDepartments()).rejects.toMatchObject({ status: 422, code: "invalid_request" });
  });

  it("이용 통계는 아직 목업 데이터를 쓴다", async () => {
    const fetchMock = stubFetch();
    expect((await api().getMonthlyStats()).length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
