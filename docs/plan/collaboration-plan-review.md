# 협업 계획 교차검증 기록

작성: 2026-11-06. 최신 업데이트: 2026-11-06 04:51 KST

- 검토 대상: [협업·후속 개발 계획](collaboration-plan.md) (최신 업데이트 2026-11-05 15:43 KST)
- 검토 기준 커밋: `docs/Co-op` = `6096084` (origin/docs/Co-op과 일치, 2026-11-06 fetch 확인), 기준 main = `d1a0cae`
- 함께 읽은 지침: 루트 AGENTS.md·CLAUDE.md(2026-11-04 16:13), 공통 스킬 git-workflow·project-design·extension-workflow·backend-pytest, docs/README.md, .gitignore, CI(`.github/workflows/ci.yml`, `scripts/ci_python.py`)
- 진행 순서: **Claude 1차(이 문서 1절) → Codex 검토·계획 보완 → Claude 2차 → Codex 최종 → 협업 개발.** 각 단계는 앞 단계 작성이 끝난 뒤 이 문서의 새 절로 추가하며 이전 절은 수정하지 않는다.

## 목차

- [0. 검토 범위와 표기](#0-검토-범위와-표기)
- [1. Claude 1차 검토 · 2026-11-06](#1-claude-1차-검토--2026-11-06)
  - [1.1 요약](#11-요약)
  - [1.2 착수 전 해결 필요 (차단)](#12-착수-전-해결-필요-차단)
  - [1.3 착수 전 보완 권장](#13-착수-전-보완-권장)
  - [1.4 태스크별 세부 보완](#14-태스크별-세부-보완)
  - [1.5 파일별 작성자와 선행·후행 관계](#15-파일별-작성자와-선행후행-관계)
  - [1.6 코드 대조로 확인된 계획 주장](#16-코드-대조로-확인된-계획-주장)
  - [1.7 미확인 사항](#17-미확인-사항)
  - [1.8 Codex가 다음으로 확인할 사항](#18-codex가-다음으로-확인할-사항)
- [2. Codex 검토 (예정)](#2-codex-검토-예정)
- [3. Claude 2차 검토 (예정)](#3-claude-2차-검토-예정)
- [4. Codex 최종 검토 (예정)](#4-codex-최종-검토-예정)

## 0. 검토 범위와 표기

- 태스크·기능의 필요성은 재논의하지 않는다. 계획만 읽고 바로 착수 가능한지, 단일 작성자·독립 clone·PR 경로가 지켜지는지, 보존·계약·운영 순서·검증이 빠지지 않았는지만 본다.
- 이번 단계에서 수정한 파일은 이 문서 하나다. 원본 계획·지침·스킬·소스는 수정하지 않았고 테스트·commit·push·운영 작업은 하지 않았다.
- 근거 표기: **[확인]** 실제 파일/명령으로 확인, **[추정]** 코드 읽기에 근거한 추론, **[미확인]** 이번에 확인하지 못함.
- 해결 상태: `미해결`(계획 보완 필요), `보완제안`(작성자 판단 필요), `해결`(후속 단계에서 반영 확인 시 기록).
- 식별자: `R1-B##` 차단, `R1-P##` 보완 권장, `R1-T##` 태스크 세부.

## 1. Claude 1차 검토 · 2026-11-06

### 1.1 요약

- 태스크별 지시서(W00~W12)는 브랜치·허용 파일·순서·최소 검사가 대체로 구체적이며, 계획이 주장한 현 코드 결함(W00·W03·W06·W08·W10·W11)은 실제 코드와 일치했다([1.6](#16-코드-대조로-확인된-계획-주장)).
- 착수를 막는 문제는 3건이다: **리뷰 문서 자체가 Git 제외 대상**(R1-B01), **설계 브랜치가 다른 담당 소유 파일을 이미 수정**(R1-B02), **Claude/Codex 각자의 전체 작업 대기열 순서가 하나로 정해지지 않음**(R1-B03).
- 그 밖에 CI 미포함 검사(R1-P01), 설계 문서 갱신 경로(R1-P02), 로컬 브랜치명 대소문자 불일치(R1-P03), W10 `request_id` 근거 부재(R1-T05) 등은 범위를 유지하는 최소 보완으로 해결 가능하다.

### 1.2 착수 전 해결 필요 (차단)

#### R1-B01. 리뷰 문서가 Git 공유 대상이 아님

- **대상:** 교차검증 진행 전체 · 계획 3절 "코드 외의 공유 자원/정책 동기화", docs/README.md 고정 구조
- **근거 [확인]:** `git check-ignore -v docs/plan/collaboration-plan-review.md` → `.gitignore:93:/docs/plan/*`. 예외는 `!/docs/plan/collaboration-plan.md` 하나뿐이다. docs/README.md 고정 트리의 plan/에도 이 파일이 없다.
- **문제·발생 조건:** Codex가 별도 clone에서 다음 단계를 진행하면 이 문서를 Git으로 받을 수 없다. 강제 추가는 지침상 금지이므로, 이 상태로는 "Claude 1차→Codex 검토"의 문서 인계가 성립하지 않는다(같은 checkout을 공유하면 독립 clone 원칙과 충돌).
- **최소 보완안:** `.gitignore`에 `!/docs/plan/collaboration-plan-review.md` 한 줄 추가, docs/README.md 고정 트리와 "Git 공개 범위"에 이 파일 한 줄 추가, AGENTS.md의 "협업 계획1개" 공유 목록 문구에 리뷰 문서 포함. 작성자는 아래 R1-B02에서 정한 정책 작성자로 한다. 그 전까지 인계는 설계 checkout 한 곳에서 단계별로만 진행한다고 계획 3절에 적는다.
- **해결 상태:** 미해결

#### R1-B02. 정책 브랜치(docs/Co-op)가 공유 코드 설정·앱 README를 수정해 단일 작성자 규칙과 충돌

- **대상:** 계획 3절 "작업 구역과 단일 작성자", 1.5 표
- **근거 [확인]:** `git diff --stat origin/main..origin/docs/Co-op`에서 `.gitignore`(+87/−21 중 대부분), 루트 `README.md`, `Extension/README.md`가 변경됨. 계획 3절은 `.gitignore`·루트 README를 "Codex 통합 담당만", `Extension/**`의 README를 Claude 소유로 정한다.
- **문제·발생 조건:** 정책 PR이 병합되기 전 Codex가 `.gitignore`(W10의 CI 조정 등)나 Claude가 `Extension/README.md`를 수정하면 같은 파일 두 작성자가 된다. 반대로 규칙대로라면 현재 정책 PR 자체가 규칙 위반으로 읽힌다.
- **최소 보완안:** 3절에 "정책 PR(docs/Co-op) 한정 예외: 설계 담당이 `.gitignore`의 문서·지침 공유 규칙, 루트 README·Extension/README의 문서 설명 문장을 작성한다. 이 PR이 main에 병합되기 전 Codex·Claude는 해당 파일을 수정하지 않으며, 병합 후에는 원래 소유자로 돌아간다"를 추가한다. R1-B01의 `.gitignore` 한 줄도 이 예외로 같은 PR에 넣는다.
- **해결 상태:** 미해결

#### R1-B03. 담당별 전체 대기열 순서가 단일 목록으로 정해지지 않음

- **대상:** 계획 2절 권장 순서, 3절 "담당별 기능 브랜치와 합류 순서"
- **근거 [확인]:** Claude 소유 핵심 파일(`content.js`, `protocol.js`, `conversations.js`, `worker.js`)은 W00·W03·W04·W05·W06·W07·W08·W09·W10·W11의 Claude 쪽 작업이 모두 수정 후보다(4절 허용 파일). Codex의 `qa.py`는 W03·W11, `context.py`는 W08·W11, `main.py`는 W04·W10이 공유한다. 3절은 "Claude 선행 W00→W06→W07→W09"와 "계약 후속은 대기열에 넣는다"만 정하고, W03/W11 서버 병합이 W07 진행 중에 오면 어느 쪽이 먼저인지, W05·W08·W10·W04의 Claude 순번은 정하지 않았다.
- **문제·발생 조건:** 같은 담당의 기능은 이전 PR 병합 뒤 시작한다는 규칙은 있으나, 순번이 없으면 각 세션이 다음 작업을 임의로 고르게 되어 2절 순서(W06→W07→W09 / W08→W10 / W05)와 계약 후속(W03·W11 표시)의 우선순위가 달라질 수 있다. 착수 판단을 설계 재확인에 의존하게 되어 "문서만 읽고 착수" 기준에 못 미친다.
- **최소 보완안:** 3절에 담당별 **단일 순번표**를 추가한다(기존 2절 순서를 그대로 직렬화, 새 결정 없음). 예시 초안:
  - Claude: ① W00 → ② W06 → ③ W07 → ④ W09 → ⑤ W03 표시(Codex W03 병합 후, 검증만이면 커밋 없음) → ⑥ W11 표시(Codex W11 병합 후) → ⑦ W08(T 확정 + Codex W08 병합 후) → ⑧ W10(Codex W10 병합 후) → ⑨ W05 → ⑩ W04.
  - Codex: ① W01/W04 기준선(코드 없음) → ② W02 → ③ W03 → ④ W11 → ⑤ W08 → ⑥ W10 → ⑦ W05(Claude W05 병합 후 남은 결함만) → ⑧ W04.
  - 규칙: 앞 순번의 선행 PR이 병합 대기이면 다음 순번으로 넘어가지 않고 독립 읽기 검토만 한다. 계약 후속이 먼저 준비돼도 진행 중 기능 PR이 병합된 뒤에 시작한다.
- **해결 상태:** 미해결 (순번 확정은 설계 담당 판단)

### 1.3 착수 전 보완 권장

#### R1-P01. 태스크 최소 검사 다수가 CI에 포함되지 않음

- **대상:** 4절 "공통 개발 시작·검증·완료 절차", W00·W03·W04·W05·W07·W08·W09·W10·W11 최소 검사
- **근거 [확인]:** CI의 Node 검사는 `ci.yml`에 9개 파일을 직접 나열한다(protocol, profile_content, conversations_content, conversation_context, continuous_conversation, panel_usability, timeout, remote_screen, remote_connection). `conversations_worker`·`dom`·`input_assist_content`·`profile_offscreen`은 없다. Python은 `scripts/ci_python.py`에 12개 파일을 나열하며 `test_welfare_qa.py`·`test_conversation_context.py`·`test_desktop_dom.py`·`test_desktop_guidance.py`·`test_extension_cors.py`·`test_public_edge_policy.py`는 없다. 신규 예정 `ui_preferences.test.cjs`(W07)·`answer_speech.test.cjs`(W09)·`consultation_summary.test.cjs`(W10)·`test_conversation_summary.py`(W10)의 CI 등록은 W10에만 언급돼 있다.
- **문제·발생 조건:** PR의 CI 통과가 해당 태스크 검사를 포함하지 않아도 "CI 통과"로 오인될 수 있다. 신규 검사 파일은 CI 파일 작성자(Codex)가 등록하지 않으면 계속 실행되지 않는다. 기존 미포함 파일이 의도적으로 빠졌는지(모델·네트워크 의존 등)는 [미확인].
- **최소 보완안:** 4절 공통 절차에 (1) "PR 본문에 CI 포함 여부와 별도 실행한 검사 명령·결과를 구분 기재", (2) "신규 검사 파일은 해당 기능 PR 병합 직후 Codex 통합 담당이 `ci.yml`/`ci_python.py` 등록 PR을 만든다(또는 등록하지 않는 이유를 기록)"를 추가한다. 기존 미포함 파일의 제외 이유는 Codex가 확인해 기록한다.
- **해결 상태:** 미해결

#### R1-P02. 기능 병합 후 설계 문서·계획 갱신 경로가 불명확

- **대상:** 3절 "설계·정책" 단일 작성, project-design 4항(코드 계약이 바뀐 뒤 docs/design 갱신), 3절 "실제 Chrome 적용" 3항
- **근거 [확인]:** docs/design/**·계획·지침은 설계 단일 작성, docs/Co-op에는 문서만, 기능은 PR 병합으로만 main 반영. 그러나 정책 PR 병합 이후 설계 갱신이 어느 브랜치에서 언제 PR되는지는 "다음 docs 전용 브랜치"라는 Chrome 동기화 문맥 외에는 없다.
- **문제·발생 조건:** 기능 PR이 병합될 때마다 docs/design과 계획 7절을 갱신해야 하는데, docs/Co-op을 계속 쓰면 병합된 브랜치를 재사용하게 되고, 새 브랜치 규칙이 없으면 기능 브랜치에 설계 문서가 섞일 위험이 있다.
- **최소 보완안:** 3절에 "정책 PR 병합 후 설계 갱신은 `docs/<주제>` 전용 브랜치를 최신 main에서 만들어 설계 담당만 작성·사용자 PR로 통합한다. 기능 PR은 docs/design·계획을 수정하지 않는다"를 추가한다. 기능 PR과 설계 갱신 PR의 순서(기능 병합 → 설계 반영)도 함께 적는다.
- **해결 상태:** 미해결

#### R1-P03. 로컬 브랜치명과 원격 ref 대소문자 불일치

- **대상:** 3절 작업 폴더·브랜치 배정, git-workflow push 규칙
- **근거 [확인]:** 이 기기(`C:/Users/sjh43/Desktop/welfare_helper`)의 로컬 브랜치는 `docs/co-op`, `branch.docs/co-op.merge`는 `refs/heads/docs/co-op`이다. 원격 ls-remote에는 `refs/heads/docs/Co-op`만 있다.
- **문제·발생 조건 [추정]:** Windows 대소문자 비구분 파일시스템에서는 fetch/비교가 동작해 보이지만, GitHub ref는 대소문자를 구분하므로 upstream 기반 push는 별도 원격 브랜치 `docs/co-op`를 만들 수 있다. git-workflow가 명시 ref push를 요구해 위험은 줄지만 계획의 브랜치명과 실제 이름이 다르다.
- **최소 보완안:** 3절 준비 절차에 "각 clone에서 로컬 브랜치명·upstream이 원격 ref와 대소문자까지 일치하는지 확인하고, push는 `HEAD:refs/heads/<정확한 원격 이름>`으로 명시한다"를 추가한다. 이 기기 브랜치 이름 정리는 사용자 확인 후 설계 담당이 수행한다(이번에 변경하지 않음).
- **해결 상태:** 미해결

#### R1-P04. 기기별 실제 경로와 계획 경로의 대응이 없음

- **대상:** 3절 작업 폴더 표, CLAUDE.md 개발 예정 폴더
- **근거 [확인]:** 계획·CLAUDE.md는 `C:/Users/jehee/vscode-workspace/...` 경로를 지정한다. 이번 검토 기기는 `C:/Users/sjh43/Desktop/welfare_helper`이며 worktree는 이 checkout 하나다. CLAUDE.md는 "다른 기기에서는 같은 역할의 독립 clone 경로를 설계 담당과 맞춘다"고만 한다.
- **문제·발생 조건:** 개발 세션이 다른 기기에서 열리면 3절 표만으로 자신의 루트를 대조할 수 없고, 원래 설치 확장 경로(Chrome 적용 담당)도 기기마다 다르다.
- **최소 보완안:** 3절 표에 "기기/사용자" 열을 추가하거나, 태스크 시작 기록(4절)에 실제 절대경로를 필수로 적고 설계가 승인한다고 명시한다. 사람4인의 실제 담당 기기는 사용자 확인 사항으로 남긴다.
- **해결 상태:** 보완제안

#### R1-P05. 공유 운영 자원 사용의 예약·해제 방법이 없음

- **대상:** 3절 "코드 외의 공유 자원", "실제 Chrome 적용과 공유 운영 담당", 5절 시험 의존성
- **근거 [확인]:** 계획은 "설계가 지정한 시간에만", "한 담당자가 한 번에"를 요구하지만 지정·종료를 기록할 위치와 형식이 없다. 개발 세션은 계획을 수정할 수 없다(설계 단일 작성).
- **문제·발생 조건:** W02 적재 중 W01 평가, 서버 배포 중 확장 실제 UI 시험 같은 병렬 금지 조합이 구두 합의에만 의존한다.
- **최소 보완안:** 계획 7절에 "운영 자원 사용 기록" 소절(자원·담당·시작/종료 시각·서버 SHA·확장 SHA·자료 버전·호출 상한)을 두고 설계 담당만 작성한다. 개발 세션은 시작 전 요청, 종료 후 결과를 설계에 전달한다.
- **해결 상태:** 보완제안

#### R1-P06. 사용자 작업 트리의 docs/data 미커밋 삭제

- **대상:** W02 자료 준비, 2절 기준 확인
- **근거 [확인]:** 이번 검토 시점 이 checkout의 `git status`에 `docs/data/문서포맷.md`·`수집방법.md`·`문서모음/.gitattributes`·`01~10` MD 삭제가 미커밋으로 있다(커밋 `6096084`에는 존재). `.playwright-mcp/`는 미추적이며 `.gitignore` 규칙이 없다.
- **문제·발생 조건:** 이 checkout을 기준으로 W02 해시를 대조하면 파일이 없다. 출처를 모르는 변경이므로 이번에 복구·정리하지 않았다. `.playwright-mcp/`가 선별 stage 중 섞일 수 있다.
- **최소 보완안:** 계획 수정 대상은 아님. W02 자료 대조는 Git 커밋(`6096084`의 `docs/data/문서모음/`) 기준으로 한다고 4절 W02에 명시한다. 삭제 의도는 사용자 확인, `.playwright-mcp/` 제외 규칙은 Codex(.gitignore 소유자) 판단으로 넘긴다.
- **해결 상태:** 사용자 확인 필요

### 1.4 태스크별 세부 보완

#### R1-T01. W00 — 입력 payload 보존과 단언의 관계를 한 줄로 명시

- **근거 [확인]:** `remote_connection.test.cjs:39`는 입력 payload에 `profile:{age:70}`을 넣고 `:42`에서 `body.profile.age===70`을 단언한다. `protocol.documentRequest`(protocol.js:158~163)는 `profile` 키를 허용하되 반환 객체에서 제외한다. 따라서 현재 단언은 실패하는 것이 맞고, 계획의 "payload 원본을 삭제하지 않는다"는 "입력에 profile을 남긴 채 전송 본문에 없음을 단언"으로 읽힌다.
- **문제:** "프로필 필드 자체가 없고"가 입력인지 전송 본문인지 해석이 갈릴 수 있다.
- **최소 보완안:** W00 개발 지시에 "입력 payload의 `profile`은 유지하고 `Object.hasOwn(body,'profile')===false`를 단언한다"를 적는다. CI 목록에 이미 포함된 파일이므로 CI 조정은 없다. `profile_offscreen.test.cjs`는 CI 밖이므로 로컬 실행 결과를 PR에 별도 기재(R1-P01).
- **해결 상태:** 미해결

#### R1-T02. W06 — 최초 표시 시점과 접기 상태 기준

- **근거 [확인]:** `clampPanel`(content.js:371~375)은 `openPanel`(83행)·접기(87행)·드래그·ResizeObserver·resize·pageshow에서 호출되며, 매번 `right/bottom='auto'`와 `left/top` 좌표를 기록한다. 최초 열기부터 오른쪽 고정이 해제된다.
- **문제:** 계획은 resize·접기·pageshow를 언급하나 `openPanel` 경로는 명시하지 않았다. 접힌 상태 높이로 clamp한 뒤 펼칠 때의 기준도 없다.
- **최소 보완안:** W06 구현 순서 (5)에 `openPanel`과 접기/펼치기를 포함하고, 최소 검사에 "열기 직후 dock=right 유지", "접힌 상태에서 창 축소 → 펼치기"를 추가한다.
- **해결 상태:** 미해결

#### R1-T03. W07 — 신규 메시지 종류의 sender 검증 기준과 다중 탭 통지 경로

- **근거 [확인]:** worker의 상담 메시지는 `sender.url===sender.tab.url`·탭 ID 검증 후 직렬 처리한다(worker.js:151~160). 프로필 키 `gyeote.profile`은 schemaVersion1(worker.js:37·55·61), 상담 키는 `gyeote.conversations`(conversation-store.js:2).
- **문제:** 계약 초안은 "공식 sender·TRUSTED_CONTEXTS"라고만 적어 content 출처(복지로 공식 URL만인지, 옵션 페이지도 허용인지)와 다른 탭 갱신 통지 방식(storage.onChanged인지 worker 메시지인지)이 정해지지 않았다.
- **최소 보완안:** 계약에 "허용 sender = 기존 상담 메시지와 동일 조건(공식 URL content), 옵션 페이지는 제외/포함 중 택1", "다른 탭 반영은 기존 상담 통지와 같은 방식 재사용"을 적는다. 값 결정이 필요하면 설계 결정 항목(6절)에 추가한다.
- **해결 상태:** 보완제안

#### R1-T04. W08 — 현행 v2 쓰기 경로의 버전 하드 체크

- **근거 [확인]:** 저장 스키마는 `schemaVersion:2`(conversations.js:42), 저장소는 `schemaVersion!==2`이면 `conversation_conflict` 계열 오류를 던진다(conversation-store.js:48). 쌍의 `createdAt`은 `pair()` 호출 인자로 user·assistant 모두 같은 값이 들어간다(conversations.js:124~129). 계획의 "createdAt은 실제 전송 시각과 다르다"는 주장과 일치한다.
- **문제:** v3 이관 시 구확장(v2 전용)이 v3 데이터를 만나면 충돌 오류로 상담 저장이 막힌다. 계획은 롤백 제약으로 기록한다고 했지만 사용자 안내·복구 경로가 없다.
- **최소 보완안:** W08 완료 기준에 "v3 이관 전 v2 원본을 같은 storage에 별도 키로 1회 보존(덮지 않음)하고, 롤백 시 그 키로 복원하는 절차를 PR 본문에 기재"를 추가한다. 새 키 이름은 W07의 키 명명과 맞춘다. 보존 용량은 기존 4MiB 한도 안에서 확인한다.
- **해결 상태:** 보완제안

#### R1-T05. W10 — `request_id` "기존 규격"이 HTTP 계약에 없음

- **근거 [확인]:** `ChatRequest`(main.py:97~)는 `query/timeout_seconds/profile/history/conversation_context`만 있고 `extra="forbid"`다. 서버·확장 HTTP 본문에 `request_id` 필드 선례가 없다. 확장의 `requestId`는 offscreen 내부 패킷 키다(offscreen.js:23). 메시지 ID 규격은 서버 `MESSAGE_ID` 패턴(context.py:43)이 있다.
- **문제:** "request_id는 기존요청ID 규격"을 구현할 기준이 없어 Codex·Claude가 다른 형식을 고를 수 있다. `inference_path`는 고정 목록(execution.py:75~77: chat, desktop/guide, screen/guide, admin/documents/)이라 신규 경로 등록이 필요하다는 계획 주장은 맞다.
- **최소 보완안:** W10 API 초안에 "request_id는 확장의 `GyeoteProtocol.id` 형식과 동일, 서버는 같은 정규식으로 검증(기존 `MESSAGE_ID`와 별도 상수)"처럼 실제 정규식 출처를 지정하거나, 서버가 응답에서 되돌려주기만 하는 불투명 문자열(길이 상한)로 정의한다. 둘 중 선택은 Codex 계약 작성자가 정한다.
- **해결 상태:** 미해결

#### R1-T06. W10 — 공통 gate와 상담 요청의 경합

- **근거 [확인]:** 실행 gate는 바쁠 때 `429 inference_busy`(execution.py:59), 채팅 rate는 `429 chat_rate_limited`(chat_rate.py:49)를 반환한다.
- **문제:** 요약 요청이 진행 중일 때 사용자가 새 질문을 보내면 채팅이 429가 된다. 계획은 "재질문 뒤 늦은 결과는 버린다"만 정하고, 요약 진행 중 전송 버튼 상태(비활성/요약 취소 후 전송)는 정하지 않았다.
- **최소 보완안:** W10 UI에 "요약 진행 중 질문 전송 시 요약 요청을 먼저 취소하고 질문을 보낸다" 또는 "요약 중 전송 비활성" 중 하나를 지정한다(기존 질문 중 정지 동작과 같은 쪽 권장).
- **해결 상태:** 보완제안

#### R1-T07. W11 — 확장 파서가 `reason`을 버림

- **근거 [확인]:** 서버 fallback 응답은 `reason`을 포함하지만(qa.py:62·158·271) `protocol.documentReply`의 반환 객체(protocol.js:178)에는 `reason`이 없다. 현재 out_of_scope 응답은 `evidence if answer else []`로 근거가 붙을 수 있다(qa.py:273).
- **문제:** 계획 W11은 "reason이 필요하면 기존 필드만 선택적으로 전달"이라 했으나 현재 확장은 그 필드를 저장·표시 경로로 넘기지 않는다. 고정 문구 본문만으로 충분한지(표시 차이 불필요)인지가 정해지지 않으면 `claude/co-w11-scope-display` 필요 여부를 판단할 수 없다.
- **최소 보완안:** W11 지시에 "1차 범위는 서버 고정 본문+빈 evidence/contacts로 충분하며 확장 변경 없음. 상태별 표시 차이가 필요해질 때만 protocol의 선택 필드 수용→서버 전송 순서로 별도 PR"을 명시한다.
- **해결 상태:** 미해결

#### R1-T08. W03 — 공식 위탁기관 호스트 허용 순서

- **근거 [확인]:** 확장 `documentContacts`는 `https`·`.go.kr` 호스트가 아니면 해당 연락처를 조용히 건너뛴다(protocol.js:139~150). 정상 answer 응답에는 `contacts` 키가 없다(qa.py:263~271), 확장 파서는 키가 있으면 수용한다(protocol.js:178).
- **문제:** 서버가 `.go.kr` 밖 공식 위탁기관 연락처를 먼저 보내면 구확장에서는 경고 없이 사라진다. 계획은 "양쪽 허용규칙을 같이 설계"라고만 해 병합 순서가 없다.
- **최소 보완안:** W03에 "호스트 허용 확대가 필요하면 확장 수용 PR(Claude) 먼저 병합 → 서버 전송 PR. 확대가 없으면 서버 단독 PR로 끝나고 Claude는 검증만"을 적는다. 이는 5절 C1-contacts의 "서버 미전송 지원→확장수용→서버전송"과 같은 원칙의 적용이다.
- **해결 상태:** 미해결

#### R1-T09. W05 — 예산 상한이 양쪽에 중복 존재

- **근거 [확인]:** 후보 60개/4000자 상한은 확장 `dom.js`(46·112·116행)와 서버 `desktop_guidance.py`(72·154·166행) 모두에 있다. 점수의 앞2글자 사용(`slice(0,2)`, dom.js:102)도 확인했다.
- **문제:** 계획은 상한을 늘리지 않는다고 했으므로 충돌은 없지만, 후보 문맥(`context`) 구성 변경이 서버 4000자 검증의 합계 계산(label+context+screen_context)에 영향을 준다는 점이 명시되지 않았다.
- **최소 보완안:** W05 최소 검사에 "변경한 후보 구성으로 서버 `test_desktop_dom.py`의 예산 검증 통과 확인(대역)"을 Claude PR 검사 항목으로 넣고, 서버 파일은 수정하지 않는다고 명시한다.
- **해결 상태:** 보완제안

#### R1-T10. W01·W02 — 자료 버전 기준

- **근거 [확인]:** `6096084`의 `docs/data/문서모음/`에 MD 10개가 있다. 다른 기기의 이전 브랜치에서는 교육부 33종 추가 커밋(`937acef`)을 본 기록이 있으나 현재 origin에는 없다([확인]: ls-remote에 해당 브랜치 없음).
- **문제:** 자료가 늘어나는 커밋이 나중에 main에 들어오면 W01 기준선·W02 대상 10개가 바뀐다.
- **최소 보완안:** W01/W02 시작 기록에 "자료 기준 = 특정 커밋의 docs/data/문서모음 파일 목록·해시"를 필수로 적고, 자료 추가는 별도 문서 PR로 W02 완료 후 반영한다고 명시한다.
- **해결 상태:** 보완제안

### 1.5 파일별 작성자와 선행·후행 관계

**작성자 구역** (계획 3절 기준 + 이번 검토의 보완 표시)

| 파일/경로 | 작성자 | 비고·보완 |
|---|---|---|
| `Extension/**` (소스·tests·README·manifest) | Claude | Extension/README는 정책 PR에서 설계가 이미 수정 → R1-B02 예외 명시 필요 |
| `BackEnd/**`, `FrontEnd/**` (소스·tests·lockfile) | Codex | W02 서버 결함일 때만 documents/* |
| `.github/**`, `scripts/**`, `deploy/**`, `dockerfiles/**`, `docker-compose.yml`, 루트 의존성 | Codex 통합 | 신규 검사 CI 등록 포함(R1-P01) |
| `.gitignore`, 루트 README | Codex 통합 (정책 PR만 설계 예외) | R1-B01·R1-B02 |
| `docs/design/**`, `docs/plan/collaboration-plan.md`, AGENTS.md·CLAUDE.md, `.agents/skills/*`, `.claude/skills/*` | 설계 | 병합 후 갱신 브랜치 규칙 필요(R1-P02) |
| `docs/plan/collaboration-plan-review.md` | 단계별 순차: Claude 1차 → Codex → Claude 2차 → Codex 최종 | 동시 수정 금지, Git 공유 예외 필요(R1-B01) |
| `docs/data/**` | 설계(자료 PR) | W02는 읽기만 |
| `.local/co-op/<태스크>/<커밋>/` | 각 실행 담당(자기 경로만) | Git 제외 |

**공유 파일 충돌 지점과 순서**

| 파일 | 수정 태스크(작성자) | 정해진 순서 | 보완 |
|---|---|---|---|
| `Extension/content.js` | W03·W04·W05·W06·W07·W08·W09·W10·W11 (Claude) | W06→W07→W09만 명시 | 전체 순번 필요(R1-B03) |
| `Extension/protocol.js` | W03·W05·W07·W10·W11 (Claude) | 서버 계약 PR 뒤 | 〃 |
| `Extension/worker.js` | W07·W08·W10 (Claude) | W08→W10 | W07과의 순서는 순번표로 |
| `Extension/conversations.js`·`conversation-panel.js` | W03·W08·W10 (Claude) | W08→W10 | 〃 |
| `Extension/tests/panel_usability.test.cjs` | W04·W06·W07·W09 (Claude) | W06→W07→W09 | W04는 마지막 |
| `BackEnd/documents/qa.py` | W03·W11 (Codex) | W03 병합 후 W11 | 명시됨 |
| `BackEnd/documents/context.py` | W08·W11 (Codex) | 미명시 | 순번표에서 W11→W08 |
| `BackEnd/main.py` | W04·W10 (Codex) | 미명시 | 순번표에서 W10→W04 |
| `BackEnd/tests/test_conversation_context.py` | W03·W08·W11 (Codex) | 〃 | 〃 |
| `.github/workflows/ci.yml`, `scripts/ci_python.py` | W10 + 신규 검사 등록 (Codex) | W10 기능 PR 뒤 | 등록 시점 규칙(R1-P01) |

**계약 의존 (서버 PR → 클라이언트 PR)**

| 선행(병합 필요) | 후행 | 비고 |
|---|---|---|
| docs/Co-op 정책 PR | 모든 기능 브랜치 | 계획 3절 명시 |
| Claude W00 | Claude W06 | 명시 |
| Codex W03 | Claude W03 표시 | 호스트 확대 시 역순(R1-T08) |
| Codex W03 | Codex W11 | 명시 |
| Codex W11 | Claude W11 표시 | 확장 변경 불필요 가능(R1-T07) |
| W08 기간 T 결정 + Codex W08 | Claude W08 | 명시 |
| Claude W08 결합 검사 | Codex W10 → Claude W10 | 명시 |
| Claude W05 | Codex W05 | 새 DTO 필드가 필요하면 서버 수용 PR 선행 |

### 1.6 코드 대조로 확인된 계획 주장

| 계획 주장 | 결과 | 근거 |
|---|---|---|
| W00 테스트가 프로필 미전송 계약과 충돌 | 일치 | remote_connection.test.cjs:39·42, protocol.js:160·163 |
| W06 clampPanel이 right/bottom=auto로 고정 해제 | 일치 | content.js:371~375, 호출 83·87·386·388·390·392행 |
| W08 createdAt이 답변 append 시 생성 | 일치 | conversations.js:124~129 (user·assistant 같은 값) |
| W08 현행 schemaVersion2 | 일치 | conversations.js:42, conversation-store.js:48 |
| W03 정상 answer에 contacts 없음 | 일치 | qa.py:263~271 |
| W11 빈 검색 조기 no_evidence 종료 | 일치 | qa.py:54~62(청크 없음), 154~158(탈락) |
| W10 inference_path 고정 목록 | 일치 | execution.py:75~77 |
| W05 60후보/4000자, 앞2글자 점수 | 일치 | dom.js:46·102·112·116, desktop_guidance.py:72·154·166 |
| 계획에 적힌 기존 파일 경로 | 모두 존재 | 소스·tests·FrontEnd 경로 58개 존재 확인 |
| worktree 미사용 | 일치 | `git worktree list` 결과 1개 |

### 1.7 미확인 사항

- 원격 main 보호·ruleset (계획 3절과 동일하게 미확인, 이번에도 조회하지 않음).
- Codex·Claude 개발 clone 존재와 실제 세션의 지침 로드 (이 기기에는 개발 clone 없음).
- CI에서 빠진 기존 검사 파일들이 의도적으로 제외됐는지, 현재 로컬에서 통과하는지 (테스트 미실행).
- `remote_connection.test.cjs`가 현재 실제로 실패하는지 (코드 읽기로만 판단, 미실행).
- W07 `gyeote.uiPreferences` 키가 기존 4MiB 상담 용량 계산에 포함되는지.
- 사람4인의 실제 담당·기기 대응.

### 1.8 Codex가 다음으로 확인할 사항

1. **R1-B01·R1-B02:** 리뷰 문서 Git 공유 예외와 정책 PR의 `.gitignore`/README 작성자 예외를 계획 3절에 반영할지, 반영 작성자를 누구로 할지.
2. **R1-B03:** Codex 쪽 순번(W11→W08 `context.py`, W10→W04 `main.py`)이 서버 계약 의존과 맞는지 확인하고 단일 순번표 초안을 보완.
3. **R1-P01:** CI 미포함 Python 검사(`test_welfare_qa`, `test_conversation_context`, `test_desktop_*`, `test_extension_cors`, `test_public_edge_policy`)의 제외 이유와 신규 검사 등록 시점.
4. **R1-T05·R1-T06:** W10 `request_id` 형식과 요약 중 질문 전송 처리.
5. **R1-T07·R1-T08:** W11 확장 변경 불필요 여부, W03 위탁기관 호스트 확대 시 병합 순서.
6. 위 판단 결과와 이 문서에서 놓친 충돌을 2절에 추가 기록.

## 2. Codex 검토 (예정)

Claude 1차 작성 완료 후 Codex가 이 절을 작성한다. 1절은 수정하지 않고, 해결 상태 변경은 이 절에 식별자별로 기록한다.

## 3. Claude 2차 검토 (예정)

Codex 검토·계획 보완 뒤 작성한다.

## 4. Codex 최종 검토 (예정)

Claude 2차 뒤 작성한다.
