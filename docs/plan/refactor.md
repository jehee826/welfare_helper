# welfare_helper 섹터별 리팩토링 계획

최초 작성: 2026-11-11. 최신 업데이트: 2026-11-12 00:38 KST

구현 순서는 **확장 → 공개 웹 → 관리자 웹 → FastAPI 공통·관리자 → 문서 처리·DB → RAG → Desktop·화면 안내 → 배포·CI**다. 한 섹터의 결과를 검토한 뒤 다음 섹터로 넘어간다. 이번 산출물은 이 순서대로 사용할 설계 문서다.

## 섹터별 실행 순서

기준은 노트북 `main/364cbb8`이다. 버전 관리되는 앱·설정·운영 도구·테스트의 전문을 읽어 진입점, 함수, 오류 처리와 파일 소속을 조사했다. 구조 변경을 제안한 곳은 호출자와 반환값, 관련 검사를 추가로 대조했다. EC2 실험 변경 11파일, 로컬 평가 원자료와 생성물은 별도 보존 대상이다. 아래는 **구현 전 정적 검토**이며 모든 분기에 대한 실행 결과를 뜻하지 않는다.

전체 대상은 **278파일**이다. 구현·설정·도구 162개와 테스트·픽스처·수동 측정 도구 116개다. 실행에 쓰이는 manifest, HTML, CSS, SQL, 환경 예시와 배포 설정을 포함했다. 의존성 잠금 산출물, 설명 문서, 복지 원문 데이터, 실제 환경 파일은 집계에서 제외했다. 파일별 소속은 문서 끝 목록에서 확인한다.

한 번에 한 섹터를 진행한다. 각 섹터에서 **첫 변경 → 나머지 후보 검토 → 집중 검사 → 결과 인계** 순서로 마친 뒤 다음 번호로 이동한다. 모든 파일을 수정할 필요는 없다. 공유 파일은 목록에 기재된 섹터에서만 쓰고 다른 섹터에서는 소비자로 검토한다. 현재 1번은 **로컬 구현·검증·리뷰 완료, 원격 통합 대기**, 2~8번은 **구현 대기**다. 1번 제품 커밋은25f67bc다. [변경·검사 결과](devlog.md#log-20261112-0038-extension-refactor-result)를 확인한 뒤 통합하고 2번으로 진행한다.

### 1. Chrome 확장 — 51파일

상태는 로컬 완료다. offscreen의 요약 해석 재사용·모드별 오류/응답 분기와 content의 문서 표시·저장/화면 적용을 정리했다. 제품2파일과 기존 검사2파일이 변경됐으며 나머지 모듈은 호출 경계를 검토해 현행 책임을 유지했다. 관련13파일212개 사례가 최초 실행·실패1건 정정 후 해당 파일 재검사를 통해 각각 통과했다. 전체13파일의 재실행·Chrome·운영 HTTP는 수행하지 않았다.

- **따라갈 순서.** `manifest.json`과 `package.cjs` → `worker.js`의 활성 탭·저장소·요청 준비 → `content.js`와 `offscreen.js`의 포트 → `protocol.js`와 대화 저장·복원. DOM·프로필·음성 입력·옵션은 연결된 사용자 동작 단위로 살핀다.
- **첫 변경.** `summaryReply`의 중복 호출을 없앤 다음 문서·요약·화면 모드의 성공/오류 분기를 같은 파일 안에서 펼친다. 그다음 `content.js`의 응답 처리에서 최종 표시와 저장 순서를 드러낸다. 한 번에 포트 계약과 저장 스키마를 함께 바꾸지 않는다.
- **합치거나 유지할 것.** `conversations.js`의 레코드 변환, `conversation-store.js`의 변경 순서·revision, `conversation-panel.js`의 UI는 세 책임이 다르다. 같은 메시지 검사를 재실행하는 부분을 줄이되, 저장 직전 다른 탭의 변경을 확인하는 절차는 유지한다.
- **종료 기준.** 문서·요약·화면 요청의 결과/오류, 두 탭의 저장 충돌, 취소 뒤 지연 응답, 구 저장 대화 복원을 해당 기존 사례에서 대조한다. 패키지 진입점이 바뀌면 manifest와 패키징 목록도 대조한다.

### 2. 공개 웹 상담 — 11파일

- **따라갈 순서.** `WebChatPage.submit` → 연락처 기록 설정 확인 → `postChat` → `parseChatResponse/parseContacts` → 답변 표시·낭독. 공개 라우트 선언은 3번의 `App.tsx`가 소유한다.
- **먼저 정리할 것.** 페이지의 제출·취소·언마운트에서 `active.current`, timer, AbortController가 언제 종료되는지 나란히 놓고, 공통되는 자원 해제만 같은 파일 안에서 한 번 표현한다. 취소 사유와 뒤늦은 응답을 거르는 요청 ID는 호출부에 보이게 둔다.
- **검증 판단.** 응답 전체가 잘못되면 오류지만, 잘못된 연락처 하나는 건너뛰고 정상 답변을 보여주는 계약이다. 두 경우를 같은 예외로 합치지 않는다. `Contacts`는 전화 링크와 시간 표시를 소유하며 `speech.ts`의 종류명은 화면과 낭독이 공유한다. 음성 인식·합성의 수명은 각각 유지한다.
- **종료 기준.** 웹챗·라우트·API·음성 기존 검사에서 단발 질문 한 번 전송, 입력 보존, 취소와 시간 초과 구분, 정상 연락처 표시·낭독을 대조한다.

### 3. 관리자 웹·공유 웹 진입점 — 52파일

- **따라갈 순서.** `main.tsx/App.tsx` → `AuthProvider/AdminGate` → 제도·문서·연락처·비밀번호 화면 → 각 API. Vite·라우팅·테스트 진입점도 이 섹터 책임이다.
- **첫 변경.** `AdminPage`와 단일 제품 호출처인 `ProgramManager`를 한 페이지로 합친다. 이후 `DocumentsPage.perform`의 원문 읽기·검색·질의를 분리하고 제도 폼/연락처 화면도 요청 종료와 오류 처리 순서 중심으로 정리한다.
- **유지할 차이.** `httpApi.toProgram/toBody`는 API 필드와 화면 필드를 변환한다. `mockApi`를 지우기 전 테스트·주입 호출처를 확인한다. 오래된 401이 새 세션을 지우지 않도록 세션 ID 검사를 보존하고, 공개 웹 요청에는 관리자 헤더를 붙이지 않는다.
- **종료 기준.** 공개/관리자 라우팅, 로그인 만료, 제도 등록·수정·삭제, 문서 교체 중 원문 조회, 연락처 기간 조회를 바뀐 화면별 기존 검사로 확인한다. 렌더링·화면 기능을 검증하는 테스트를 삭제된 컴포넌트 이름에 묶어 두지 않는다.

### 4. FastAPI 진입점·관리자·공통 실행 — 42파일

- **따라갈 순서.** `main.py`의 라우터와 의존성 → 요청 모델·실행 기한·속도 제한 → 관리자 session/credentials 및 program/referral store. 상담 요약·공통 개인정보 처리·진단도 포함한다.
- **첫 검토 단위.** `SummaryRequest.complete_pairs`의 총길이·역할 교대·ID 중복·짝 일치 검사를 순서대로 읽을 수 있게 같은 함수에서 풀어 쓴다. 정규식만으로 두 메시지가 실제 한 쌍인지 판정할 수 없다. 검사 실패의 공개 코드와 승인된 이전 입력을 전후 대조한다.
- **검증 판단.** `require_document_admin`은 문서 기능 설정과 관리자 인증을 함께 확인하고 여러 라우터가 쓴다. `with inference_request`의 슬롯 반환 시점과 `record_public`의 공개 연락처 선택 조건도 독립 책임이다. 관리자 DB 코드의 짧은 cursor 함수는 트랜잭션·읽기 전용 상태와 연결 주입 방식까지 같을 때만 공통화한다.
- **종료 기준.** 공개·관리자 요청, 권한 만료, 요청 취소·기한·429, 완전한 요약 문답과 잘못된 짝, 연락처 기록 조건을 기존 대역·격리 검사로 확인한다. 공개 DTO 변경이 필요하면 소비자가 있는 1~3번의 영향과 이전 버전 호환을 먼저 검토한다.

### 5. 문서 수집·저장·게시와 DB — 28파일

- **따라갈 순서.** 관리자 업로드/교체 → `DocumentStore.register` → worker 획득·분석 → 청크/벡터 저장 → `activate`. 오프라인 CSV/공식 자료 도구, 스키마와 마이그레이션도 여기서 다룬다.
- **첫 변경.** `process_job`의 임베딩 배치 루프를 같은 파일 안에서 묶어 정상 처리와 중간 재개를 읽기 쉽게 만든다. 그 뒤 `documents/api.py`에서 등록·교체가 공유하는 업로드 구현과 HTTP 진입점의 역할을 분명히 한다.
- **검증 판단.** 업로드 스트림을 읽는 도중의 크기 제한, 파일 형식 검사, 게시 시점의 job token 검사는 다른 실패를 막는다. 과거 분석 포맷과 자동 처리 포맷이 만나는 `indexing.document_children`은 보존 자료 소비자를 먼저 확인한다. 적용된 SQL 이력은 번호별로 유지한다.
- **종료 기준.** 신규 등록, 동일 ID 교체, 취소/재시도, 실패 후 기존 게시본 유지, 벡터 재사용 및 job 격리를 기존 worker/store 검사로 대조한다. 운영 데이터에 변경을 가하는 절차는 별도 운영 작업이다.

### 6. 상담 RAG·모델·검색 — 33파일

- **따라갈 순서.** `prepare_context` → 검색·리랭킹 → 원문 묶음과 프롬프트 예산 → Ollama → 응답·근거·연락처 선택. 게시된 문서를 검색 객체로 읽어 오는 `documents/retrieval.py`와 저장 프로필 동의 모델도 포함한다.
- **첫 변경.** 실제 공개 상담이 호출하는 `answer_document`에서 원문 ID·연락처 ID 검증과 선택을 같은 모듈의 단위로 옮긴다. 진단값을 언제 확정하는지 상위 흐름에 남긴다. 전후에 같은 대역 입력으로 문서 순서·fallback 사유·진단 키까지 대조한다.
- **삭제 판단.** `rag/chat.py`의 이전 답변 경로, repository의 비지원 적재 메서드, 수집 도구·테스트 의존성을 함께 조사한다. 삭제 후보와 현재 서비스 조립·상수·진단 사용을 구분한다. 18줄짜리 `validate_embeddings`는 모델 응답·저장·검색 등 여러 경계가 실제로 공유한다.
- **선행 조건과 종료 기준.** EC2 보존 변경 11파일과 겹치는 경로를 먼저 확인한다. 요청 취소, 프로필 ON/OFF, 공개/test_only 구분, 문서 버전·근거 선택, 연락처가 하나/여럿인 기존 사례를 확인한다. 구조 변경과 검색 정책·모델 품질·스트리밍 기능 변경은 각각 독립된 작업이다.

### 7. Desktop·화면 안내 서버 — 36파일

- **따라갈 순서.** Windows UIA 감시 → Chrome 창/탭 확인 → Electron main/preload → 로컬 클라이언트 → 화면 안내 서버 → 현재 대상 재확인·강조. 확장 DOM과 공유하는 서버 화면 안내 진입점도 이 섹터에서 관리한다.
- **첫 변경.** `guideStep`이 이미 파싱한 응답의 `step`을 `JSON.stringify`했다가 `parseStep`에서 다시 읽는 경로를 객체 직접 검증으로 바꾼다. 다음으로 화면 상태가 바뀔 때 안내와 강조가 취소되는 순서를 `assistant.cjs`에서 읽기 쉽게 정리한다.
- **유지할 경계.** 모델이 선택한 target ID의 유효성과 실제 강조 직전 가시성·좌표·현재 창 검사는 각각 필요하다. preload, overlay, native watcher와 3.5초 freshness 판단은 실행 주체와 시점이 다르다.
- **종료 기준.** 대역의 정상 step, 대상 소실·비활성·가림, 포커스 전환과 늦은 overlay 응답을 기존 assistant/tracking/visibility 검사로 대조한다. 실제 UIA 결과는 Windows 실측일 때 구분해 기록한다.

### 8. 실행·배포·CI — 25파일

- **따라갈 순서.** Compose → Dockerfile/모델 준비 스크립트 → `BackEnd.startup`·worker 진입점 → `readiness` → Caddy. 저장소 공통 Python 의존성 입력과 잠금 생성기, CI workflow도 포함한다.
- **작업.** 앞선 섹터에서 실제로 옮긴 모듈·테스트 이름과 CI 명시 목록, 패키지 진입점을 대조한다. `readiness.main`의 worker heartbeat 확인과 API 준비 확인은 의존 서비스와 실패 원인이 달라 유지한다. 변경이 필요한 호출 경로가 없으면 이 섹터는 검토로 종료한다.
- **종료 기준.** CI의 backend/worker/dev 환경 구분, 공개/비공개 라우트, 패키징 자원 경로와 모듈 진입점이 이전과 일치한다. 다른 섹터에서 수행한 검증 결과와 이 섹터에서 직접 확인한 결과를 인계에 구분한다.

## 변경 근거와 구현 메모

### 1번 원격 통합용 PR 본문

제목은 `[Refactor] 확장 응답 해석과 표시·저장 흐름 단순화`다. 대상은 `codex/refactor-extension`에서 `main`이다.

offscreen이 요약 응답을 한 번 해석하고 그 반환값을 전달하도록 바꾼다. 모드별 요청·HTTP 오류·성공 처리와 content의 문서 답변 표시·저장/DOM 안내 적용을 이름 있는 함수와 조건문으로 정리한다. 기존 요청·포트·저장 형식과 취소·동의·현재 화면 재확인 순서를 유지한다. 섹터별 리팩토링 계획과 진행 기록도 함께 공유한다.

검증은 로컬 VM/JSDOM 집중13파일212개 사례다. 최초211통과/1실패 뒤 VM 객체 비교 단언을 수정하고 해당 mode 파일12개만 재실행해 통과했다. 다른 통과 파일은 반복하지 않았다. diff와 오류 매핑·원본 추가 필드 전달·저장/취소 순서를 읽기 리뷰했다. 실제 Chrome·HTTP·모델·EC2·패키징은 미실측이다. 설치 확장에서 다시 로드하면 새 소스가 적용되므로 설치본 확인 시점을 조율한다. 이 변경은 EC2 서비스 재빌드가 필요한 서버 제품 변경을 포함하지 않는다.

### 바로 적용할 수 있는 단순화

#### 확장 응답을 한 번 해석하고 결과를 전송한다

- **근거.** [offscreen.js](../../Extension/offscreen.js)의 응답 처리 끝에서 요약 모드가 `summaryReply(body,payload)`를 호출하고 결과를 버린 뒤, 바로 다음 전송문에서 같은 호출을 반복한다. [protocol.js](../../Extension/protocol.js)의 이 함수는 본문 길이, 요청 ID, 선택된 메시지 ID 순서와 부분 요약 여부를 확인한 뒤 가려진 본문을 반환한다.
- **변경.** 요약 모드에서 반환값을 지역 변수에 담아 기존 `result` 패킷으로 한 번 보낸다. 화면 안내·문서 상담도 모드별 처리 순서를 일반적인 조건문으로 펼친다. HTTP 상태를 오류 코드로 바꾸는 긴 삼항식은 같은 파일의 함수 하나로 정리하고, 현재 적용되는 모드별 예외와 기본 오류 순서를 그대로 옮긴다.
- **주의.** `documentReply`는 필드를 선별한 객체를 반환하지만 현재 offscreen은 원래 응답을 가린 객체를 보낸다. 요약에서 가능한 반환값 재사용을 문서 상담에 그대로 적용하면 포트의 필드가 달라질 수 있다. 문서 상담은 실제 전송 필드를 먼저 비교한다. content 쪽 수신 검사, 전송 전후의 프로필 revision 확인, 취소 점검은 각각 다른 시점·입력을 보호한다.
- **완료 기준.** 같은 offscreen 호출 안에서 요약 응답 해석은 한 번이다. 정상·잘못된 요청 ID·부분 요약·취소에서 이전과 같은 결과 또는 오류가 전달된다. 기존 `offscreen.test.cjs`, `consultation_summary.test.cjs`, `profile_offscreen.test.cjs`에서 변경 모드에 해당하는 사례로 확인한다.

#### 관리자 제도 관리 페이지의 한 단계짜리 경유를 없앤다

- **근거.** [AdminPage.tsx](../../FrontEnd/src/pages/AdminPage.tsx)는 11줄이며 제목, 설명 두 줄, `<ProgramManager api={api}/>`로 구성된다. 제품에서 `ProgramManager`를 렌더링하는 곳은 이 페이지 한 곳이다. 테스트는 `ProgramManager`를 직접 렌더링한다.
- **변경.** 제도 관리 화면 구현을 기존 `pages/AdminPage.tsx`에 놓고 페이지가 제목부터 목록·작업까지 소유하게 한다. `components/admin/ProgramManager.tsx`를 제거한다. 별도의 재수출 파일을 남기지 않는다. 독립된 폼인 `ProgramForm`은 유지한다. 기존 테스트의 렌더링 대상을 페이지로 옮겨 같은 사용자 행동을 확인한다.
- **완료 기준.** `/admin/programs` 경로, 관리자 인증, API 주입, 등록·수정·삭제 흐름을 유지하면서 화면을 이해하기 위해 열어야 하는 파일이 하나 줄어든다.

#### Desktop 화면 안내에서 JSON 왕복을 없앤다

- **근거.** [local-clients.cjs](../../Desktop/electron/local-clients.cjs)의 `jsonRequest`가 HTTP 응답을 이미 객체로 파싱한다. `guideStep`은 그 객체의 `step`을 다시 직렬화하고 [assistant-policy.cjs](../../Desktop/electron/assistant-policy.cjs)의 `parseStep`이 즉시 다시 파싱한다.
- **변경.** 제품·패키징·테스트 호출처를 대조한 뒤 검증 함수가 객체를 직접 받게 한다. HTTP 본문 파싱은 네트워크 경계에 둔다. 기존 문자열 호출이 필요한 외부 소비자가 확인되면 그 경계에서만 문자열을 처리한다.
- **완료 기준.** 잘못된 HTTP JSON, 허용하지 않은 action, 비활성·가려진 대상 거절을 각각 담당하는 경계에서 확인한다. 정상 응답에서는 step을 문자열로 되돌리는 과정이 없다. Desktop 관련 작업을 진행할 때 독립 적용할 수 있다.

### 사람이 위에서 아래로 읽을 수 있게 바꿀 흐름

| 우선순위·대상 | 현재 읽기 어려운 이유 | 변경 단위와 완료 기준 |
|---|---|---|
| 높음 · [확장 상담 UI](../../Extension/content.js) | 819줄 안에 스타일 문자열, 프로필 상태, 요약, 화면 안내와 문서 상담이 있다. 전송한 포트의 응답 핸들러에는 두 모드의 표시·저장·오류·정리가 함께 있다. | 문서 응답 표시·저장과 화면 대상 적용을 **같은 파일 안의 이름 있는 함수**로 먼저 옮긴다. 핸들러에서 요청 ID 확인, 모드 선택, 실패 처리, 마지막 정리가 보이게 한다. 여러 문장을 한 줄에 붙인 부분은 이 경로에서만 펼친다. 취소 후 늦은 응답, 덮어쓰지 않아야 할 초안, 저장 실패 시 화면에 남는 답변을 비교한다. |
| 높음 · [문서 상담](../../BackEnd/documents/qa.py) | `answer_document`가 검색 준비, 벡터·키워드 결합, 리랭킹, 프롬프트 구성, 생성 결과 검증, 연락처 선택, 진단 기록을 한 함수에서 수행한다. | 첫 변경은 생성 후 `source_ids/contact_ids` 검증과 사용 문서·연락처 선택을 같은 파일에서 분리하는 데 한정한다. 주 함수에 처리 순서와 실패 결과를 남긴다. 이어서 검색·정렬 부분을 별도 변경으로 옮긴다. 기존 요청 하나의 공개 응답과 진단 필드, 선택 문서 순서, fallback 사유를 전후 비교한다. |
| 중간 · [문서 등록·조회 화면](../../FrontEnd/src/pages/DocumentsPage.tsx) | 등록과 개별 문서 작업은 이미 컴포넌트로 구분돼 있으나 `perform` 안에서 조회 종류마다 다른 응답 처리와 재조회 조건이 교차한다. | 검색·질의·원문 읽기 분기를 같은 파일에서 분명히 하고, 실행 중 여부·오류 표시·정리의 소유자는 하나로 둔다. 원문을 읽기 전후 게시 버전을 재확인하는 호출은 교체 경합을 막는다. 기존 교체 테스트에서 새 게시본으로 바뀐 경우 옛 원문을 표시하지 않는지 확인한다. |
| 중간 · [문서 worker](../../BackEnd/documents/worker.py) | `process_job`에서 재개 가능한 작업 확인부터 분석·임베딩 캐시·배치 저장·게시까지 따라가야 한다. | 임베딩 배치 작성·저장 루프를 같은 모듈의 한 함수로 옮긴다. 작업 획득과 최종 게시 순서는 상위 함수에 둔다. 기존 16개 배치, 캐시 재사용, 작업 token, 게시 직전 digest 확인을 보존한다. 실패·교체 시 기존 게시본이 계속 조회되는지 기존 자동 처리 검사로 확인한다. |

확장 worker의 메시지 분배도 같은 원칙을 적용한다. [worker.js](../../Extension/worker.js)에는 프로필, 대화, UI 저장 작업별 순서를 보장하는 Promise 큐가 각각 있다. 복사된 오류 분기와 들여쓰기를 먼저 정리한다. 서로 독립적인 저장 작업을 한 큐로 합치면 대기 순서가 바뀐다. 대화 저장소의 revision 비교, 같은 문답 재시도의 중복 저장 방지, 삭제 후 늦은 응답 무시는 그대로 둔다.

### 파일을 합칠지 판단한 결과

| 대상 | 판단과 이유 |
|---|---|
| `AdminPage`와 `ProgramManager` | 먼저 통합한다. 단일 화면의 제목과 본체를 연결하는 한 단계가 사라지고 라우트 파일 하나에서 시작할 수 있다. |
| `webchat/Contacts.tsx`, `password-rotation.css` | 선택 사항이다. 연락처 컴포넌트는 24줄이고 제품 호출처는 하나이지만 전화 링크·운영시간을 한 덩어리로 읽을 수 있다. 368줄인 `WebChatPage`로 옮길 이익이 작다. 비밀번호 CSS는 5줄이나 독립 dialog에만 쓰인다. 두 파일 모두 현 구조를 유지하는 편이 낫다. |
| `rag/embeddings.py`, `rag/factory.py`, `documents/auth.py`, 웹 `api/config.ts` | 공유 모듈로 유지한다. 18줄짜리 벡터 검증기는 Ollama·저장·검색·repository에서 쓰고, 서비스 조립은 공개 상담과 관리자 문서 경로에서 함께 사용한다. 문서 관리자 의존성과 웹 API 주소 정책도 호출처가 여럿이다. |
| `Extension/options.js`, Desktop preload, 백엔드 startup/readiness | 작은 실행 진입점으로 유지한다. options 스크립트는 HTML의 CSP와 확장 패키지 파일 목록에 걸린다. preload는 Electron 창 경계이고, startup·readiness는 Compose와 컨테이너가 모듈 이름으로 실행한다. 일반 함수의 import 수만 세면 이 소비자들이 빠진다. |

### 검증을 줄이는 기준

**같은 값·같은 신뢰 경계·같은 시점**에 동일 검사가 반복되면 최초 검사에서 얻은 값을 재사용한다. 요약 응답의 중복 호출이 첫 사례다. 이미 파싱한 DTO를 다시 문자열로 바꿔 같은 구조를 검사하는 Desktop 경로는 표현 변환만 없앤다.

**검사 내용이 길면 조건을 이름 붙여 읽을 수 있게 한다.** 예를 들어 `protocol.js`의 `documentReply`에는 기본 응답 형식, 근거 배열, 요청과 대조하는 맥락 갱신 규칙이 한곳에 있다. 같은 파일에서 세 책임을 분리하고 실패 코드를 유지한다. `profileRevision`, `coveredThroughMessageId`, 사용자 메시지 순서, 주제 전환 지원 여부는 각각 잘못된 대화를 저장할 수 있는 조건이므로 단순 타입 확인으로 대체하지 않는다.

**시점이 바뀌는 검증은 유지한다.** 서버가 생성을 마친 뒤 문서 버전과 모델 digest를 다시 읽는 것은 생성 도중 문서 교체를 검출한다. 확장에서 요청 전후 동의를 읽는 것도 그 사이의 OFF·삭제를 검출한다. 공개 웹 응답의 전화 링크 검증, 관리자 세션 ID를 대조한 만료 처리, storage의 과거 데이터 복원, DB 작업 token과 트랜잭션도 별도 경계다. TypeScript 타입이나 앞선 화면 검사로 이를 대신할 수 없다.

### 큰 삭제는 호출 계약을 먼저 확정한다

[rag/chat.py](../../BackEnd/rag/chat.py)는 699줄이다. 공개 `/api/v1/chat`, `/debug/rag`, 관리자 문서 질의는 현재 `answer_document`를 호출한다. 한편 `ChatService`는 여전히 factory가 만들고, 대화 준비 코드는 이 파일의 가구·소득 라벨을 가져온다. 이전 `answer/answer_with_diagnostics` 경로를 검사하는 테스트도 있다.

따라서 파일 전체 삭제는 후보에서 제외한다. 먼저 HTTP 진입점, 오프라인 도구, 테스트와 진단 스크립트의 호출 목록을 구분한다. 이전 답변 경로의 지원 종료가 확인되면 그 경로에만 전용인 함수·기대값을 한 묶음으로 정리한다. 현재 문서 상담에 쓰는 서비스 구성값과 진단은 유지한다. 실행 경로가 다른 두 답변 엔진을 한 알고리즘으로 합치는 작업은 검색·답변 품질 변경에 해당한다.

그 밖의 경로도 다음과 같이 판단했다.

- **관리자·DB** — `admin/referrals.py`의 기간 계산은 조회와 삭제가 공유한다. KST 기준 기간, 관리자 권한, 보존 기간과 DB 쓰기 경계를 유지한다. SQL migration은 번호로 실행되는 이력이라 파일 통합 대상에서 제외한다.
- **문서 수집·검색** — `ingest/run.py`는 오프라인 CSV 점검 CLI이고 게시 경로는 관리자 업로드·worker다. CLI 플래그나 과거 자료 형식을 정리할 때는 사용 설명과 기존 저장 데이터부터 대조한다. 문서 서식, 검색·리랭킹 점수, 입력 예산은 이번 가독성 작업과 독립된 동작이다.
- **화면·음성** — DOM 수집과 현재 요소 재확인, 음성 입력과 읽기의 취소 수명은 각각 독립된 책임이다. Desktop의 `watch-status.cjs`도 assistant와 Chrome 감시자가 나눠 사용한다. 화면이 비슷하다는 이유로 공개 DOM과 Windows UI Automation에 공통 실행기를 추가하면 권한과 대상 확인 규칙이 섞인다.
- **빌드·운영·검사 도구** — CI의 Python 환경과 웹·확장 job, 확장 패키징 목록, Desktop 빌드, Caddy·Docker 서비스 기동 경로는 실제 호출자다. 파일을 옮기는 단계에서 해당 import·manifest·실행 명령만 함께 갱신한다.

## 부록 · 파일별 주 담당 섹터

각 항목은 `디렉터리` 아래의 실제 파일명이다. 한 파일은 한 섹터에만 배정했다. 여러 기능을 통과하는 검사는 주 담당에 두고, 다른 섹터가 계약을 바꿀 때도 해당 검사를 참조한다.

<details>
<summary>1. Chrome 확장 · 51파일</summary>

**구현·설정·도구 16개**

- `Extension` — `content.js`, `conversation-panel.js`, `conversation-store.js`, `conversations.js`, `dom.js`, `input-assist.js`, `manifest.json`, `offscreen.html`, `offscreen.js`, `options.css`, `options.html`, `options.js`, `package.cjs`, `profile.js`, `protocol.js`, `worker.js`

**테스트·픽스처·측정 도구 35개**

- `Extension/tests` — `admin_auth.test.cjs`, `admin_content.test.cjs`, `answer_speech.test.cjs`, `consultation_summary.test.cjs`, `context_expiry.test.cjs`, `continuous_conversation.test.cjs`, `conversation_context.test.cjs`, `conversation_fixture.cjs`, `conversation_layout.test.cjs`, `conversations_content.test.cjs`, `conversations_worker.test.cjs`, `document_manager.test.cjs`, `document_timeout.test.cjs`, `dom.test.cjs`, `input_assist.test.cjs`, `input_assist_content.test.cjs`, `lifecycle_extra.test.cjs`, `live_context_bridge.cjs`, `mode.test.cjs`, `offscreen.test.cjs`, `options_extra.test.cjs`, `panel_usability.test.cjs`, `privacy.test.cjs`, `profile_content.test.cjs`, `profile_offscreen.test.cjs`, `profile_usage.test.cjs`, `profile_worker.test.cjs`, `protocol.test.cjs`, `referral_notice.test.cjs`, `remote_connection.test.cjs`, `remote_screen.test.cjs`, `stale_extra.test.cjs`, `timeout.test.cjs`, `ui_preferences.test.cjs`, `visibility_document.test.cjs`

</details>

<details>
<summary>2. 공개 웹 상담 · 11파일</summary>

**구현·설정·도구 7개**

- `FrontEnd/src/webchat` — `Contacts.tsx`, `WebChatPage.tsx`, `chatApi.ts`, `speech.ts`, `useSpeech.ts`, `useVoiceInput.ts`, `webchat.css`

**테스트·픽스처·측정 도구 4개**

- `FrontEnd/src/webchat` — `WebChatPage.test.tsx`, `chatApi.test.ts`, `route.test.tsx`, `voice.test.tsx`

</details>

<details>
<summary>3. 관리자 웹·공유 웹 진입점 · 52파일</summary>

**구현·설정·도구 37개**

- `FrontEnd` — `.gitignore`, `index.html`, `package.json`, `tsconfig.json`, `vercel.json`, `vite.config.ts`
- `FrontEnd/scripts` — `ci.mjs`
- `FrontEnd/src` — `App.tsx`, `main.tsx`, `vite-env.d.ts`
- `FrontEnd/src/api` — `auth.ts`, `config.ts`, `documentApi.ts`, `errors.ts`, `httpApi.ts`, `mockApi.ts`, `programs.json`, `referralApi.ts`, `types.ts`
- `FrontEnd/src/auth` — `AuthProvider.tsx`, `session.ts`
- `FrontEnd/src/components` — `Header.tsx`
- `FrontEnd/src/components/admin` — `AdminGate.tsx`, `AdminLogin.tsx`, `DocumentProgress.tsx`, `PasswordRotation.tsx`, `ProgramForm.tsx`, `ProgramManager.tsx`, `password-rotation.css`
- `FrontEnd/src/lib` — `privacy.ts`, `storage.ts`
- `FrontEnd/src/pages` — `AdminPage.tsx`, `DocumentsPage.tsx`, `ReferralsPage.tsx`, `documents.css`
- `FrontEnd/src/styles` — `app.css`, `tokens.css`

**테스트·픽스처·측정 도구 15개**

- `FrontEnd/src/api` — `auth.test.ts`, `documentApi.test.ts`, `errors.rate.test.ts`, `httpApi.test.ts`, `mockApi.test.ts`
- `FrontEnd/src/components/admin` — `PasswordRotation.test.tsx`
- `FrontEnd/src/lib` — `privacy.test.ts`
- `FrontEnd/src/pages` — `AdminPage.test.tsx`, `AdminRouting.test.tsx`, `AuthFlow.test.tsx`, `DocumentsPage.replacement.test.tsx`, `DocumentsPage.test.tsx`, `ReferralsPage.test.tsx`
- `FrontEnd/src/test` — `renderApp.tsx`, `setup.ts`

</details>

<details>
<summary>4. FastAPI·관리자·공통 실행 · 42파일</summary>

**구현·설정·도구 18개**

- `BackEnd` — `__init__.py`, `conversation_summary.py`, `main.py`
- `BackEnd/admin` — `__init__.py`, `credentials.py`, `program_store.py`, `programs.py`, `referral_store.py`, `referrals.py`, `session.py`
- `BackEnd/core` — `__init__.py`, `chat_rate.py`, `db.py`, `execution.py`, `privacy.py`, `qa_diagnostics.py`, `settings.py`
- `BackEnd/documents` — `auth.py`

**테스트·픽스처·측정 도구 24개**

- `BackEnd/tests` — `__init__.py`, `conftest.py`, `test_admin_auth_runtime.py`, `test_admin_password_rotation.py`, `test_admin_peer_limit.py`, `test_admin_programs.py`, `test_admin_programs_db.py`, `test_admin_referrals.py`, `test_admin_referrals_db.py`, `test_api.py`, `test_chat_http_recovery.py`, `test_chat_rate_limit.py`, `test_conversation_summary.py`, `test_database_password.py`, `test_document_http_budget.py`, `test_document_privacy.py`, `test_extension_cors.py`, `test_extension_profile.py`, `test_program_store_locks.py`, `test_qa_diagnostics.py`, `test_request_execution.py`, `test_settings.py`
- `BackEnd/tests/fixtures` — `admin_programs_schema.sql`, `document_privacy_cases.json`

</details>

<details>
<summary>5. 문서 수집·저장·게시와 DB · 28파일</summary>

**구현·설정·도구 19개**

- `BackEnd/db/migrations` — `0001_document_ingestion.sql`, `0002_document_postgres_artifacts.sql`, `0003_original_erd_tables.sql`, `0004_document_candidate_cleanup.sql`, `0005_automatic_document_processing.sql`, `0006_contact_referrals.sql`
- `BackEnd/db` — `schema.sql`
- `BackEnd/documents` — `__init__.py`, `analysis.py`, `api.py`, `contracts.py`, `indexing.py`, `store.py`, `worker.py`
- `BackEnd/ingest` — `__init__.py`, `csv_loader.py`, `details.py`, `official.py`, `run.py`

**테스트·픽스처·측정 도구 9개**

- `BackEnd/tests` — `test_csv_loader.py`, `test_document_automatic_pipeline.py`, `test_document_automatic_store.py`, `test_document_replacement_boundaries.py`, `test_document_transaction_scope.py`, `test_document_worker_diagnostics.py`, `test_documents.py`, `test_ingest.py`, `test_official.py`

</details>

<details>
<summary>6. 상담 RAG·모델·검색 · 33파일</summary>

**구현·설정·도구 17개**

- `BackEnd/documents` — `contacts.py`, `context.py`, `qa.py`, `retrieval.py`, `welfare.py`
- `BackEnd` — `profile_context.py`
- `BackEnd/rag` — `__init__.py`, `chat.py`, `chunking.py`, `embeddings.py`, `evidence.py`, `factory.py`, `ollama.py`, `repository.py`, `reranker.py`, `search.py`, `text.py`

**테스트·픽스처·측정 도구 16개**

- `BackEnd/tests` — `manual_context_live.py`, `measure_document_bm25.py`, `test_automatic_retrieval.py`, `test_chat.py`, `test_conversation_context.py`, `test_document_bm25_cache.py`, `test_document_qa.py`, `test_document_rag_diagnostics.py`, `test_ollama.py`, `test_profile_context.py`, `test_rag_accuracy.py`, `test_repository.py`, `test_reranker.py`, `test_reranker_cache.py`, `test_text.py`, `test_welfare_qa.py`

</details>

<details>
<summary>7. Desktop·화면 안내 서버 · 36파일</summary>

**구현·설정·도구 26개**

- `BackEnd` — `desktop_connection.py`, `desktop_guidance.py`, `desktop_public_labels.json`, `screen_guidance.py`
- `Desktop` — `.env.example`, `.gitignore`, `package.json`
- `Desktop/electron` — `assistant-policy.cjs`, `assistant.cjs`, `chrome-watch.cjs`, `local-clients.cjs`, `main.cjs`, `overlay-layout.cjs`, `overlay-preload.cjs`, `preload.cjs`, `watch-status.cjs`
- `Desktop/native` — `watch.ps1`
- `Desktop/scripts` — `build.mjs`, `pack.cjs`
- `Desktop/shared` — `public-labels.json`, `visibility.cjs`
- `Desktop/src` — `app.css`, `app.jsx`, `index.html`, `overlay.css`, `overlay.html`

**테스트·픽스처·측정 도구 10개**

- `BackEnd/tests` — `test_desktop_dom.py`, `test_desktop_explain_only.py`, `test_desktop_guidance.py`, `test_desktop_timeout.py`, `test_remote_screen.py`, `test_remote_screen_tcp.py`
- `Desktop/electron` — `assistant.test.cjs`, `smoke.cjs`, `tracking.test.cjs`
- `Desktop/shared` — `visibility.test.cjs`

</details>

<details>
<summary>8. 실행·배포·CI · 25파일</summary>

**구현·설정·도구 22개**

- `저장소 루트` — `.dockerignore`, `.env.example`, `.gitignore`, `.python-version`, `.vercelignore`, `docker-compose.yml`, `pyproject.toml`, `requirements-build.in`, `requirements-document-worker.txt`, `requirements-reranker.txt`, `requirements.txt`
- `.github/workflows` — `ci.yml`
- `BackEnd` — `readiness.py`, `startup.py`
- `deploy` — `Caddyfile`
- `docker_script` — `script.sh`
- `dockerfiles` — `Dockerfile.back`, `Dockerfile.document-worker`, `Dockerfile.edge`, `Dockerfile.ollama`
- `scripts` — `ci_python.py`, `lock_python.py`

**테스트·픽스처·측정 도구 3개**

- `BackEnd/tests` — `test_deployment_runtime.py`, `test_public_edge_policy.py`, `test_startup.py`

</details>
