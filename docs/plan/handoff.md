# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-12 01:05 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 리팩토링 1번 확장은 PR #23, 2번 공개 웹 상담은 PR #24로 main에 통합했다. 두 PR의 CI4job이 각각 통과했다. 현재는 3번 관리자 웹·공유 진입점 착수다. [1번 통합](devlog.md#log-20261112-0055-extension-merge-webchat) / [2번 결과](devlog.md#log-20261112-0102-webchat-result) / [2번 통합·3번 착수](devlog.md#log-20261112-0105-webchat-merge-admin)
- 노트북 Jehee-Laptop 루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, Git디렉터리 `.git`, 브랜치 `codex/refactor-admin-web`, 기준 main/a12ed10d9eea63779196bd99162aeeaf13986153이다. 개발 채팅이 관리자 웹 제품·관련 기존 검사, 설계가 기록·리뷰·Git을 단독 작성한다. 우선 AdminPage/ProgramManager 통합과 DocumentsPage 작업 분기 정리이며 4~8번은 대기한다.

## 구현·배포 기준과 보존할 변경

- 로컬 main은 a12ed10까지 ff-only 동기화했다. EC2 `/home/ubuntu/welfare_helper`의 마지막 동기화 기준은 main/364cbb8이며 이번 리팩토링에서 접속·pull·서비스 재기동을 하지 않았다. 운영 backend 소스f11e8af와 실행 이미지는 Git HEAD와 별개다. [이전 동기화](devlog.md#log-20261110-1618-main-sync)
- 마지막 확인된 backend 이미지는 `595f3713aa4f2a2ddc2af61d479b6a8bcb9a88647ef4f88cf9d6497501e6546c`, worker는 `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`이다. 기록 수집은 두 서비스에서 true로 활성화했다. 기존 모델·Caddy·부팅 이미지 pin·환경·볼륨·DB는 유지한다. 최근 상태를 새로 실측한 것은 아니다.
- EC2 실패 B안11파일과 원자료는 보존한다. 다음 백엔드 작업 전에 현지 diff와 비교하며 최신 main으로 덮지 않는다. 보존 근거·해시는 기존 [일지](devlog.md#log-20261110-1618-main-sync)를 따른다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel은 welfare7/welfare-helper와 `welfare-helper-iota.vercel.app`을 유지한다. PR #24 head/abd0d92의 Preview 상태 success를 확인했다. main/a12ed10 production 완료와 관리자 로그인·실제 웹/API 종단은 별도 확인 대상이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. 개발이 3번 섹터52파일의 책임·중복을 검토하고 필요한 구조 변경과 기존 집중 검사를 수행한다. 설계는 작성권 반환 후 diff·로그·계약을 검토하고 커밋·push·PR·CI·병합한다.
2. 3번 main 통합 뒤4번 FastAPI 공통으로 이동한다. 서버 배포는 기존 EC2 B안 변경·실행 이미지와 대조한 후 해당 범위에서 처리하며 현재 단계에서 서버를 바꾸지 않는다.
3. 사용자 실제 확장·음성 확인, 연락처가 나오는 상담의 관리자 기록 조회는 미실측으로 유지한다. 수집 ON 이전 대화는 소급 기록하지 않는다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.
