# 프로젝트 문서 안내

## 목차

- [먼저 볼 문서](#먼저-볼-문서)
- [문서 구조](#문서-구조)
- [과거 개발·실패·수정 기록](#과거-개발실패수정-기록)
- [설계와 실행 안내](#설계와-실행-안내)
- [보존 범위와 Git](#보존-범위와-git)

## 먼저 볼 문서

1. **[통합계획](plan/extension-product-delivery-plan.md)**: 현재 상태, 남은 작업, 기능별 계획과 7절 구현/테스트 결과.
2. **[개발일지](log/development.md)**: 날짜별 시도, 실패 원인, 수정, 검증과 미해결 이력.

[인계](log/handoff.md)는 브랜치·실행 서비스·복구 위치의 보조 메모다. 현재 상태는 통합계획을 기준으로 하고, 과거 태스크의 “현재/대기/완료”를 현행 상태로 읽지 않는다.

## 문서 구조

```text
docs/
├─ README.md                          # 이 안내
├─ design/                            # 프로젝트 설계·계약·ERD
│  ├─ database/                       # ERD·DB 작업 SQL
│  └─ specs/                          # 작성일이 있는 초기 설계
├─ plan/
│  ├─ extension-product-delivery-plan.md   # 현재 통합계획·결과
│  ├─ post-verification-delivery-plan.md   # 이전 후속 계획·선행 관계
│  ├─ roadmap-p0-solutions.md              # 기존 공유 개선 로드맵
│  └─ history/                        # 과거 태스크 전문 5개 묶음
├─ log/
│  ├─ development.md                  # 누적 개발일지
│  └─ handoff.md                      # 현재 실행·복구 메모
└─ tests/
   ├─ fixtures/                       # 시험 입력·정답표
   └─ results/                        # 원시 결과·이전 자료 복구본
```

## 과거 개발·실패·수정 기록

개별 태스크 28개를 아래 5개에 합쳤다. **원래 날짜·계획·실행·실패·수정·검증·테스트 본문을 유지**했으며, 각 합본의 목차에서 기존 태스크로 이동할 수 있다. 예전 파일명은 출처 표기로 남겼다.

- [초기 화면 상담·개선 1~3단계](plan/history/01-foundation.md)
- [T1~T5: 프로필·대화 저장·맥락·관리자 진입·RAG](plan/history/02-extension-core.md)
- [T6~T10: 추천·음성·UI·연결·종단·운영](plan/history/03-extension-ui-operations.md)
- [P: 관리자 전용 웹·배포 설정·접근 경계·문서 정리](plan/history/04-admin-deployment.md)
- [L1~L6: 문서 교체·PDF·HTTP·UI·CI·진단](plan/history/05-local-verification.md)

RAG-1~6, S1~S4, 주제 전환과 노인자료 교체의 상세 결과는 [통합계획 7절](plan/extension-product-delivery-plan.md#7-구현테스트-결과)에 유지했다. 원시 질문·답변·측정 결과는 `tests/results/`에 있다. 과거 실패를 삭제하거나 후속 성공으로 덮어쓰지 않는다.

## 설계와 실행 안내

- [RAG 파이프라인](design/welfare-rag-pipeline-design.md), [정확도 설계](design/rag-accuracy-design.md), [데이터 필드](design/welfare-rag-features.md)
- [구현 현황 대조](design/implementation-gap-analysis.md), [공유 개선 로드맵](plan/roadmap-p0-solutions.md)
- [현재 ERD](design/database/복지챗봇.erd), [이전 목업 ERD](design/database/복지챗봇-mockup.erd)
- [초기 RAG 범위](design/specs/2026-10-21-welfare-rag-mvp-design.md), [초기 웹 설계](design/specs/2026-10-21-welfare-mockup-design.md)
- [프로젝트 실행 안내](../README.md), [확장 실행 안내](../Extension/README.md)

설계 문서는 작성 당시의 의도·계약도 담고 있다. 현재 구현·검증 여부는 통합계획의 날짜별 결과와 함께 확인한다. 실제 코드와 다른 옛 설계를 현행 동작의 근거로 사용하지 않는다.

## 보존 범위와 Git

- `tests/fixtures`의 원문과 정답표, `tests/results`의 JSON/JSONL/CSV·복구본은 이동·삭제하지 않았다. 정답표는 적재·임베딩·모델 프롬프트에 포함하지 않는다.
- Word 원본, 프로젝트·앱 README, 지침, 공유 설계·ERD·SQL은 기존 위치를 유지한다.
- **개인 계획·이력·개발일지·시험 자료는 기존처럼 Git에서 제외된다.** 새 clone에는 위 로컬 문서가 없을 수 있다. 이번 정리는 공개 허용 목록을 확대하지 않으며 공유 문서에서 개인 기록 전문을 복제하지 않는다.
