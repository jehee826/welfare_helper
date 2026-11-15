# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-15 16:32 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- PR #33 제품·PR #34 완료 기록은 main/c15fb9e에 통합됐고 노트북 main도 동기화했다. 현재 final-plan S3의 EC2 배포와 실제 HTTPS 점진 전달 확인을 진행한다.
- 단일 EC2 운영 담당은 연결된 캡스톤-개발이다. 설계는 노트북 C:/Users/jehee/vscode-workspace/welfare_helper의 codex/fix-chat-stream을 main/c15fb9e로ff-only맞춰 문서4개만 작성한다. 개발은로컬checkout/Git/index/문서를수정하지않는다.
- 배포기준 c15fb9e, 기존EC2확인기준b82b391이다. API/chat경로에만 변경이 있어worker처리경로불변이면backend만교체한다. 기존모델·GPU·runtime·인증·수집ON·데이터·Caddy/Ollama·B11백업과rollback수단을보존한다.
- 준비도 확인 뒤 민감정보 없는 합성 공개질문1건·600초상한·재시도0으로 accepted/첫draft/final 시각을 확인한다. 실제RAG정확도평가/Chrome/음성·DB복구/새다운로드/재부팅은실행하지않는다. [착수 기록](devlog.md#log-20261115-stream-deploy-start)

## 구현·배포 기준과 보존할 변경

- EC2 `/home/ubuntu/welfare_helper`는 main/b82b391이며 index/작업 트리는 깨끗하다. 실행 backend·worker의 BackEnd118파일이 대상 main과 일치한다. 이전f11e8af 실행 소스와 달리 리팩토링 main이 운영에 반영된 상태다.
- 현재 backend 이미지는 `310f5c7a3a12fbe917f5a0c586f563ee34139a19d500ae4ffc4a03d678043a20`, worker는 `f36e1939db5bd56292430c21d3c97d23ea1b1a9651d1cefbdf9c4a54ab192172`이다. 기존 의존성 레이어와 환경·인증·볼륨·모델/GPU를 유지했고 부팅스크립트는 두 이미지ID만 갱신했다. Ollama/edge는 미교체·미재기동이며 systemd active/enabled다.
- B안11파일은 배포 checkout에서 분리하고 EC2 `.local/co-op/checks-runtime/ec2-main-b82b391-20261112`에 원본tar·binary patch·기준SHA·hash로 보존했다. diff SHA256은 `4ff7518bfb5505c4b0a106eb4217fd6808e7e096e492e5b5717860d8200b3bd4`이며 별도 staging에서 복구를 검증했다. Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 이전 컨테이너 `welfare-backend-rollback-b82b391`·`welfare-document-worker-rollback-b82b391`와 이미지·부팅스크립트 백업도 보존한다. 백업은 root 전용이며 비밀 포함 원자료를 일반 출력하지 않는다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel welfare7/welfare-helper의 제품main/0e54cd4 production은02:27 조회에서 READY였다. 배포ID는 dpl_7ZRcoSnikU3D1stGZz88gsMWE6oM이며 `welfare-helper-iota.vercel.app` alias 연결을 확인했다. 관리자 로그인·실제 웹/API 종단은 미실측이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. S3의EC2배포·기존HTTPS를통한첫draft/final도착확인범위를정해진행한다. 제품main기준은6e808d7이며추가완료기록커밋은제품변경이아니다. 기존EC2의B11백업·이미지pin·환경/모델/DB를보존한다. 실제운영반영/추론은아직미실행이다.
2. 운영 상태는11월12일 성공 실측 기준이며11월13일SSH 조회는timeout이었다. 이번에 운영 재확인은 하지 않았다. 계획의 실제 표시/청취·기록 확인을 완료로 미리 표시하지 않는다.

backend 교체로 메모리 관리자 세션은 다시 로그인해야 할 수 있다. 필요 시 root 전용 백업의 rollback.sh를 검토하되 실행 전 worker 유휴 확인이 필요하며 이번에는 복구를 실제 실행하지 않았다. 이미지 복구와 Git main의 버전은 별개다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.

pgvector 이미지 다운로드와 worker·DB 복구 자동시험은 보류한다.
