# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-12 03:10 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 최신 main/b82b391의 EC2 배포 완료. 개발 세션이 단일 운영 담당으로 B11 검증 백업·분리, main ff-only 동기화와 backend/worker 교체를 수행했고 설계가 원자료를 읽기 검토했다. 두 서비스 healthy·내부 readiness 200·공개 HTTPS health/capabilities 200이며 기록 수집 ON을 유지한다. 실제 모델 추론·Chrome·재부팅은 이번에 실행하지 않았다. [배포 결과](devlog.md#log-20261112-0310-refactor-deployed)
- 리팩토링 1~7번 제품은 PR #23~#29로 main 통합 완료이며 각 PR의 CI4job이 통과했다. 8번 실행·배포·CI는25파일의 책임/경로를 정적 검토해 기존구조 유지로 완료했다. 제품추가수정은 없다. [7번 결과](devlog.md#log-20261112-0221-desktop-result) / [통합·8번 결과](devlog.md#log-20261112-0228-runtime-review)
- 노트북 Jehee-Laptop 루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, Git디렉터리 `.git`이며 main/origin/main과 EC2 제품 기준은b82b391이다. 기존 리팩토링 브랜치8개는 로컬·원격 삭제 완료했다. 이번 세 활성 문서의 단일 작성자는 설계이고 로컬 `codex/deploy-refactor-main`에서 기록한다. 제품·설정 변경과 미완료 구현은 없다. 기록 브랜치의 원격 공유/통합은 별도 Git 범위로 구분한다. [정리·배포 착수](devlog.md#log-20261112-0257-refactor-deploy)

## 구현·배포 기준과 보존할 변경

- EC2 `/home/ubuntu/welfare_helper`는 main/b82b391이며 index/작업 트리는 깨끗하다. 실행 backend·worker의 BackEnd118파일이 대상 main과 일치한다. 이전f11e8af 실행 소스와 달리 리팩토링 main이 운영에 반영된 상태다.
- 현재 backend 이미지는 `310f5c7a3a12fbe917f5a0c586f563ee34139a19d500ae4ffc4a03d678043a20`, worker는 `f36e1939db5bd56292430c21d3c97d23ea1b1a9651d1cefbdf9c4a54ab192172`이다. 기존 의존성 레이어와 환경·인증·볼륨·모델/GPU를 유지했고 부팅스크립트는 두 이미지ID만 갱신했다. Ollama/edge는 미교체·미재기동이며 systemd active/enabled다.
- B안11파일은 배포 checkout에서 분리하고 EC2 `.local/co-op/checks-runtime/ec2-main-b82b391-20261112`에 원본tar·binary patch·기준SHA·hash로 보존했다. diff SHA256은 `4ff7518bfb5505c4b0a106eb4217fd6808e7e096e492e5b5717860d8200b3bd4`이며 별도 staging에서 복구를 검증했다. Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 이전 컨테이너 `welfare-backend-rollback-b82b391`·`welfare-document-worker-rollback-b82b391`와 이미지·부팅스크립트 백업도 보존한다. 백업은 root 전용이며 비밀 포함 원자료를 일반 출력하지 않는다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel welfare7/welfare-helper의 제품main/0e54cd4 production은02:27 조회에서 READY였다. 배포ID는 dpl_7ZRcoSnikU3D1stGZz88gsMWE6oM이며 `welfare-helper-iota.vercel.app` alias 연결을 확인했다. 관리자 로그인·실제 웹/API 종단은 미실측이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. 배포 후속 문서의 로컬 커밋·원격 공유 상태를 실제 Git과 완료 보고에서 확인한다. 이미 완료한 배포/준비도 검사를 반복하지 않는다.
2. 사용자 실제 확장·음성 확인, 연락처가 나오는 상담의 관리자 기록 조회는 미실측으로 유지한다. 수집 ON 이전 대화는 소급 기록하지 않는다.

backend 교체로 메모리 관리자 세션은 다시 로그인해야 할 수 있다. 필요 시 root 전용 백업의 rollback.sh를 검토하되 실행 전 worker 유휴 확인이 필요하며 이번에는 복구를 실제 실행하지 않았다. 이미지 복구와 Git main의 버전은 별개다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.

pgvector 이미지 다운로드와 worker·DB 복구 자동시험은 보류한다.
