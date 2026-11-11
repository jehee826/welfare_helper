# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-12 02:57 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 최신 main/b82b391의 EC2 배포를 진행 중이다. 개발 세션이 EC2 단일 운영 담당으로 B11 백업·분리, main ff-only 동기화, 필요한 backend/worker 교체와 읽기 준비도 확인을 맡는다. 설계는 로컬 `codex/deploy-refactor-main`에서 세 활성 문서만 작성·검토한다. 로컬 제품/설정 변경과 추가 구현은 없다. [배포 착수](devlog.md#log-20261112-0257-refactor-deploy)
- 리팩토링 1~7번 제품은 PR #23~#29로 main 통합 완료이며 각 PR의 CI4job이 통과했다. 8번 실행·배포·CI는25파일의 책임/경로를 정적 검토해 기존구조 유지로 완료했다. 제품추가수정은 없다. [7번 결과](devlog.md#log-20261112-0221-desktop-result) / [통합·8번 결과](devlog.md#log-20261112-0228-runtime-review)
- 노트북 Jehee-Laptop 루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, Git디렉터리 `.git`, 재개 기준 브랜치는 main이다. 제품 기준은0e54cd4이며 완료 기록 PR #30은main/6c59068에 통합했다. 미완료 제품 구현은 없다. 리팩토링 브랜치8개 삭제 범위의 명시 승인을 받은 뒤 제품 브랜치7개를 로컬·원격에서 정리했다. 마지막 기록 브랜치는 이 정리 기록 공유 뒤 병합·후속 변경을 확인하고 삭제한다. 실제 최종 HEAD/브랜치 목록은 Git과 완료 보고를 대조한다. [정리 기록](devlog.md#log-20261112-0249-refactor-cleanup)

## 구현·배포 기준과 보존할 변경

- 로컬 main은 제품0e54cd4까지 ff-only 동기화했다. EC2 `/home/ubuntu/welfare_helper`는01:54 실제 확인한 main/364cbb8이고 미커밋B안11파일을 유지한다. pull·서비스 재기동은 하지 않았다. 운영 backend 소스f11e8af와 실행 이미지는 Git HEAD와 별개다. [이전 동기화](devlog.md#log-20261110-1618-main-sync)
- 마지막 확인된 backend 이미지는 `595f3713aa4f2a2ddc2af61d479b6a8bcb9a88647ef4f88cf9d6497501e6546c`, worker는 `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`이다. 기록 수집은 두 서비스에서 true로 활성화했다. 기존 모델·Caddy·부팅 이미지 pin·환경·볼륨·DB는 유지한다. 최근 상태를 새로 실측한 것은 아니다.
- EC2 SSH는01:54 재연결됐다. B안11파일의 실제 diff를 읽었고 전체diff SHA256 `4ff7518bfb5505c4b0a106eb4217fd6808e7e096e492e5b5717860d8200b3bd4`가 이전 기록과 동일하다. items/발췌 기반 생성·strict_json은 보류된 품질 실험이며 이번 로컬 리팩토링에 복사하지 않는다. 겹치는 qa/검사 경로는 로컬 main의 기존text 스키마를 기준으로 수정하고 EC2 실험 소스는 그대로 보존한다. 향후 서버 반영 전 충돌·운영 이미지와 별도로 대조한다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel welfare7/welfare-helper의 제품main/0e54cd4 production은02:27 조회에서 READY였다. 배포ID는 dpl_7ZRcoSnikU3D1stGZz88gsMWE6oM이며 `welfare-helper-iota.vercel.app` alias 연결을 확인했다. 관리자 로그인·실제 웹/API 종단은 미실측이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. 기존 리팩토링 브랜치8개는 로컬·원격 삭제 완료했고 착수 전 main/b82b391과 깨끗한 작업 트리를 확인했다. 이번 문서 브랜치는 기존8개 삭제 범위와 별개다.
2. EC2 운영 담당의 B11 원본·binary patch·기준 버전 백업과 복구 가능성, 운영 이미지·기동 pin·설정 보존을 검토한다. 최신 main 반영 뒤 backend/worker 준비도·HTTPS 응답과 다른 서비스/설정 보존을 확인한다. 기존 이미지와 B11은 복구용으로 보존하고 실제 모델·DB 복구·재부팅 시험은 하지 않는다.
3. 사용자 실제 확장·음성 확인, 연락처가 나오는 상담의 관리자 기록 조회는 미실측으로 유지한다. 수집 ON 이전 대화는 소급 기록하지 않는다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.

pgvector 이미지 다운로드와 worker·DB 복구 자동시험은 보류한다.
