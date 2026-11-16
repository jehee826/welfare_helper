# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-16 17:32 KST

전체 계획·잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 요청·모델별 내부 시간 로그 구현, PR #39 main 병합, EC2 backend 배포와 승인된 실제 질의5회가 완료됐다. 제품 기준 main/e89ed02이며 모든 질의는 answer·정상 전송 종료였다. 목적별 모델 시간, 검색, 리랭커 잠금 대기/처리, 첫 draft와 서버 응답 종료를 같은 내부ID로 추적했다. 이번 변경은 관측 보완이며 속도 최적화 자체는 아니다. [구현·검사](devlog.md#log-20261116-timing-implementation) / [통합·배포·실패](devlog.md#log-20261116-timing-rollout) / [실측 결과·한계](devlog.md#log-20261116-timing-result)
- 실제 질의는 시험 전담 Terra1명이 단건1·동시3·합성후속1, 재시도0·워밍업0으로 종료했다. 개발·시험의 Git/index/운영 작성권은 반환됐고 설계만 기존3문서 마감·원격 통합·문서 동기화를 진행한다. 추가 추론·재기동은 하지 않는다. 원자료는 로컬 .local/co-op/checks-runtime/timing-candidate-e89ed02-20261116에 보존한다.
- 단건 final29.765초에는 BM25 인덱스 최초 준비8.802초가 포함됐다. 모델 상주가 앱 캐시까지 warm이라는 뜻은 아니다. 동시3건 final25.125/33.218/42.250초, 리랭커 잠금 대기 합0/3.502/8.538초, 최종 LLM 호출15.355/18.545/23.558초였다. 후속은 맥락 LLM3.320초·최종 LLM11.349초, final21.516초다. 동시 클라이언트와 서버ID의 직접 매핑은 없으며 위 병렬값은 각각 완료 순서 관측이다.
- 누락/정확도 수정은 사용자 지시로 보류하고 응답 속도를 우선한다. 기존 50대 질문의 no_evidence는 미해결이다. 현재 API 동시3·리랭커 요청 내부4/호출간Lock·Ollama1/queue3·임베딩CPU·기존 모델을 유지했다. native 세부 합의 잔여를 정확한 FIFO 대기시간으로 부르지 않는다.
- 작업 root는 C:/Users/jehee/vscode-workspace/welfare_helper, 담당 브랜치는 사용자 지정 fix/rag-speed다. 설계는 문서·검토·승인된 Git 통합, 개발은 제품 구현과 운영 담당이다. 이번 후속 문서 PR 뒤 로컬 main·작업 브랜치·EC2 main을 ff-only 동기화한다. 브랜치는 후속 속도 개선용으로 보존하고 미공유 과거 로컬 문서 브랜치도 삭제하지 않는다.

## 구현·배포 기준과 복구 자료

- 제품/실측 기준 main/e89ed02c9d5078ac11d0b8214bcbc104be708d6d. backend 이미지31b1f5245278ab1e4ff0930f82a50af572c927c4b72ecedc1b39dafdc421323c, 컨테이너ed7abae11829b697ea20f59d985d5da7ac68d4a802290874fee5096c9a73cb67, 2026-11-16 17:18 KST 기동이다. BackEnd 소스120파일 일치·import·내부 /health 및 /health/ready 200·PC HTTPS /health 200과 CA/IP 검증을 확인했다. 실측 후에도 HEAD/컨테이너/StartedAt 불변·4서비스 running·시험 프로세스 종료를 확인했다.
- 기존 기록ON·영속 인증/CORS·threads4·모델/GPU·임베딩CPU·데이터를 유지했다. worker 이미지f36e1939, Ollama31b0205a, edge15d9f110의 컨테이너·설정·StartedAt은 바꾸지 않았다. backend 이미지 pin만 갱신했으며 pin 해시는cb2b60d6cfc4f17f414e7ce2454a525bbc92226a428c60290ac92c3fb95aa761, systemd active/enabled다. 실제 재부팅은 미시험이다.
- 직전 backend359c004c는 welfare-backend-before-timing-e89ed02로 중지 보존했다. 배포 guard·기본값 정규화·잘못된 readiness URL과 두 차례 복구 이력도 일지와 EC2/로컬 .local/co-op/checks-runtime/ec2-timing-e89ed02-20261116에 보존했다. 비밀 포함 runtime 사본은 원격 root 전용이며 일반 출력·공유하지 않는다.
- 이전 외부 변경 backend는 welfare-backend-external-before-6653c15로 중지 보존했다. 변경 주체는 미확정이다. 이전 정상/외부 runtime·검사자료는 EC2 .local/co-op/checks-runtime/ec2-restore-team-20261115에 보존한다. B11 patch/tar 해시와 자료는 .local/co-op/checks-runtime/ec2-main-b82b391-20261112에 남겼으며 Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 과거 컨테이너 일부 부재를 확인했으므로 과거 이름만으로 복구 가능하다고 가정하지 않는다.
- 확장은 Extension/, 운영 API는 https://15.164.190.21, 관리자 웹은 welfare-helper-iota.vercel.app이다. 이번에는 실제 Chrome 재로드·음성·Vercel 배포·관리자 로그인은 재확인하지 않았다.

## 다음 작업과 보류

1. 이번 결과 문서 통합과 문서만의 ff-only 동기화를 마무리한다. 제품 재빌드·재기동·추론을 반복하지 않는다.
2. 후속 속도 개선은 리랭커 호출간 잠금과 최종 LLM의 실제 연산/대기를 우선 검토해 한 가지씩 최소 변경한다. 최초 앱 인덱스 준비와 모델 cold start를 구분하고 프롬프트 캐시·출력 토큰 수를 맞춰 비교한다. 검색 후보/근거 축소·짧은 실패 응답을 성능 향상으로 판정하지 않는다. 다음 구현/운영 측정은 범위를 정해 진행한다.
3. 50대 검색 누락·RAG 정확도, 별도 연락처 CSV/W03·pgvector 다운로드·worker/DB 복구 자동시험·production 비밀번호 회전·실제 재부팅은 보류를 유지한다. 기존 모델·운영 주소·개인정보/동의·문서 버전 경계를 보존한다.
