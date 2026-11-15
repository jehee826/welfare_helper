# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-15 16:12 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 문서 PR #32는 main/a497bb1로 병합됐고 codex/deploy-refactor-main은 로컬·원격 삭제 완료했다. 문서 정정 S0의 로컬/main 반영은 완료이며 EC2의 문서-only pull은 이번에 하지 않았다.
- 현재 노트북 root는 C:/Users/jehee/vscode-workspace/welfare_helper, Git디렉터리는 .git, 작업 브랜치는 codex/fix-chat-stream이다. main/a497bb1에서 생성하고 팀원 claude/feat-chat-stream/c9abd74를 이력 보존 merge한 기준은7f760ab이다. 상대 원격 브랜치는 유지한다.
- final-plan S1 최소 보완과 S2 로컬 집중검사를 완료했다. 개발이 작성권을 반환한 뒤 설계가4파일diff·원로그를검토해7ec23c3으로선별커밋했다. 제품은PR #33으로main/6e808d7에병합완료했다. 최종head56d7f2f의CI4job과Vercel상태success를확인했다. 현재codex/fix-chat-stream은완료기록공유용이며기록통합후로컬main으로복귀한다. EC2배포는아직없다. 설계가문서4개·리뷰·Git을맡는다. [결과](devlog.md#log-20261115-s1-result)
- 기존 NDJSON accepted/draft/final/error·final-only 저장/기록 계약과 main의 공개/관리자·프로필/문서버전·취소/gate를 유지한다. 새 서버 검사의 CI 선정, JSON status 순서, 스트림 종료 경계가 우선 범위다. 실제 모델/DB/EC2·Chrome·운영 배포는 이번 단계에서 실행하지 않는다.
- 상세 작업·완료 기준은 [final-plan](final-plan.md), 실제 진행은 [S0 완료·S1 착수](devlog.md#log-20261115-s1-start)를 따른다.

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
