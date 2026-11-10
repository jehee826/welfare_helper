# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-10 15:56 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 현재 `claude/FrontEnd-webchat` 통합ff3d474까지 원격 push했고 기존 PR #19 본문을 갱신했다. 새 Preview는 READY다. 자동 CI의 확장 기대값2건 실패를 검사2파일만 정정했다. 다음은 후속 push·자동 결과 확인·PR #19 병합이다. [통합 기록](devlog.md#log-20261110-1549-webchat-integration) / [실패·정정](devlog.md#log-20261110-1556-webchat-ci)
- 실제 Vercel 운영은 welfare7/welfare-helper(prj_HkwhPJ62wroO3duFqX1qGAujtW0L)이며 welfare-helper-iota.vercel.app은 main9a5ffce production READY다. 본계정 jehee 중복 Git 연결은 해제됐다. 기존 Claude14b8bf8은 BLOCKED였지만 새 통합ff3d474 Preview는 READY다. 실제 UI/API 동작은 새로 확인하지 않았다. [확인 근거](devlog.md#log-20261110-1556-webchat-ci)

- 첫 PR 준비 후속 완료: EC2 ec3e880의 기존 검사 14파일 정합성과 options.html 패키징 정책 1항목 복원을 읽기 검토하고 로컬 계획7582a2d와 통합했다. 이후 69ffb1b까지 원격 push·EC2 동기화를 완료했고 PR #20에 병합했다. 테스트·구문검사·빌드·패키저·실제 추론은 실행하지 않았다. [상세](devlog.md#log-20261110-1501-pr-source)

- F8 코드·push 완료: 확장의 공개/관리자 상담 구분을 제거하고 저장 profile이 있으면 사용 토글을 바로 조작할 수 있게 했다. 중복 저장 중에만 잠시 비활성화한다. 명시 ON 뒤 기존 최종 LLM 전달을 유지한다. F8 제품125b399는 원격 a44aa0f에 포함돼 있으며, 후속 ec3e880도 69ffb1b를 거쳐 원격·EC2에 반영됐다. 소스와 diff만 읽었고 테스트·구문검사·실행·배포는 하지 않았다. [변경 범위](devlog.md#log-20261110-1405-profile-simple)
- 전체 질문 주제를 한 문장으로 요약하는 프롬프트의 원격·EC2 운영 반영을 완료했다. 실행 컨테이너의 프롬프트 일치·healthy·HTTPS 200을 확인했고 모델 출력 시험은 하지 않았다. [배포 결과](devlog.md#log-20261110-1332-summary-deploy)
- W14 기록 테이블 연결과 backend/worker 수집 ON을 완료했다. 인증된 관리자 조회 200·비로그인 401을 확인했다. 실제 상담의 첫 연락처 기록과 Chrome 화면은 사용자 확인이 남는다. [활성화 결과](devlog.md#log-20261110-1338-referrals-on)
- 활성 계획/진행/인계는 이 세 파일만 사용하며 설계가 단일 작성자다. 개발에는 새 지침 재로딩과 고정 문서 역할을 다시 전달했다. [문서 통합·재로딩 기록](devlog.md#log-20261110-1046-f8b909)

## 구현·배포 기준과 보존할 변경

- 로컬루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, Git디렉터리 `.git`, 현재 브랜치는 `claude/FrontEnd-webchat`이며 기준 main은9a5ffce다. 로컬 통합·오류 수정 후 제품 작성권은 설계에 반환됐다. 기존 `codex/fix-merge`는2c292d1로 보존한다. EC2 `/home/ubuntu/welfare_helper`는 `codex/fix-merge`·69ffb1b이며 이번 작업에서 접속·변경하지 않았다. 운영 backend 소스는f11e8af, B11은 계속 보존한다.
- backend는 f11e8af 커밋 소스 기반 `595f3713aa4f2a2ddc2af61d479b6a8bcb9a88647ef4f88cf9d6497501e6546c`, worker 이미지는 기존 `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`다. 두 서비스는 기록 설정 true로 재생성했고 healthy다. backend 부팅 이미지 pin과 Docker 영속 설정을 반영했다. Ollama/edge·기존 모델·문서/벡터·볼륨은 유지했고 재부팅 시험은 하지 않았다.
- 확장은 기존 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. [이전 메뉴 변경 CI](https://github.com/jehee826/welfare_helper/actions/runs/42746898662)는 4job 성공이며 이번 요약/운영 변경의 시험 결과를 대신하지 않는다. 최신 모델·Chrome·CI 시험은 하지 않았다.
- 기존 `Extension/README.md`·`docs/design/extension.md`를 실제 반영 계약으로 확정해 이 기록과 함께 공유한다. 모든 상세 검사·실패·수정과 원자료 위치는 일지를 따른다.
- EC2 실패 B안11파일과 원자료는 보존 상태다. Backend UI 검사1줄만 baseline 기준으로 커밋했고 B안 제품코드는 포함하지 않았다. 원본11 백업·나머지10 작업해시 동일·겹침1의 의도된 UI 단언 차이를 유지한다.
- 관리자 최신 UI는 실제 운영 welfare7의 main9a5ffce production에 배포 READY로 확인됐다. 관리자 로그인·실제 화면 동작을 새로 시험한 것은 아니다. 기존 비밀번호와 영속 인증은 유지했고 W14 수집은 ON이다. backend 재생성으로 기존 관리자 세션이 만료됐을 수 있으므로 다시 로그인한다. 비밀번호 회전·실자료 재적재는 하지 않았다.

## 바로 다음에 할 일

1. 사용자가 기존 확장을 다시 로드하고 복지로 F5 뒤 요약 창의 요약하기를 직접 시험한다.
2. 연락처가 안내되는 새 상담 이후 관리자 연락처 안내 기록에서 조회한다. 수집 ON 이전의 대화는 소급 기록하지 않는다. 별도 CSV는 보류한다.
3. 기존 PR #19로 통합한다. 확장 검사 정정 push 뒤 자동 결과·정확한 HEAD를 확인하고 main에 PR 병합한다. Vercel production을 확인하며 직접 실행 시험은 하지 않는다. 웹은 단발성 기초 RAG로 유지한다. 두 PR 뒤 최종 main의 EC2·노트북·실행 이미지 버전을 맞추되 B11·환경·DB를 보존한다. RAG/CSV는 계속 보류한다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 기존 운영 기록 기능은 활성화 완료이며 실제 상담 1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측은 별개로 유지한다. 상세 근거는 계획의 일지 링크를 따른다.
