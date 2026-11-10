# 과거 문서 보관

최신 업데이트: 2026-11-10 10:46 KST.

정리: 2026-11-04. 아래 문서는 **작성 당시의 계획·설계·실행·실패·수정·검증 전문**이다. 제목·날짜·기록을 보존하고 링크 위치만 갱신했다. 문서 안의 “현재”, “미완료”, “다음 작업”을 지금의 상태나 실행 지시로 해석하지 않는다.

## 목차

- [과거 계획](#과거-계획)
- [과거 설계](#과거-설계)
- [태스크 전문](#태스크-전문)
- [보존과 공개 범위](#보존과-공개-범위)

현재 상태는 [인계](../plan/handoff.md), 전체 계획/완료/잔여는 [merge_plan](../plan/merge_plan.md), 상세 진행은 [devlog](../plan/devlog.md)를 따른다.

## 과거 계획

2026-11-10 활성 작업 문서를 세 개로 통합하면서 다음 기존 문서를 이동했다. 원래 작성일·기록을 보존하고 이후 진행 기록은 추가하지 않는다.

- [기존 협업 계획](collaboration-plan.md)
- [협업 계획 교차검증](collaboration-plan-review.md)
- [병합 후 이전 결정](merge_decisions.md)
- [노트북 작업 이관](laptop_handoff.md)


- [기존 통합계획](plans/extension-product-delivery-plan.md): RAG 전환·단순화·진단·자료 교체와 7절 결과.
- [후속 배포·품질 계획](plans/post-verification-delivery-plan.md): P별 선행 관계와 작성 당시 상태.
- [초기 개선 로드맵](plans/roadmap-p0-solutions.md).

## 과거 설계

- [이전 파이프라인](designs/welfare-rag-pipeline-design.md), [정확도 설계](designs/rag-accuracy-design.md), [데이터 필드](designs/welfare-rag-features.md), [구현 차이 분석](designs/implementation-gap-analysis.md).
- [2026-10-21 RAG 범위](designs/specs/2026-10-21-welfare-rag-mvp-design.md), [2026-10-21 웹 목업](designs/specs/2026-10-21-welfare-mockup-design.md).
- [목업 ERD](designs/database/복지챗봇-mockup.erd). 현재 ERD 파일은 [design/database](../design/database/복지챗봇.erd)에 유지한다.

## 태스크 전문

- [초기 화면 상담·개선 1~3단계](tasks/01-foundation.md)
- [T1~T5 핵심 기능](tasks/02-extension-core.md)
- [T6~T10 UI·연결·운영](tasks/03-extension-ui-operations.md)
- [P 관리자·배포·정리](tasks/04-admin-deployment.md)
- [L1~L6 로컬 검증](tasks/05-local-verification.md)

28개 개별 태스크를 위 5개로 합친 원문을 보존했다. 완료 기록뿐 아니라 실패 원인·수정 과정·미검증·보류 항목도 남아 있다.

## 보존과 공개 범위

개인 계획·태스크 기록은 기존처럼 Git 제외 대상이다. **원래 공유하던 설계·목업 ERD·로드맵만 새 위치에서도 추적**하며 보관 폴더 전체를 공개하지 않는다. 현재 설계 4개는 소스 구조·계약 설명이며 개인 테스트 원문을 포함하지 않는다.

원시 시험 입력·정답표·결과·이전 자료 복구본은 `docs/tests/`에서 이동하거나 삭제하지 않았다. Word·키·환경 비밀·사용자 상담도 이 정리의 이동·삭제 대상이 아니다.
