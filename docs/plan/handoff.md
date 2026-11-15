# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-15 22:46 KST

전체 계획·잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 사용자 지정 50대 서비스 질문은 첫 draft11.859/final14.531초에 fallback/no_evidence로 끝났다. 서버 오류·입력 예산 초과는 없었지만 서비스 추천 성공도 아니다. 전체 문서 부재를 입증한 결과는 아니며 실제 선택 근거 전문은 미수집이다. 추가 수정/재요청은 하지 않았다. 이전 warm 결과와 함께 문서 브랜치에만 기록하며 원격/EC2 main은 ec658f0다. [결과](devlog.md#log-20261115-broad-query)

- 문서 PR #38까지 main/ec658f0 동기화 완료. 사용자 요청의 모델 상주 재측정 1회를 마쳤다. Qwen·BGE 상주 확인 후 준비 호출 없이 첫 draft12.156/final22.266초, 검색0.389/리랭킹3.579/생성14.313초였다. 실제 요청1회·재시도0이며 운영 상태는 유지했다. [결과](devlog.md#log-20261115-warm-recheck)

- 원격·로컬·EC2는 문서 PR #37까지 main/90cc66c로 동기화했다. 제품은6653c15, backend359c004c다. 정상 설정 복원·배포 후 개발 세션이 최신 결합 버전의 속도 측정 2회를 완료했다. 설계는 codex/fix-chat-stream에서 이번 결과 문서만 작성한다.
- 같은 질문의 모델 비상주 첫 요청은 첫 draft190.641/final202.297초, 직후 동일 입력은8.250/18.312초였다. 이전 cold final206.219초 대비 약1.9% 감소다. 리랭킹12.900→9.580초로 줄었지만 생성167.698초가 cold 병목으로 남았다. [측정 결과·한계](devlog.md#log-20261115-speed-result)
- warm18.312초는 모델 상주·반복 입력/캐시·출력량 차이가 포함된 단건이다. 리랭커4 단독 효과나 모든 질문의 보장 시간으로 해석하지 않는다. 이력 없는 질문이므로 맥락 조기종료/400자 축소 효과도 미검증이다. 과거 대표3문항 원자료는 지정 위치에 없어 재구성하지 않았다.
- backend/worker/Ollama healthy, edge running·재시작0·기존 컨테이너/StartedAt 유지, EC2 main clean을 측정 종료 후 확인했다. 연락처 기록 ON·기존 영속 인증/CORS·threads4는 그대로다. 실제 .env·인증 내용·코드·설정·서비스를 변경하지 않았다.
- 개발의 실제 측정은 두 프로세스 exit0으로 종료했고 추가 호출은 없다. 원자료는 로컬 .local/co-op/checks-runtime/speed-combined-90cc66c-20261115에 보존했다. 설계가 두 응답 요약·서버 단계 결과를 대조해 기존 문서만 갱신한다.
## 구현·배포 기준과 복구 자료

- 제품 기준은 main/6653c1526a77ed14e9f31c611cb844c431474a08이며 실행 BackEnd 120파일이 일치한다. backend 이미지 359c004cdadbf304fc9f7681f51de7e3b0345b2bad5f875ae58adc41b87d731a, 컨테이너 22b8dd41…다. 정상 이미지 01102905의 의존성 층 위에 코드만 교체했다.
- worker 이미지 f36e1939, Ollama 31b0205a, edge 15d9f110은 기존 컨테이너·설정·볼륨을 유지하고 기동만 했다. backend 이미지 pin만 갱신했으며 실제 재부팅은 시험하지 않았다.
- 발견된 외부 변경 backend는 welfare-backend-external-before-6653c15로 중지 보존했다. 변경 주체는 미확정이다. 정상 runtime·외부 변경 runtime·pin·검사 원자료는 EC2 .local/co-op/checks-runtime/ec2-restore-team-20261115에 root 전용으로 보존한다. 비밀 포함 snapshot을 일반 출력하거나 공유하지 않는다.
- B11 patch/tar 해시는 보존 확인했다. 자료 위치는 EC2 .local/co-op/checks-runtime/ec2-main-b82b391-20261112이며 Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 과거 backend 컨테이너 일부는 이번 조회에서 없었으므로 과거 인계의 컨테이너 존재를 복구 전제로 삼지 않는다. 정상 이미지와 남아 있는 worker rollback은 보존했다.
- 확장은 Extension/, 운영 API는 https://15.164.190.21이다. 실제 Chrome 재로드·음성은 이번에 확인하지 않았다. 관리자 웹은 welfare-helper-iota.vercel.app이며 이번에 Vercel 배포 상태나 실제 로그인을 재확인하지 않았다.

## 다음 작업과 보류

1. 이번 측정 결과를 문서 변경만으로 공유하고 main을 동기화한다. 성능 후속 우선순위는 cold 생성 구간의 모델 준비·입력 처리·출력 생성을 구분하는 것이다. 기존 logger에서 세부 시간이 제공되지 않아 이번에는 미수집이며 추가 계측을 구현하지 않았다.
2. S4 추천질문 개선, 실제 Chrome/음성·관리자 로그인·연락처 DB 기록 조회는 남아 있다. 이번 속도 측정을 정확도나 실제 사용자 흐름 통과로 확대하지 않는다.
3. RAG 정확도/B안 채택·별도 연락처 CSV/W03 매핑·pgvector 다운로드·worker/DB 복구 자동시험은 계속 보류한다. production 비밀번호 회전·실제 재부팅도 이번에 수행하지 않았다.
