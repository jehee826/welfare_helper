# 복지 RAG 챗봇 MVP 설계 (하위 프로젝트 ②+③)

- 작성일: 2026-10-21
- 상태: 승인됨
- 선행 문서: `docs/welfare-rag-pipeline-design.md`(상세 설계, 참고용), `docs/welfare-rag-features.md`(피처 선별)

## 1. 목표
복지로 CSV(`docs/한국사회보장정보원_복지서비스정보_20250722.csv`, 367건)를 기본 데이터로 RAG 챗봇을 구현하고, 배포된 웹사이트의 이용자 채팅(FR-1·3·4·5)이 실제 검색·답변으로 동작하게 한다. 관리자 화면은 목업을 유지한다.

## 2. 결정 사항
| 항목 | 결정 |
|---|---|
| LLM·임베딩 | 로컬 PC Ollama(`gemma3:4b`, `bge-m3`) + 터널로 공개, Vercel에는 `OLLAMA_BASE_URL` 등록 |
| 벡터 DB | Supabase Postgres + pgvector. 적재는 로컬에서 `python -m BackEnd.ingest.run` |
| 청킹 | 서비스당 overview 청크 1개(서비스명·분류·요약). CSV 요약이 최대 116자라 분할 없음 |
| 검색 | 서비스명 직접 언급(pin) + dense(pgvector 코사인). Ollama 장애 시 키워드 검색으로 대체 |
| FR-4 가드 | 유사도가 기준 미만이면 LLM을 호출하지 않고 연락처 안내. CSV에 없는 신청 방법·자격 질문도 연락처 안내 |
| 출처·연락처 | DB 값만 사용. LLM 답변에 자료에 없는 전화번호가 있으면 템플릿 문장으로 교체 |
| 응답 | 비스트리밍 JSON. 프론트 `ChatAnswer` 타입과 같은 모양 |
| 관리자 | 목업 유지 (다음 단계) |

## 3. 구성
```
BackEnd/
  core/settings.py   환경변수 설정
  core/db.py         DB 접속 (DATABASE_URL 우선, 없으면 DB_* )
  db/schema.sql      welfare_services, welfare_chunks(vector(1024))
  rag/text.py        텍스트 정규화, 대표문의 파싱, 검색 키
  rag/ollama.py      Ollama 임베딩·채팅 클라이언트
  rag/repository.py  스키마 생성, 적재, dense 검색, 전체 서비스 조회
  rag/chat.py        검색 → 판단 → 답변 생성 오케스트레이션
  ingest/csv_loader.py  CSV 읽기·검증, 청크 텍스트
  ingest/run.py      적재 CLI
  main.py            /health, /health/db, POST /api/v1/chat
FrontEnd/src/api/httpApi.ts  ask만 실제 API, 나머지는 목업 위임
```

## 4. API
`POST /api/v1/chat` 요청 `{ query: string(1~300자), profile: UserProfile | null }`
응답은 프론트의 `ChatAnswer`와 동일:
- `{ kind: "answer", text, services: WelfareProgram[], suggestions }`
- `{ kind: "fallback", text, contacts: Contact[], suggestions }`
DB를 읽지 못하면 503.

## 5. 테스트
- pytest: 대표문의 파싱, CSV 367건 적재 검증, 채팅 오케스트레이션(답변·FR-4·의도·LLM 장애·임베딩 장애), API
- Vitest: httpApi 요청·오류 처리
- 실제 데이터로 유사도 기준값을 보정하고 샘플 질문으로 확인
