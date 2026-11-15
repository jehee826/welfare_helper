# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-15 16:46 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- main/c15fb9e의 EC2 backend 배포와 실제 공개 HTTPS 스트리밍1건 확인을 완료했다. accepted0.125초·첫draft194.266초·final206.219초, draft11회가서로다른시각에도착했다. 모델상주0에서시작한cold단건이며빠른응답목표충족이나품질합격은아니다. [실측 결과](devlog.md#log-20261115-stream-deployed)
- 노트북 root C:/Users/jehee/vscode-workspace/welfare_helper, .git, main기준c15fb9e다. 설계는codex/fix-chat-stream에서배포기록4문서를로컬커밋하고main으로복귀한다. 후속배포기록의원격공유상태는실제Git과완료보고를확인한다.
- backend만교체했고worker/Ollama/Caddy는ID/image/StartedAt과설정을보존했다. 기존worker처리/embedding경로는이번변경영향이없어이전b82b391소스이미지를유지한다. 서비스4개running이며health검사가있는3개healthy다.
- 다음은기존설치확장의최종UI표시·S4추천질문·S5미확인사용흐름이다. 초안대기194초는S3지연후속항목으로남긴다. 추가추론/워밍업/모델튜닝은이번에하지않았다. RAG/CSV/복구보류유지.

## 구현·배포 기준과 보존할 변경

- EC2 `/home/ubuntu/welfare_helper`는 main/c15fb9e이고 index/작업 트리는 깨끗하다. 실행 backend의BackEnd120파일이대상main과일치한다. worker는영향경로불변으로이전b82b391소스이미지를의도적으로유지했다.
- 현재 backend 이미지는 `011029050c523f71dcfd7513bb928738b80088f45a9eda830916b2c89f6123c5`, worker는 `f36e1939db5bd56292430c21d3c97d23ea1b1a9651d1cefbdf9c4a54ab192172`이다. 기존 의존성 레이어와 환경·인증·볼륨·모델/GPU를 유지했고 이번부팅스크립트는backend 이미지ID1개만갱신했다. Ollama/edge는 미교체·미재기동이며 systemd active/enabled다.
- B안11파일은 배포 checkout에서 분리하고 EC2 `.local/co-op/checks-runtime/ec2-main-b82b391-20261112`에 원본tar·binary patch·기준SHA·hash로 보존했다. diff SHA256은 `4ff7518bfb5505c4b0a106eb4217fd6808e7e096e492e5b5717860d8200b3bd4`이며 별도 staging에서 복구를 검증했다. Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 이전 컨테이너 `welfare-backend-rollback-b82b391`·`welfare-document-worker-rollback-b82b391`와 이미지·부팅스크립트 백업도 보존한다. 백업은 root 전용이며 비밀 포함 원자료를 일반 출력하지 않는다.
- 확장은 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. 설치 확장 재로드와 실제 모델·음성 시험은 이번에 하지 않았다. 기존 저장·동의/취소·공개 DOM 계약은 유지한다.
- Vercel welfare7/welfare-helper의 제품main/0e54cd4 production은02:27 조회에서 READY였다. 배포ID는 dpl_7ZRcoSnikU3D1stGZz88gsMWE6oM이며 `welfare-helper-iota.vercel.app` alias 연결을 확인했다. 관리자 로그인·실제 웹/API 종단은 미실측이다. 본계정 중복 Git 연결 해제·기존 인증을 유지한다.

## 바로 다음에 할 일

1. S3운영API배포/점진전달확인은완료했다. 기존Chrome설치/프로필을유지해재로드후실제초안표시·취소·최종저장을확인하고, cold첫응답지연은기존stage메타데이터를기준으로별도후속측정범위를정한다.
2. 이번16:39~16:42의운영실측은HTTPS수신까지다. Chrome/음성·관리자실제기록조회/DB행대조는미검증으로남긴다. 응답연락처1개를DB기록1건성공으로확대하지않는다.

backend 교체로 메모리 관리자 세션은 다시 로그인해야 할 수 있다. 필요 시 root 전용 백업의 rollback.sh를 검토하되 실행 전 worker 유휴 확인이 필요하며 이번에는 복구를 실제 실행하지 않았다. 이미지 복구와 Git main의 버전은 별개다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 운영 기록 기능은 활성화 완료이며 실제 상담1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측도 유지한다. 상세 근거는 계획의 일지 링크를 따른다.

pgvector 이미지 다운로드와 worker·DB 복구 자동시험은 보류한다.

이번backend복구는EC2 `.local/co-op/checks-runtime/ec2-chat-stream-c15fb9e-20261115`의root전용백업·rollback.sh를따른다. `welfare-backend-rollback-c15fb9e`와이전image310f5c7a…를보존했으며복구실행은하지않았다. 진행중상담의정상종료확인뒤복구해야하고Git HEAD와이미지복구는별개다.
