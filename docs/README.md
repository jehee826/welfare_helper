# 프로젝트 문서

## 목차

- [태스크와 개발일지](#태스크와-개발일지)
- [공유 설계](#공유-설계)
- [입력과 원시 결과](#입력과-원시-결과)

## 태스크와 개발일지

- **[통합 태스크 목차](design/extension-product-delivery-plan.md)**: 초기 개선/T1~T10/P1~P11/L1~L6의 진입점. 각 기존 태스크 문서에 계획·실행·검증·테스트와 날짜별 결과를 합쳤다.
- **[개발일지](log/development.md)**: 기존 날짜순 변경·실패·검토 이력.
- [현재 인계](log/handoff.md): 지금 상태와 다음 행동만 유지한다.
- [후속 배포·품질 계획](design/post-verification-delivery-plan.md): 실제 연결/모델 품질/관리자 교체의 선행 관계.

개인 계획·일지·시험 자료는 Git에서 제외되므로 새 clone에 없을 수 있다. 기존 공유 설계의 허용 목록을 확장하지 않는다. 중복 결과 MD는 관련 태스크 본문으로 통합했으며 원래 작성일과 당시 실패를 보존한다.

## 공유 설계

- [RAG 파이프라인](design/welfare-rag-pipeline-design.md), [정확도 설계](design/rag-accuracy-design.md), [데이터 필드](design/welfare-rag-features.md).
- [구현 현황](design/implementation-gap-analysis.md), [개선 방향](design/roadmap-p0-solutions.md).
- [현재 ERD](design/database/복지챗봇.erd), [이전 목업 ERD](design/database/복지챗봇-mockup.erd).
- [RAG 범위](design/specs/2026-10-21-welfare-rag-mvp-design.md), [웹 초기 설계](design/specs/2026-10-21-welfare-mockup-design.md).

실행 안내는 [프로젝트 README](../README.md), [확장 README](../Extension/README.md)를 따른다. 앱 README·지침·공유 설계의 위치는 유지한다.

## 입력과 원시 결과

- `tests/fixtures/`: 평가 입력과 정답표. 정답표는 적재·임베딩·모델 프롬프트에 넣지 않는다.
- `tests/results/`: JSON/JSONL/CSV 등 원시 측정 결과. 사람이 읽는 설명은 해당 태스크 계획으로 병합했다.
- DOC/DOCX·CSV 원본과 SQL/ERD는 기존 위치에 보존한다. Word·개인 기록·지침·비밀을 새로 Git에 올리지 않는다.
