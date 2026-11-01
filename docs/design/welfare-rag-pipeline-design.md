# 복지서비스 RAG 파이프라인

갱신: 2026-11-01. 현재 소스 기준이다. 과거 CSV 자동 적재·수동 분류 승인 절차를 현재 경로로 사용하지 않는다.

## 실행 구성

- 웹: React/Vite. 로컬은 Vite, 공개 정적 프런트는 Vercel.
- API·문서 워커·Ollama: 같은 Docker Compose를 로컬 또는 EC2에서 실행한다.
- DB: Supabase PostgreSQL·pgvector. 앱은 자동 DDL이나 로컬 PostgreSQL 대체를 수행하지 않는다.
- 확장: 개발자 모드 Chrome MV3. 문서 질문과 화면 안내를 명시적으로 나눈다.
- 공통 생성 모델은 `OLLAMA_LLM`으로 지정한다. EC2 기본 선택은 기존 Qwen3 30B, 가벼운 로컬 확인은 Qwen2.5 1.5B다. 검색 임베딩은 bge-m3/1024를 유지한다.

## 문서 등록

관리자 로그인 → 제도 선택 → PDF/DOCX/UTF-8 MD 업로드 → 작업 접수 → Docling 분석 → 자동 구조 분할 → 실제 임베딩 → 원자적 게시.

[문서 API](../../BackEnd/documents/api.py)는 `/api/v1/admin/documents`를 사용한다. 작업 상태는 queued → parsing → embedding → ready → succeeded 흐름이며 실패·취소를 별도로 처리한다. 수동 섹션 분류·검토 승인·index 호출은 현재 사용 절차가 아니다. 원문 위치·표·해시·입력 한도 등 자동 품질 검증은 남아 있다.

[분석](../../BackEnd/documents/analysis.py), [색인 입력](../../BackEnd/documents/indexing.py), [워커](../../BackEnd/documents/worker.py), [저장소](../../BackEnd/documents/store.py)를 분리한다. 후보 원문·분석·청크 준비 중 기존 게시 자료를 보존하고 성공한 후보만 게시한다. 같은 문서의 교체 성공 후 이전 자료를 정리하며 일반적인 과거 버전 열람을 제품 요구로 두지 않는다.

## 검색과 생성

`/api/v1/chat`과 관리자 문서별 `/{id}/query`는 [answer_document](../../BackEnd/documents/qa.py)를 사용한다.

1. 접근 범위에 맞는 현재 문서·성공 작업·벡터 스냅샷을 읽는다.
2. 임베딩 digest가 맞는 청크에 대해 질문 bge-m3 임베딩과 코사인 검색을 수행한다.
3. 같은 후보 범위에서 BM25 키워드 검색 후 RRF로 순위를 합친다.
4. ONNX BGE 리랭커로 재정렬하고 핵심 원문을 고른다.
5. 최소 문서 근거 프롬프트로 생성하고 실제 검색 원문·페이지·블록·출처를 반환한다.
6. 처리 중 문서 스냅샷·임베딩 digest가 바뀌면 오래된 답변을 반환하지 않는다.

현재 벡터 검색은 저장소 스냅샷을 읽어 애플리케이션에서 계산한다. pgvector 저장이 곧 DB 서버의 ANN 인덱스 검색을 뜻하지 않는다. 데이터 증가 시 스냅샷 메모리와 검색 지연을 별도로 평가한다.

## 인증과 근거

서버 공통 `ADMIN_PASSWORD`와 기존 관리자 세션 API를 사용한다. Supabase Auth 계정 생성을 현재 관리자 로그인 필수 조건으로 안내하지 않는다. 익명 검색은 공개 게시 자료만 사용하고 test_only 자료는 관리자 범위에서 확인한다.

반환 evidence는 검색된 원문이지 답변의 모든 문장을 검증한 인용 결과가 아니다. 현재 문서 경로는 최소 근거 프롬프트를 사용하며 이전의 복지 조건별 고정 보류·엄격 인용 검증이 모두 적용된다고 설명하지 않는다. 이력을 수용해도 현재 검색·생성에는 마지막 질문만 사용한다.

## 실행과 검증

실행 명령과 환경변수는 [프로젝트 README](../../README.md), 확장·SSH 연결은 [확장 README](../../Extension/README.md)를 따른다. 환경변수 변경 후 Compose 재생성이 필요하며 단순 restart가 새 환경을 반영한다고 가정하지 않는다.

최신 로컬 평가 자료는 `docs/tests/`, 현재 작업 상태는 `docs/log/handoff.md`에 둔다. 실제 답변·근거와 입력/출력 한도·오류·소요 시간을 확인하고 HTTP 200만으로 정확도를 판정하지 않는다.
