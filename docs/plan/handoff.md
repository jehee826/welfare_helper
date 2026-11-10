# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-10 14:17 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- F8 코드 완료: 확장의 공개/관리자 상담 구분을 제거하고 저장 profile이 있으면 사용 토글을 바로 조작할 수 있게 했다. 중복 저장 중에만 잠시 비활성화한다. 명시 ON 뒤 기존 최종 LLM 전달을 유지한다. EC2·로컬 제품 커밋은 125b399이며 원격은 아직 1a0cf62다. 소스와 diff만 읽었고 테스트·구문검사·실행·배포는 하지 않았다. [변경 범위](devlog.md#log-20261110-1405-profile-simple)
- 전체 질문 주제를 한 문장으로 요약하는 프롬프트의 원격·EC2 운영 반영을 완료했다. 실행 컨테이너의 프롬프트 일치·healthy·HTTPS 200을 확인했고 모델 출력 시험은 하지 않았다. [배포 결과](devlog.md#log-20261110-1332-summary-deploy)
- W14 기록 테이블 연결과 backend/worker 수집 ON을 완료했다. 인증된 관리자 조회 200·비로그인 401을 확인했다. 실제 상담의 첫 연락처 기록과 Chrome 화면은 사용자 확인이 남는다. [활성화 결과](devlog.md#log-20261110-1338-referrals-on)
- 활성 계획/진행/인계는 이 세 파일만 사용하며 설계가 단일 작성자다. 개발에는 새 지침 재로딩과 고정 문서 역할을 다시 전달했다. [문서 통합·재로딩 기록](devlog.md#log-20261110-1046-f8b909)

## 구현·배포 기준과 보존할 변경

- 로컬루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, EC2 `/home/ubuntu/welfare_helper`, 브랜치 `codex/fix-merge`다. 운영 backend 소스 기준은 `f11e8af`, 원격 공유는 기록 포함 `1a0cf62`다. 새 확장 제품 `125b399`는 EC2·로컬에만 있으며 미push다. B11은 보존하고 로컬/EC2 Git 조작을 직렬화한다.
- backend는 f11e8af 커밋 소스 기반 `595f3713aa4f2a2ddc2af61d479b6a8bcb9a88647ef4f88cf9d6497501e6546c`, worker 이미지는 기존 `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`다. 두 서비스는 기록 설정 true로 재생성했고 healthy다. backend 부팅 이미지 pin과 Docker 영속 설정을 반영했다. Ollama/edge·기존 모델·문서/벡터·볼륨은 유지했고 재부팅 시험은 하지 않았다.
- 확장은 기존 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. [이전 메뉴 변경 CI](https://github.com/jehee826/welfare_helper/actions/runs/42746898662)는 4job 성공이며 이번 요약/운영 변경의 시험 결과를 대신하지 않는다. 최신 모델·Chrome·CI 시험은 하지 않았다.
- 기존 `Extension/README.md`·`docs/design/extension.md`를 실제 반영 계약으로 확정해 이 기록과 함께 공유한다. 모든 상세 검사·실패·수정과 원자료 위치는 일지를 따른다.
- EC2 실패 B안11파일과 원자료는 보존 상태다. Backend UI 검사1줄만 baseline 기준으로 커밋했고 B안 제품코드는 포함하지 않았다. 원본11 백업·나머지10 작업해시 동일·겹침1의 의도된 UI 단언 차이를 유지한다.
- 관리자 최신 UI는 fix-merge preview, production 관리자 도메인은 main 기존본이다. 기존 비밀번호와 영속 인증은 유지했고 W14 수집은 ON이다. backend 재생성으로 기존 관리자 세션이 만료됐을 수 있으므로 다시 로그인한다. 비밀번호 회전·실자료 재적재는 하지 않았다.

## 바로 다음에 할 일

1. 사용자가 기존 확장을 다시 로드하고 복지로 F5 뒤 요약 창의 요약하기를 직접 시험한다.
2. 연락처가 안내되는 새 상담 이후 관리자 연락처 안내 기록에서 조회한다. 수집 ON 이전의 대화는 소급 기록하지 않는다. 별도 CSV는 보류한다.
3. 최종 main PR과 별도 사용자 웹·RAG/CSV는 자동 착수하지 않는다. 추가 모델/Chrome/CI 시험은 하지 않는다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 기존 운영 기록 기능은 활성화 완료이며 실제 상담 1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측은 별개로 유지한다. 상세 근거는 계획의 일지 링크를 따른다.
