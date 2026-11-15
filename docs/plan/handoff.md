# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-15 23:50 KST

전체 계획·잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 기존 동일 질문2건 재측정 완료. 모델 상주 상태에서 기초연금 first12.547/final22.328초·answer, 50대 first6.313/final9.000초·no_evidence였다. 두 본문은 이전run3/run4와 동일하며 50대 추천 실패가 재현됐다. 설계가 raw 결과를 대조했고 구현은 아직 없다. [결과](devlog.md#log-20261115-speed-baseline-repeat)

- 현재 작업 브랜치는 사용자 지정 fix/rag-speed다. 기준 main/ec658f0에서 생성하고 이전 미공유 측정 문서 a28220d·9d0acc6을 이력 보존으로 이어받았다. main에 병합된 원격 codex/fix-chat-stream은 삭제했고 팀원 원격 브랜치는 이미 삭제돼 있었다. 이전 로컬 문서 브랜치는 보존했다. [전환 기록](devlog.md#log-20261115-rag-speed-branch)
- 목표는 답변 품질을 유지하는 RAG 속도 개선이다. 다음 과제는 50대 서비스 질문이 no_evidence로 끝난 검색·근거 선정 경로를 확인하고, 동일 조건 비교 기준을 정한 뒤 병목별로 최소 변경하는 것이다. 제품 구현·새 측정·EC2 운영 변경은 아직 시작하지 않았다. 설계는 문서 작성·검토 담당이며 개발 실행 담당은 착수 전에 확정한다.
- 원격 main·로컬 main·EC2의 마지막 확인 기준은 ec658f0, 제품6653c15/backend359c004c다. 이번 브랜치 준비로 운영은 바뀌지 않았다. 기존 모델 상주 상태의 기초연금 final18.312/22.266초는 개별 관측이다. 50대 질문 final14.531초는 fallback/no_evidence로 추천 성공이 아니다. [warm](devlog.md#log-20261115-warm-recheck) / [광범위 질문](devlog.md#log-20261115-broad-query)
- 이전 측정은 모두 종료했고 원자료는 로컬 .local/co-op/checks-runtime/speed-combined-90cc66c-20261115에 보존했다. 마지막 운영 확인 당시 backend/worker/Ollama healthy·edge running·재시작0, 연락처 기록 ON·기존 영속 인증/CORS·threads4였다. 이번에 운영 상태를 재측정하지 않았다.
## 구현·배포 기준과 복구 자료

- 제품 기준은 main/6653c1526a77ed14e9f31c611cb844c431474a08이며 실행 BackEnd 120파일이 일치한다. backend 이미지 359c004cdadbf304fc9f7681f51de7e3b0345b2bad5f875ae58adc41b87d731a, 컨테이너 22b8dd41…다. 정상 이미지 01102905의 의존성 층 위에 코드만 교체했다.
- worker 이미지 f36e1939, Ollama 31b0205a, edge 15d9f110은 기존 컨테이너·설정·볼륨을 유지하고 기동만 했다. backend 이미지 pin만 갱신했으며 실제 재부팅은 시험하지 않았다.
- 발견된 외부 변경 backend는 welfare-backend-external-before-6653c15로 중지 보존했다. 변경 주체는 미확정이다. 정상 runtime·외부 변경 runtime·pin·검사 원자료는 EC2 .local/co-op/checks-runtime/ec2-restore-team-20261115에 root 전용으로 보존한다. 비밀 포함 snapshot을 일반 출력하거나 공유하지 않는다.
- B11 patch/tar 해시는 보존 확인했다. 자료 위치는 EC2 .local/co-op/checks-runtime/ec2-main-b82b391-20261112이며 Grounded/items/strict_json 실험은 운영에 채택하지 않았다. 과거 backend 컨테이너 일부는 이번 조회에서 없었으므로 과거 인계의 컨테이너 존재를 복구 전제로 삼지 않는다. 정상 이미지와 남아 있는 worker rollback은 보존했다.
- 확장은 Extension/, 운영 API는 https://15.164.190.21이다. 실제 Chrome 재로드·음성은 이번에 확인하지 않았다. 관리자 웹은 welfare-helper-iota.vercel.app이며 이번에 Vercel 배포 상태나 실제 로그인을 재확인하지 않았다.

## 다음 작업과 보류

1. fix/rag-speed에서 공개 자료의 실제 검색 포함 여부와 50대 질문의 후보 탈락·최종 근거 선정을 검토한다. 속도와 추천 적합성을 함께 확인할 비교 조건·변경 파일·작성자/검토자·완료 기준을 정한다.
2. 그 뒤 가장 큰 반복 비용부터 한 가지씩 개선한다. 후보/근거 수 축소나 짧은 실패 응답을 속도 개선으로 판정하지 않는다. 기존 모델·운영 주소·개인정보/동의·문서 버전 경계를 유지한다.
3. 이번 범위의 RAG 품질·속도 검토는 사용자 지시로 재개한다. 별도 연락처 CSV/W03·pgvector 다운로드·worker/DB 복구 자동시험·production 비밀번호 회전·실재부팅은 별도 보류를 유지한다.
