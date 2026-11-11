# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-12 02:13 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 리팩토링 1~6번은 PR #23~#28로 main 통합 완료이며 각 PR의 CI4job이 통과했다. 현재7번 Desktop·화면 안내는 로컬 착수다. [6번 결과](devlog.md#log-20261112-0209-rag-result) / [통합·7번 착수](devlog.md#log-20261112-0213-rag-merge-desktop)
- 노트북 Jehee-Laptop 루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, Git디렉터리 `.git`, 브랜치 `codex/refactor-desktop`, 기준 main/01d3021013949e63b61e826a71d5cd563fcf4074다. 개발이7번 제품·관련 기존 검사, 설계가 문서·리뷰·Git을 맡는다. 첫 변경은 Desktop 응답step의 불필요한 JSON 왕복을 없애고 화면 변경 시 취소·강조 제거 순서를 정리하는 것이다. 8번은 대기한다.

## 구현·배포 기준과 보존할 변경

- 로컬 main은01d3021까지 ff-only 동기화했다. EC2 `/home/ubuntu/welfare_helper`는01:54 실제 확인한 main/364cbb8이고 미커밋B안11파일을 유지한다. pull·서비스 재기동은 하지 않았다. 운영 backend 소스f11e8af와 실행 이미지는 Git HEAD와 별개다. [이전 동기화](devlog.md#log-20261110-1618-main-sync)
- 마지막 확인된 backend 이미지는 `595f3713aa4f2a2ddc2af61d479b6a8bcb9a88647ef4f88cf9d6497501e6546c`, worker는 `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`이다. 기록 수집은 두 서비스에서 true로 활성화했다. 기존 모델·Caddy·부팅 이미지 pin·환경·볼륨·DB는 유지한다. 최근 상태를 새로 실측한 것은 아니다.
- EC2 SSH는01:54 재연결됐다. B안11파일의 실제 diff를 읽었고 전체diff SHA256 `4ff7518bfb5505c4b0a106eb4217fd6808e7e096e492e5b5717860d8200b3bd4`가 이전 기록과 동일하다. items/발췌 기반 생성·strict_json은 보류된 품질 실험이며 이번 로컬 리팩토링에 복사하지 않는다. 겹치는 qa/검사 경로는 로컬 main의 기존text 스키마를 기준으로 수정하고 EC2 실험 소스는 그대로 보존한다. 향후 서버 반영 전 충돌·운영 이미지와 별도로 대조한다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel은 welfare7/welfare-helper와 `welfare-helper-iota.vercel.app`을 유지한다. PR #28 head/5a95ea0의 Preview 상태 success를 확인했다. 최신main production 완료와 관리자 로그인·실제 웹/API 종단은 별도 확인 대상이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. 개발이7번 섹터36파일의 책임·호출과 step 경계를 검토·정리하고 기존 assistant/tracking/visibility 대역 검사로 가시성·3.5초 freshness·포커스·취소·늦은overlay를 대조한다. 설계는 작성권 반환 후 리뷰·커밋·push·PR·CI·병합한다.
2. 7번 main 통합 뒤8번 실행·배포·CI의 구조 검토로 이동한다. EC2 B안 채택과 실제 서버 반영은 별개이며 현재 서버 소스·서비스를 바꾸지 않는다.
3. 사용자 실제 확장·음성 확인, 연락처가 나오는 상담의 관리자 기록 조회는 미실측으로 유지한다. 수집 ON 이전 대화는 소급 기록하지 않는다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.

pgvector 이미지 다운로드와 worker·DB 복구 자동시험은 보류한다.
