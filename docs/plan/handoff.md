# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-15 21:40 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 팀원PR #35는main/55124fc로병합완료했다(CI4job성공). 우리미공유배포기록2커밋과이번통합기록은codex/fix-chat-stream에서한번에문서PR로공유한다. 로컬main은그병합본으로ff-only동기화한다.
- EC2동기화는설정확인대기다. 21:43실제조회에서Git main/c15fb9e clean이나canonical backend는직전정상01102905와다른98f9ec87이미지였고기록OFF/영속인증경로빈값/RERANK_THREADS4였다. backend·worker·Ollama·edge모두exited였다. 변경주체/의도는미확정이다.
- 캡스톤-개발은읽기진단만수행했고운영쓰기를중단했다. 사용자에게직전정상기록ON/영속인증복원또는현재설정유지방향을확인중이다. 답변전서비스재생성/설정복원/재기동을하지않는다. EC2변경은git fetch뿐이며55124fc pull/배포는아직없다.
- 직전정상배포의HTTPS단건은accepted0.125/첫draft194.266/final206.219초·draft11회였다. 이는현재21:43의정상가동보증이아니다. 새실제질문·벤치마크는이번최소최신화에서수행하지않는다. [현재 진행](devlog.md#log-20261115-team-sync)

## 구현·배포 기준과 보존할 변경

- EC2 `/home/ubuntu/welfare_helper`는 main/c15fb9e이고 index/작업 트리는 깨끗하다. 실행 backend의BackEnd120파일이대상main과일치한다. worker는영향경로불변으로이전b82b391소스이미지를의도적으로유지했다.
- 16:46 마지막 정상 확인 당시 backend 이미지는 `011029050c523f71dcfd7513bb928738b80088f45a9eda830916b2c89f6123c5`, worker는 `f36e1939db5bd56292430c21d3c97d23ea1b1a9651d1cefbdf9c4a54ab192172`이다. 기존 의존성 레이어와 환경·인증·볼륨·모델/GPU를 유지했고 이번부팅스크립트는backend 이미지ID1개만갱신했다. Ollama/edge는 미교체·미재기동이며 systemd active/enabled다.
- B안11파일은 배포 checkout에서 분리하고 EC2 `.local/co-op/checks-runtime/ec2-main-b82b391-20261112`에 원본tar·binary patch·기준SHA·hash로 보존했다. diff SHA256은 `4ff7518bfb5505c4b0a106eb4217fd6808e7e096e492e5b5717860d8200b3bd4`이며 별도 staging에서 복구를 검증했다. Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 이전 컨테이너 `welfare-backend-rollback-b82b391`·`welfare-document-worker-rollback-b82b391`와 이미지·부팅스크립트 백업도 보존한다. 백업은 root 전용이며 비밀 포함 원자료를 일반 출력하지 않는다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel welfare7/welfare-helper의 제품main/0e54cd4 production은02:27 조회에서 READY였다. 배포ID는 dpl_7ZRcoSnikU3D1stGZz88gsMWE6oM이며 `welfare-helper-iota.vercel.app` alias 연결을 확인했다. 관리자 로그인·실제 웹/API 종단은 미실측이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. 사용자설정선택후이전정상snapshot/pin/인증볼륨과현재차이를보존해최종main을EC2에동기화하고필요서비스를기동한다. 선택값외환경을임의평준화하지않는다. 이전초안지연/실제UI확인은그뒤후속범위다.
2. 이번16:39~16:42의운영실측은HTTPS수신까지다. Chrome/음성·관리자실제기록조회/DB행대조는미검증으로남긴다. 응답연락처1개를DB기록1건성공으로확대하지않는다.

backend 교체로 메모리 관리자 세션은 다시 로그인해야 할 수 있다. 필요 시 root 전용 백업의 rollback.sh를 검토하되 실행 전 worker 유휴 확인이 필요하며 이번에는 복구를 실제 실행하지 않았다. 이미지 복구와 Git main의 버전은 별개다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.

pgvector 이미지 다운로드와 worker·DB 복구 자동시험은 보류한다.

이번backend복구는EC2 `.local/co-op/checks-runtime/ec2-chat-stream-c15fb9e-20261115`의root전용백업·rollback.sh를따른다. `welfare-backend-rollback-c15fb9e`와이전image310f5c7a…를보존했으며복구실행은하지않았다. 진행중상담의정상종료확인뒤복구해야하고Git HEAD와이미지복구는별개다.
