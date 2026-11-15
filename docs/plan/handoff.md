# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-15 21:58 KST

전체 계획·잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 팀원 성능 개선 PR #35와 이전 배포 기록 PR #36을 main/6653c15로 통합했다. 로컬 main과 EC2 main을 해당 SHA로 동기화했고 EC2 정상 설정 복원·배포를 완료했다. 이번 완료 기록은 설계가 codex/fix-chat-stream에서 문서 PR로 공유한 뒤 양쪽 main을 문서만 ff-only 동기화한다.
- backend/worker/Ollama healthy, edge running, 모두 재시작 횟수 0이다. 내부 readiness 200·공개 HTTPS health 정상, systemd active/enabled와 이미지 pin 일치를 확인했다. 서비스 상태 확인을 실제 모델 답변·Chrome 성공으로 확대하지 않는다. [현재 결과](devlog.md#log-20261115-team-restored)
- 연락처 기록 ON, 기존 영속 관리자 인증 파일·CORS를 복원했다. 정상 runtime 대비 변경은 RERANK_THREADS=4 하나다. 기존 인증 파일 내용·실제 .env는 읽거나 편집하지 않았다. 기존 관리자 세션은 backend 교체로 재로그인이 필요할 수 있다.
- 캡스톤-개발이 단일 운영 담당으로 배포를 마치고 쓰기를 종료했다. 설계는 공유 문서와 로컬 Git만 담당한다. 문서 최종 동기화는 서비스 재빌드·재기동 없이 수행한다.

## 구현·배포 기준과 복구 자료

- 제품 기준은 main/6653c1526a77ed14e9f31c611cb844c431474a08이며 실행 BackEnd 120파일이 일치한다. backend 이미지 359c004cdadbf304fc9f7681f51de7e3b0345b2bad5f875ae58adc41b87d731a, 컨테이너 22b8dd41…다. 정상 이미지 01102905의 의존성 층 위에 코드만 교체했다.
- worker 이미지 f36e1939, Ollama 31b0205a, edge 15d9f110은 기존 컨테이너·설정·볼륨을 유지하고 기동만 했다. backend 이미지 pin만 갱신했으며 실제 재부팅은 시험하지 않았다.
- 발견된 외부 변경 backend는 welfare-backend-external-before-6653c15로 중지 보존했다. 변경 주체는 미확정이다. 정상 runtime·외부 변경 runtime·pin·검사 원자료는 EC2 .local/co-op/checks-runtime/ec2-restore-team-20261115에 root 전용으로 보존한다. 비밀 포함 snapshot을 일반 출력하거나 공유하지 않는다.
- B11 patch/tar 해시는 보존 확인했다. 자료 위치는 EC2 .local/co-op/checks-runtime/ec2-main-b82b391-20261112이며 Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 과거 backend 컨테이너 일부는 이번 조회에서 없었으므로 과거 인계의 컨테이너 존재를 복구 전제로 삼지 않는다. 정상 이미지와 남아 있는 worker rollback은 보존했다.
- 확장은 Extension/, 운영 API는 https://15.164.190.21이다. 실제 Chrome 재로드·음성은 이번에 확인하지 않았다. 관리자 웹은 welfare-helper-iota.vercel.app이며 이번에 Vercel 배포 상태나 실제 로그인을 재확인하지 않았다.

## 다음 작업과 보류

1. 완료 기록 PR을 통합하고 로컬·EC2 main을 문서만 동기화한다. 그 뒤 S4 추천질문 개선 범위와 미확인 사용자·관리자 흐름을 final-plan에 따라 진행한다.
2. 이번 성능 개선 후 실제 지연·후속 질문 품질·Chrome/음성·관리자 로그인·연락처 DB 기록 조회는 미검증이다. 이전 cold 단건의 첫 draft 194.266초/final 206.219초는 개선 전 기록이다.
3. RAG 정확도/B안 채택·별도 연락처 CSV/W03 매핑·pgvector 다운로드·worker/DB 복구 자동시험은 계속 보류한다. production 비밀번호 회전·실제 재부팅도 이번에 수행하지 않았다.
