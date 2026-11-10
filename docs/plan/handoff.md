# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-10 12:58 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- F7의 **상단항상창열기→창안요약하기→저장대화요약/결과저장 코드수정은EC2·로컬에완료**했다. 기존백엔드API를재사용했고변경3파일구문만각1회확인했다. **동작테스트는사용자직접,원격은미push**다. [현재완료·수행범위](devlog.md#log-20261110-1221-summary-button) / [앞선완료](devlog.md#log-20261110-1147-menu-review)
- 활성 계획/진행/인계는 이 세 파일만 사용하며 설계가 단일 작성자다. 개발에는 새 지침 재로딩과 고정 문서 역할을 다시 전달했다. [문서 통합·재로딩 기록](devlog.md#log-20261110-1046-f8b909)

## 구현·배포 기준과 보존할 변경

- 로컬루트 `C:/Users/jehee/vscode-workspace/welfare_helper`,EC2 `/home/ubuntu/welfare_helper`,브랜치 `codex/fix-merge`다. 새EC2제품은 `d0ecaf2`,로컬은기존문서를함께보존한기능통합 `55cf239`이며제품소스가반영됐다. 원격은이전534783f로아직미push다. B11은보존하고로컬/EC2 Git조작을직렬화한다.
- backend/worker 운영 이미지 기준은 `c500ae5` 그대로다. backend `7fe269f305911a8e69004ef333ffa6e82c0cf600d6879b9ad83553a3250a7c63`, worker `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`. Ollama/edge·기존 모델·공개364문서/921벡터를 유지했다. 이번 확장/검사 변경으로 서버 이미지를 교체하거나 재시작하지 않았다.
- 확장은기존 `Extension/`, MV3/0.1.0,API `https://15.164.190.21`이다. [현재제품CI](https://github.com/jehee826/welfare_helper/actions/runs/42746898662)는4job·확장506/506·프런트120·백엔드666/13skip/2subtests·타입/빌드성공이다. F1~F3는사용자반영확인을받았고새F4/F5의실제Chrome확인은아직대기다.
- 기존 `Extension/README.md`·`docs/design/extension.md`를 실제 반영 계약으로 확정해 이 기록과 함께 공유한다. 모든 상세 검사·실패·수정과 원자료 위치는 일지를 따른다.
- EC2 실패 B안11파일과 원자료는 보존 상태다. Backend UI 검사1줄만 baseline 기준으로 커밋했고 B안 제품코드는 포함하지 않았다. 원본11 백업·나머지10 작업해시 동일·겹침1의 의도된 UI 단언 차이를 유지한다.
- 관리자 최신 UI는 fix-merge preview, production 관리자 도메인은 main 기존본이다. 현재 비밀번호 유지 영속 인증은 활성이고 W14 수집은 OFF다. production 비밀번호를 회전하거나 실자료를 재적재하지 않는다.

## 바로 다음에 할 일

1. 기존설치의확장을다시로드하고복지로F5뒤상단상담요약으로창을열어내부요약하기를사용자가직접시험한다.
2. 원격공유는구체범위승인뒤진행한다. 에이전트의추가테스트/HTTP/모델/Chrome/CI실행은하지않는다.
3. 최종main PR과별도사용자웹·RAG/CSV/W14는자동착수하지않는다.

## 계속 대기할 범위

RAG 정확도/B안 채택, 별도 연락처 CSV/W03 매핑·W14 활성화는 보류다. 실제 관리자 긍정 UI/production 비밀번호 회전·실재부팅 등 미실측은 계획에 남기되 가상의 장애/DB복구·부하 시험을 새 필수로 추가하지 않는다. 상세 완료/미검증 근거는 계획의 일지 링크를 따른다.
