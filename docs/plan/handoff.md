# 현재 작업 인계

작성: 2026-11-09. 최신 업데이트: 2026-11-12 00:38 KST

전체 계획/완료/잔여는 [merge_plan](merge_plan.md), 상세 진행·실패·검사는 [devlog](devlog.md)를 읽는다.

## 지금 상태

- 리팩토링 1번 확장 섹터의 로컬 구현·집중 검증·설계 리뷰를 마쳤다. 루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, 브랜치 `codex/refactor-extension`, 기준 main364cbb8, 제품25f67bc다. 개발은 작성권을 반환했다. 다음은 지정 기능 브랜치의 push 범위 확인·PR 통합이며 2~8번은 대기한다. `refactor.md`에 PR 본문이 있다. [결과](devlog.md#log-20261112-0038-extension-refactor-result)

- 문서853c576도 PR #21로 main에 반영했다. 노트북 Jehee-Laptop과 EC2를 main/c3c8161로 동기화했고 EC2 B11의 원본·diff·status 해시는 동일하다. 현재는 완료 기록만 후속 공유하는 단계이며 제품 기준3c18f4f는 변하지 않았다. 이 기록의 PR 병합 뒤 양쪽 main을 다시 ff-only 동기화하고 완료 브랜치 정리를 마친다. [동기화 기록](devlog.md#log-20261110-1618-main-sync)
- 제품 통합 완료: PR #20에 이어 PR #19를16:01 KST 병합했다. 제품 기준main3c18f4f와 병합 전 head76f9c51의 자동 CI4job 성공을 확인했다. 후속 문서853c576도 PR #21로 공유했다. [병합·검증](devlog.md#log-20261110-1603-pr19-complete)
- 실제 Vercel welfare7/welfare-helper(prj_HkwhPJ62wroO3duFqX1qGAujtW0L)의 main3c18f4f production은 READY이고 기존 welfare-helper-iota.vercel.app alias도 연결됐다. 본계정 jehee 중복 Git 연결은 해제 상태이며 새 Preview도 READY다. 실제 UI/API 종단·음성 동작은 새로 확인하지 않았다. [배포 근거](devlog.md#log-20261110-1603-pr19-complete)

- 첫 PR 준비 후속 완료: EC2 ec3e880의 기존 검사 14파일 정합성과 options.html 패키징 정책 1항목 복원을 읽기 검토하고 로컬 계획7582a2d와 통합했다. 이후 69ffb1b까지 원격 push·EC2 동기화를 완료했고 PR #20에 병합했다. 테스트·구문검사·빌드·패키저·실제 추론은 실행하지 않았다. [상세](devlog.md#log-20261110-1501-pr-source)

- F8 코드·push 완료: 확장의 공개/관리자 상담 구분을 제거하고 저장 profile이 있으면 사용 토글을 바로 조작할 수 있게 했다. 중복 저장 중에만 잠시 비활성화한다. 명시 ON 뒤 기존 최종 LLM 전달을 유지한다. F8 제품125b399는 원격 a44aa0f에 포함돼 있으며, 후속 ec3e880도 69ffb1b를 거쳐 원격·EC2에 반영됐다. 소스와 diff만 읽었고 테스트·구문검사·실행·배포는 하지 않았다. [변경 범위](devlog.md#log-20261110-1405-profile-simple)
- 전체 질문 주제를 한 문장으로 요약하는 프롬프트의 원격·EC2 운영 반영을 완료했다. 실행 컨테이너의 프롬프트 일치·healthy·HTTPS 200을 확인했고 모델 출력 시험은 하지 않았다. [배포 결과](devlog.md#log-20261110-1332-summary-deploy)
- W14 기록 테이블 연결과 backend/worker 수집 ON을 완료했다. 인증된 관리자 조회 200·비로그인 401을 확인했다. 실제 상담의 첫 연락처 기록과 Chrome 화면은 사용자 확인이 남는다. [활성화 결과](devlog.md#log-20261110-1338-referrals-on)
- 활성 계획/진행/인계는 이 세 파일만 사용하며 설계가 단일 작성자다. 개발에는 새 지침 재로딩과 고정 문서 역할을 다시 전달했다. [문서 통합·재로딩 기록](devlog.md#log-20261110-1046-f8b909)

## 구현·배포 기준과 보존할 변경

- 노트북 Jehee-Laptop 루트 `C:/Users/jehee/vscode-workspace/welfare_helper`, Git디렉터리 `.git`, EC2 루트 `/home/ubuntu/welfare_helper`다. 양쪽 인계 브랜치는 main이며 제품 기준3c18f4f 뒤 변경은 기록 문서뿐이다. EC2는 main/c3c8161 동기화와 로컬 기능 브랜치4개 삭제를 확인했고 B11은 그대로 보존했다. 운영 backend 소스는f11e8af이며 실행 이미지는 Git HEAD와 별개다.
- backend는 f11e8af 커밋 소스 기반 `595f3713aa4f2a2ddc2af61d479b6a8bcb9a88647ef4f88cf9d6497501e6546c`, worker 이미지는 기존 `5ae7df5b290797e2249ac5489cae09299a9fb95aed4ddbb6359eb2ce5ae9e820`다. 두 서비스는 기록 설정 true로 재생성했고 healthy다. backend 부팅 이미지 pin과 Docker 영속 설정을 반영했다. Ollama/edge·기존 모델·문서/벡터·볼륨은 유지했고 재부팅 시험은 하지 않았다.
- 확장은 기존 `Extension/`, MV3/0.1.0, API `https://15.164.190.21`이다. PR #19의 head76f9c51 [자동 CI](https://github.com/jehee826/welfare_helper/actions/runs/42772081069)는 4job 성공이다. 모델·Chrome 실제 시험은 하지 않았으며 자동 CI가 실제 사용자 확인을 대신하지 않는다.
- 기존 `Extension/README.md`·`docs/design/extension.md`를 실제 반영 계약으로 확정해 이 기록과 함께 공유한다. 모든 상세 검사·실패·수정과 원자료 위치는 일지를 따른다.
- EC2 실패 B안11파일과 원자료는 보존 상태다. Backend UI 검사1줄만 baseline 기준으로 커밋했고 B안 제품코드는 포함하지 않았다. 원본11 백업·나머지10 작업해시 동일·겹침1의 의도된 UI 단언 차이를 유지한다.
- 관리자·/webchat UI는 welfare7의 main3c18f4f production에서 READY다. 관리자 로그인·실제 화면 동작을 새로 시험한 것은 아니다. 기존 비밀번호와 영속 인증은 유지했고 W14 수집은 ON이다. backend 재생성으로 기존 관리자 세션이 만료됐을 수 있으므로 다시 로그인한다. 비밀번호 회전·실자료 재적재는 하지 않았다.

## 바로 다음에 할 일

1. 사용자가 기존 확장을 다시 로드하고 복지로 F5 뒤 요약 창의 요약하기를 직접 시험한다.
2. 연락처가 안내되는 새 상담 이후 관리자 연락처 안내 기록에서 조회한다. 수집 ON 이전의 대화는 소급 기록하지 않는다. 별도 CSV는 보류한다.
3. 노트북·EC2의 main 소스 동기화까지 완료했고 실행 서비스·이미지·DB·환경은 유지했다. 완료 기록 PR 뒤 양쪽 main ff-only와 브랜치 정리를 마치며 최종 SHA/브랜치 목록은 완료 보고에서 확인한다. 다음 기능 확인은 사용자 실제 화면·음성 시험이며 웹은 단발성 기초 RAG다. RAG/CSV는 계속 보류한다.

## 계속 대기할 범위

RAG 정확도/B안 채택과 별도 연락처 CSV/W03 매핑은 보류다. W14 기존 운영 기록 기능은 활성화 완료이며 실제 상담 1건의 저장·Chrome 화면은 미실측이다. production 비밀번호 회전·실재부팅 등 기존 미실측은 별개로 유지한다. 상세 근거는 계획의 일지 링크를 따른다.
