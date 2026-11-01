# 프로젝트 문서

설계·검증 자료·진행 기록을 구분한다. 실행은 [프로젝트 README](../README.md), 화면 안내는 [확장 README](../Extension/README.md)를 먼저 읽는다.

## 설계

- [RAG 파이프라인](design/welfare-rag-pipeline-design.md): 문서 등록부터 검색·생성까지의 현재 경로.
- [RAG 정확도](design/rag-accuracy-design.md): 청크·오버랩·검색·리랭커와 확인해야 할 한계.
- [데이터 필드](design/welfare-rag-features.md): 원문·제도·벡터의 역할.
- [구현 현황](design/implementation-gap-analysis.md), [다음 개선 순서](design/roadmap-p0-solutions.md).
- [현재 ERD](design/database/복지챗봇.erd), [이전 목업 ERD](design/database/복지챗봇-mockup.erd).
- [RAG 범위](design/specs/2026-10-21-welfare-rag-mvp-design.md), [웹 화면 범위](design/specs/2026-10-21-welfare-mockup-design.md).

## 로컬 문서

다음은 Git에서 제외된다. 새로 clone한 환경에는 없을 수 있으며 필요할 때 별도로 전달한다.

- `docs/design/extension-screen-assistant-plan.md`: 확장 화면 상담 설계.
- `docs/design/extension-product-delivery-plan.md`: 개인 순차 실행 계획과 **7. 구현/테스트 결과**. `extension-product-task-*.md`는 단계별 상세 계약이며 clone에는 포함되지 않는다.
- `docs/design/database/*.sql`: 검토용 DB 준비·재구축 SQL. 기존 DB에 자동 재실행하지 않는다.
- `docs/tests/llm-accuracy-evaluation.md`: 수동 평가 절차.
- `docs/tests/requirements-traceability.md`, `docs/tests/end-to-end-checklist.md`: 현재 요구사항·근거 추적과 미완료 종단 시험 절차. 실제 사용자 확인·승인 환경 필요·자료 준비 필요를 구분한다.
- `docs/tests/fixtures/`: 입력 원문과 평가자용 정답표. 정답표는 임베딩하거나 모델에 보내지 않는다.
- `docs/tests/results/`: 시험별 결과·진단. 과거 결과와 현재 상태를 구분한다.
- `docs/log/development.md`: 완료한 하위 작업별 변경·검증·남은 문제를 누적한다.
- `docs/log/handoff.md`: 언제 인계해도 이어갈 수 있도록 현재 상태를 갱신한다.

기존 DOCX·DOC·CSV 원본은 docs 루트에 둔다. Word 파일은 로컬에만 보존한다. 앱별 README·프로젝트 지침은 원래 위치를 유지하고, 자동 테스트 코드는 각 앱의 기존 테스트 경로에 둔다.

## 문서 관리

공유 설계는 실제 코드와 대조해 갱신하고, 과거의 미구현·미검증 문장을 현재 상태처럼 남기지 않는다. 시험 결과는 실행 당시 조건과 함께 보존한다. 실행 상태·모델 선택·미커밋 작업은 인계문서, 변경 과정은 개발일지에 기록하며 비밀값·개인정보·대화 전문은 넣지 않는다.
