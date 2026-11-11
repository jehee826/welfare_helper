# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-12 02:28 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 리팩토링 1~7번 제품은 PR #23~#29로 main 통합 완료이며 각 PR의 CI4job이 통과했다. 8번 실행·배포·CI는25파일의 책임/경로를 정적 검토해 기존구조 유지로 완료했다. 제품추가수정은 없다. [7번 결과](devlog.md#log-20261112-0221-desktop-result) / [통합·8번 결과](devlog.md#log-20261112-0228-runtime-review)
- 노트북 Jehee-Laptop 루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, Git디렉터리 `.git`, 현재 기록 브랜치 `codex/refactor-runtime-review`, 제품 기준 main/0e54cd4e14750abe891569d770a79e8a004be5c3다. 개발의 제품 작성권은 반환됐고 설계가 최종 기록 PR을 진행한다. 이 기록 통합 뒤 로컬 main을 ff-only 동기화한다. 완료브랜치 삭제는 자동 승인 심사가 명시적 삭제승인 부재로 거절해 보존 중이다.

## 구현·배포 기준과 보존할 변경

- 로컬 main은 제품0e54cd4까지 ff-only 동기화했다. EC2 `/home/ubuntu/welfare_helper`는01:54 실제 확인한 main/364cbb8이고 미커밋B안11파일을 유지한다. pull·서비스 재기동은 하지 않았다. 운영 backend 소스f11e8af와 실행 이미지는 Git HEAD와 별개다. [이전 동기화](devlog.md#log-20261110-1618-main-sync)
- 마지막 확인된 backend 이미지는 `595f3713aa4f2a2ddc2af61d479b6a8bcb9a88647ef4f88cf9d6497501e6546c`, worker는 `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`이다. 기록 수집은 두 서비스에서 true로 활성화했다. 기존 모델·Caddy·부팅 이미지 pin·환경·볼륨·DB는 유지한다. 최근 상태를 새로 실측한 것은 아니다.
- EC2 SSH는01:54 재연결됐다. B안11파일의 실제 diff를 읽었고 전체diff SHA256 `4ff7518bfb5505c4b0a106eb4217fd6808e7e096e492e5b5717860d8200b3bd4`가 이전 기록과 동일하다. items/발췌 기반 생성·strict_json은 보류된 품질 실험이며 이번 로컬 리팩토링에 복사하지 않는다. 겹치는 qa/검사 경로는 로컬 main의 기존text 스키마를 기준으로 수정하고 EC2 실험 소스는 그대로 보존한다. 향후 서버 반영 전 충돌·운영 이미지와 별도로 대조한다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel welfare7/welfare-helper의 제품main/0e54cd4 production은02:27 조회에서 READY였다. 배포ID는 dpl_7ZRcoSnikU3D1stGZz88gsMWE6oM이며 `welfare-helper-iota.vercel.app` alias 연결을 확인했다. 관리자 로그인·실제 웹/API 종단은 미실측이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. 설계가8번 완료 기록 PR·CI·병합과 로컬main ff-only 동기화를 마친다. 삭제승인 전 완료브랜치는 보존하며 사용자가 명시 승인하면 병합/후속변경/사용 여부를 재확인한 뒤 정리한다.
2. EC2 소스 동기화/운영 반영은 남아 있다. 기존B안의 qa/검사와 새main이 겹치므로 무조건pull/덮어쓰기하지 않는다. 보존 패치·복구 수단과 충돌 처리·운영 이미지 및 필요한backend/worker 반영 범위를 별도로 구체화한다. 현재 EC2 소스·서비스·데이터는 미변경이다.
3. 사용자 실제 확장·음성 확인, 연락처가 나오는 상담의 관리자 기록 조회는 미실측으로 유지한다. 수집 ON 이전 대화는 소급 기록하지 않는다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.

pgvector 이미지 다운로드와 worker·DB 복구 자동시험은 보류한다.
