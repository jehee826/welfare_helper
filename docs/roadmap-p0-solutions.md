# P0 로드맵 해결방안

- 작성일: 2026-10-28
- 대상: [implementation-gap-analysis.md](implementation-gap-analysis.md) §7 "P0: 시연 전 필수"의 2 → 4 → 1 → 3번
- 기준 코드: `origin/main` 병합 후(`2f3d1f6`). 8테이블 ERD(`docs/복지챗봇.erd`), 문서 업로드 API(`/api/v1/admin/documents`), Supabase 토큰 기반 관리자 검증이 들어온 상태

| 순서 | P0 번호 | 작업 | 바뀌는 곳 | 선행 조건 |
|:-:|:-:|---|---|---|
| ① | 2 | 관리자 제도 관리를 실제 DB와 연결 | 백엔드 관리자 API 신규, 프론트 `ProgramManager` | 없음 (API는 로컬 모드로 먼저 검증) |
| ② | 4 | 안내 범위 고지 | 프론트 문구 3곳 | 없음 |
| ③ | 1 | 관리자 키 폐기와 서버 인증 연결 | 프론트 로그인, Vercel 환경변수, Supabase Auth | ①의 API가 쓰는 인증과 같은 경로 |
| ④ | 3 | 막다른 추천 버튼 제거 | 백엔드 `_follow_ups`, 프론트 `ChatPanel` | 없음 |

> 병합 후 갭 분석 문서의 일부(§3 데이터 설계 대비, §0의 데이터 행)는 현재 코드와 다릅니다. 지금 DB에는 `departments`, `welfare_programs`, `counselors`, `counselor_connections`, 문서 3종 테이블이 있고, 상세 근거는 검토를 거친 문서 벡터로만 들어갑니다. 아래 해결방안은 병합 후 구조를 기준으로 썼습니다.

---

## ① 관리자 제도 관리를 실제 DB와 연결 (P0-2)

> **진행 상태 (2026-10-28): 구현·검증 완료.** 아래 설계에서 바뀐 점
> - 이름·외부 ID 잠금 기준을 "게시 문서가 있을 때"에서 **"문서가 하나라도 있을 때"**로 넓혔습니다. 검토 단계(`queue_index`)에서도 제도 이름을 저장하고, 게시(`activate`)할 때 현재 이름과 다시 비교하기 때문입니다.
> - `FrontEnd/vite.config.ts`의 프록시를 `changeOrigin: false` 객체형으로 바꿨습니다. 문자열 축약형은 Vite가 Host를 백엔드 주소로 바꿔서, 로컬 모드의 Origin 검사가 화면의 모든 쓰기 요청을 403으로 막았습니다.
> - 인증은 기존 `require_document_admin`을 그대로 씁니다(`DOCUMENTS_ENABLED=true` 필요). `require_admin` 분리는 ③에서 합니다. ③ 전까지 공개 배포의 관리자 화면은 토큰이 없어 401을 받으므로, 이 기능은 로컬 모드에서만 쓸 수 있습니다.
> - 최종 검사에서 고친 회귀: 모바일(480px 이하) 관리자 표가 열 번호로 숨기는 규칙 때문에 "원문 문서" 열을 숨기고 긴 "소관" 열을 남겼고, 제도명이 한 글자 폭으로 찌그러지며 삭제 버튼이 밀려났습니다. 모바일에서는 소관·원문 문서·갱신일 열을 숨기고 원문 문서 수를 제도명 아래 줄로 옮겼습니다.
> - 검증: pytest 37개 추가(로컬 PostgreSQL 통합 테스트 9개 포함, `WELFARE_TEST_DATABASE_URL`을 줄 때만 실행), Vitest 16개 추가·수정. 임시 DB와 브라우저로 추가 → 반영 확인 → 수정 → 이용자 채팅 반영 → 문서 연결 제도의 이름 변경·삭제 거절까지 확인했습니다.

### 현재 상태

| 구분 | 현재 |
|---|---|
| DB | 제도는 `welfare_programs` + `departments`. SQL로 미리 등록하고, 상세 근거는 문서 API로 붙임 |
| 백엔드 | 제도는 `GET /api/v1/admin/documents/programs`(조회)만 있음. 생성·수정·삭제 API 없음 |
| 프론트 | `ProgramManager.tsx`가 목업을 씀. `programs.json` 20건을 localStorage에 저장 (`httpApi.ts`가 `listPrograms`·`savePrograms`를 목업에 맡김) |
| 결과 | 관리자 화면에서 수정해도 챗봇에 반영되지 않고, 화면의 목록과 실제 DB 목록이 다름 |

### 해결 방향

제도 **메타데이터**(이름, 요약, 부서, 문의처, 출처, 기준일, 테스트 여부)만 관리자 API로 수정합니다. 신청자격·지원내용·신청방법 같은 **상세 근거**는 지금처럼 문서 업로드 → 검토 → 게시 흐름으로만 바꿉니다. 이렇게 나누는 이유는 다음과 같습니다.

- `snapshot()`이 요청마다 `welfare_programs`를 다시 읽고 `stamp`로 BM25 캐시를 무효화합니다. 메타데이터는 **재임베딩 없이** 다음 질문부터 반영됩니다.
- 상세 근거는 "검토된 원문만 답한다"는 현재 원칙(`store.policy`: CSV 필드를 상세 근거로 승격하지 않음)을 지켜야 합니다. ERD의 `eligibility`·`benefit_details`·`application_method` 컬럼은 화면에서 편집하지 않습니다.

### 주의: 이름을 바꾸면 문서 근거가 무효가 됨

`documents/retrieval.py`의 `validate_document_vectors`는 청크의 `service_name`이 현재 제도 이름과 같은지 검사합니다. 게시된 문서가 있는 제도의 `program_name`이나 `external_service_id`를 바꾸면, 그 제도의 근거 전체가 `invalid_document_provenance`로 빠져서 답변에서 사라집니다.

→ 게시 문서가 있는 제도는 이름·외부 ID 변경을 **409로 막고**, "문서를 다시 색인해야 합니다"라고 안내합니다. 변경이 필요하면 문서를 교체(`PUT /api/v1/admin/documents/{id}`)하거나 재시도한 뒤 다시 검토합니다.

### 백엔드

새 라우터 `BackEnd/admin/programs.py` (prefix `/api/v1/admin`)를 만들고, 인증은 기존 `require_document_admin`을 그대로 씁니다. DB 연결은 `get_document_store()`의 service role 연결을 재사용합니다.

| 메서드 | 경로 | 동작 | 실패 |
|---|---|---|---|
| GET | `/programs?query=&offset=&limit=` | 제도 + 부서 + 문서 수(전체/게시) | |
| POST | `/programs` | 제도 생성 | 422 검증, 409 외부 ID 중복 |
| PATCH | `/programs/{program_id}` | 일부 필드 수정. `expected_updated_at` 필수 | 404, 409 `program_changed`(동시 수정), 409 `program_has_published_documents`(이름·외부 ID 변경) |
| DELETE | `/programs/{program_id}` | 문서가 하나도 없을 때만 삭제 | 409 `program_has_documents` |
| GET | `/departments` | 부서 선택 목록 | |

요청 모델 (`pydantic`):

```python
class ContactIn(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    phone: str = Field(default="", max_length=30, pattern=r"^[0-9~,\- ]*$")


class ProgramIn(BaseModel):
    program_name: str = Field(min_length=1, max_length=200)
    summary: str = Field(default="", max_length=2000)
    department_id: int
    external_service_id: str | None = Field(default=None, pattern=r"^[A-Z0-9_]{3,40}$")
    source_url: HttpUrl | None = None
    source_updated_at: date | None = None
    contacts: list[ContactIn] = Field(default_factory=list, max_length=10)
    test_only: bool = False


class ProgramPatch(BaseModel):
    expected_updated_at: datetime
    program_name: str | None = Field(default=None, min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=2000)
    department_id: int | None = None
    external_service_id: str | None = Field(default=None, pattern=r"^[A-Z0-9_]{3,40}$")
    source_url: HttpUrl | None = None
    source_updated_at: date | None = None
    contacts: list[ContactIn] | None = Field(default=None, max_length=10)
    test_only: bool | None = None
```

수정은 낙관적 잠금으로 처리합니다.

```sql
UPDATE public.welfare_programs
SET program_name = coalesce(%(program_name)s, program_name), ...
WHERE program_id = %(program_id)s AND updated_at = %(expected_updated_at)s
RETURNING *;
```

영향받은 행이 0이면, 행이 있으면 409 `program_changed`, 없으면 404로 응답합니다. 이름·외부 ID 변경 요청이면 같은 트랜잭션에서 `SELECT 1 FROM rag_documents WHERE program_id=%s AND active_job_id IS NOT NULL FOR SHARE`로 먼저 확인합니다.

> DB에 이미 CHECK 35개와 UNIQUE 제약이 있습니다(인계 문서 기준). API 검증 규칙을 정하기 전에 Supabase SQL Editor에서 `welfare_programs`의 제약을 읽기 전용으로 조회해 맞춰 주세요. 앱은 DDL을 자동 실행하지 않는 원칙이므로 이 작업에 마이그레이션은 필요 없습니다.

### 프론트엔드

| 파일 | 변경 |
|---|---|
| `api/types.ts` | `AdminProgram` 타입 추가 (`programId`, `serviceId`, `name`, `summary`, `departmentId`, `departmentName`, `ministryName`, `contacts`, `sourceUrl`, `sourceUpdatedAt`, `testOnly`, `updatedAt`, `documents: {total, published}`). `WelfareApi`의 `savePrograms(전체 배열)`를 `createProgram` / `updateProgram` / `deleteProgram` 단건 함수로 교체 |
| `api/httpApi.ts` | 위 함수를 실제 API로 구현. 관리자 요청에는 ③에서 받는 access token을 `Authorization: Bearer`로 붙임 |
| `api/mockApi.ts` | 같은 인터페이스로 맞춰 `VITE_USE_MOCK=true` 개발 모드 유지 |
| `components/admin/ProgramForm.tsx` | DB에 없는 `category`·`keywords` 제거. `eligibility`·`benefit`·`howToApply` 입력란 제거 후 "상세 내용은 원문 문서를 올려 검토 후 반영돼요" 안내. 부서는 `/departments` 선택 목록으로 |
| `components/admin/ProgramManager.tsx` | 목록 열에 "원문 문서 n건 (게시 m건)" 표시. 409 응답별 안내 문구. "목업: 이 브라우저에만 저장" 문구 삭제 |

"반영 확인"(샘플 질문)은 이미 실제 `/api/v1/chat`을 호출하므로 DB 연결 후에는 그대로 맞게 동작합니다. 단, `test_only` 제도는 일반 채팅 검색에서 빠지므로 결과에 나오지 않는다는 안내를 붙입니다.

### 완료 기준

- pytest: 인증 없음 401, 생성, 외부 ID 중복 409, 동시 수정 409, 게시 문서가 있는 제도의 이름 변경 409, 문서가 있는 제도 삭제 409
- Vitest: `httpApi`가 토큰 헤더를 붙여 각 경로를 호출, `ProgramManager`가 409 안내 문구를 표시
- 로컬 모드(`DOCUMENTS_LOCAL_MODE=true`, 루프백)에서 요약을 고친 뒤, 같은 제도를 묻는 채팅 답변 카드에 새 요약이 나오는지 확인

---

## ② 안내 범위 고지 (P0-4)

> **진행 상태 (2026-10-28): 구현·검증 완료.** 아래 설계에서 바뀐 점
> - 채팅 하단은 기존 "AI 안내는 참고용이에요" 경고를 지우지 않고 범위 고지를 덧붙였습니다.
> - 조건 입력 화면의 고지는 `aria-describedby`로 "사는 곳" 선택 상자에 연결해 화면 낭독기가 함께 읽습니다.
> - 세 고지에 `word-break: keep-all`(`.scope-notice`)을 적용해 단어 중간에서 줄이 끊기지 않게 했습니다.
> - 검증: Vitest 3개 추가(전체 44개 통과). 360px 폭과 글자 크게 모드에서 세 화면을 직접 확인했고, 고지 때문에 생긴 가로 넘침은 없습니다.
> - **별도 발견 (범위 밖, 미수정)**: 글자 크게 모드에서 상단 헤더 버튼 3개("글자 보통·내 조건·지난 상담")가 360px 폭을 16px 넘어 가로 스크롤이 생깁니다. 보통 글자 모드에서는 생기지 않습니다. `Header.tsx`·헤더 CSS의 기존 문제입니다.

### 현재 상태

- 이용자는 거주지를 고르지만, 등록된 자료는 중앙부처 제도와 검토된 원문뿐입니다. 지자체 서비스가 없다는 안내가 화면 어디에도 없습니다.
- `rag_documents`에 `region_scope`, `valid_from`, `valid_until` 컬럼은 있지만 화면 고지에는 쓰지 않습니다.

### 해결 방향

먼저 **고정 문구**로 세 곳에 고지합니다. 동적 고지(등록 건수, 지역 범위 집계)는 데이터가 쌓인 뒤 P1로 미룹니다.

| 위치 | 문구 |
|---|---|
| `ConditionForm.tsx` "사는 곳" 아래 | "지금은 중앙부처 복지서비스를 안내해요. 시·군·구 자체 서비스는 주민센터에 문의해 주세요." |
| `ChatPanel.tsx` 하단 안내 (기존 "AI 안내는 참고용이에요" 줄) | "중앙부처 복지서비스와 검토된 원문 기준으로 안내해요. 지역 서비스와 최종 자격은 주민센터나 보건복지상담센터(129)에서 확인해 주세요." |
| `FallbackCard.tsx` | 기존 문구 아래에 "지역 자체 서비스는 아직 안내 범위에 없어요." |

- 문구는 `lib/notice.ts` 한 곳에 상수로 두고 세 컴포넌트가 가져다 씁니다. 범위가 넓어지면 한 곳만 고치면 됩니다.
- 백엔드 답변 끝에는 이미 "자료 기준 이후 변경 여부와 최종 지원 자격은 담당 기관에서 확인해 주세요."가 붙습니다. 범위 문구를 답변마다 반복하면 고령 이용자가 읽을 양이 늘어나므로 백엔드는 바꾸지 않습니다.

### 완료 기준

- Vitest: 세 화면에 고지 문구가 렌더링되는지 확인
- 글자 크게 모드에서 줄바꿈이 깨지지 않는지 모바일 폭(360px)에서 확인

---

## ③ 관리자 키 폐기와 서버 인증 연결 (P0-1)

### 현재 상태

| 구분 | 현재 |
|---|---|
| 프론트 | `AdminLogin.tsx`가 `VITE_ADMIN_DEMO_KEY`(4자)와 브라우저에서 비교. 값이 빌드 번들의 `expectedKey:"…"`에 그대로 들어감 |
| 백엔드 | `documents/auth.py`의 `require_document_admin`이 이미 공개 모드에서 Supabase access token을 `/auth/v1/user`로 확인하고 `rag_document_admins` 허용 목록(active)을 검사함. 로컬 모드는 루프백 요청만 허용 |
| 빈틈 | 프론트가 이 백엔드 인증을 쓰지 않음. 허용 목록도 조회 당시 비어 있음 |

새 인증 체계를 만들 필요는 없습니다. **프론트를 이미 있는 백엔드 인증에 연결**하면 됩니다.

### 1단계: 즉시 조치 (코드 변경 없이)

1. Vercel 프로젝트 환경변수와 `FrontEnd/.env`에서 `VITE_ADMIN_DEMO_KEY`를 **삭제**하고 다시 배포합니다. 새 번들에서 키가 사라집니다.
2. 이전 배포본의 번들에는 키가 남아 있습니다. Vercel에서 이전 Production·Preview 배포를 지우거나, Preview에 Deployment Protection을 켭니다.
3. 같은 문자열을 다른 곳(DB 비밀번호, 다른 키 등)에 쓰고 있다면 그 값을 교체(rotate)합니다. 이 키는 화면 잠금만 했으므로 서버 쪽에서 따로 무효화할 대상은 없습니다.

### 2단계: Supabase Auth 준비 (대시보드)

1. Authentication → Sign In / Providers → Email에서 **새 사용자 가입을 끕니다**. 관리자 계정은 초대로만 만듭니다.
2. 복지관 담당자 계정을 초대(Invite user)하고, SQL Editor에서 허용 목록에 넣습니다.

```sql
INSERT INTO public.rag_document_admins (user_id, active)
VALUES ('<auth.users의 id>', true);
```

3. Project Settings → API에서 Project URL과 **anon(publishable) 키**를 확인합니다. anon 키는 공개용 키이고, 모든 테이블에 RLS가 켜져 있어 anon으로는 테이블에 접근할 수 없습니다(인계 문서 확인 사항). `SUPABASE_SERVICE_KEY`는 절대 프론트에 넣지 않습니다.

### 3단계: 프론트 연결

| 파일 | 변경 |
|---|---|
| `package.json` | `@supabase/supabase-js` 추가 |
| `FrontEnd/.env.example` | `VITE_ADMIN_DEMO_KEY` 삭제, `VITE_SUPABASE_URL=`, `VITE_SUPABASE_ANON_KEY=` 추가 |
| `lib/supabase.ts` (신규) | `createClient(url, anonKey)` 한 번만 생성 |
| `components/admin/AdminLogin.tsx` | 키 입력 대신 이메일·비밀번호 입력 → `supabase.auth.signInWithPassword` → 성공하면 `GET /api/v1/admin/session`으로 허용 목록 확인. "목업 안내" 문구 삭제 |
| `pages/AdminPage.tsx` | `authed` 상태를 `supabase.auth.getSession()`과 `onAuthStateChange`로 대체. 로그아웃은 `supabase.auth.signOut()` |
| `api/httpApi.ts` | 관리자 요청마다 현재 세션의 `access_token`을 헤더에 붙임. 401이면 세션을 지우고 로그인 화면으로 |

### 4단계: 백엔드 보완

- `GET /api/v1/admin/session` 추가: `require_document_admin`만 통과시키고 `{"admin": true}`를 돌려줍니다. 로그인 직후 허용 목록에 없는 계정을 바로 알려주기 위해서입니다.
- `require_document_admin`은 `DOCUMENTS_ENABLED=false`이면 503을 냅니다. ①의 제도 API는 문서 기능과 별개이므로, 인증 부분만 `require_admin`으로 분리하고 `require_document_admin`은 "문서 기능 확인 + `require_admin`"으로 감쌉니다.
- 매 요청마다 Supabase `/auth/v1/user`를 호출합니다(타임아웃 15초). 관리자 화면의 요청이 많아지면 토큰 해시 기준 60초 메모리 캐시를 둡니다. 로그인 시도 횟수 제한은 Supabase Auth 자체 제한을 씁니다.

### 설계 문서 반영

프로세스 06 설계는 "암호화 키 하나로 로그인"입니다. 이를 "초대받은 관리자 계정(이메일·비밀번호)으로 로그인하고 서버가 허용 목록을 확인"으로 고치고, 이벤트 표(키 제출 → 서버 검증 → 세션 발급 / 실패 → 재입력)를 채웁니다.

> 대안: 팀이 "키 하나" 방식을 유지하려면, 백엔드 `.env`의 `ADMIN_KEY`(해시)와 비교해 서명된 httpOnly 쿠키를 발급하는 방법도 있습니다. 다만 백엔드는 이미 Supabase Auth 기준으로 구현돼 있어 인증 경로가 둘이 되므로 권장하지 않습니다.

### 완료 기준

- 새 배포 번들에서 `expectedKey` 문자열과 이전 키 값이 검색되지 않음
- pytest: `/api/v1/admin/session`이 토큰 없음 401, 허용 목록에 없는 계정 403, 허용 계정 200 (`httpx` 호출은 목으로 대체)
- Vitest: 로그인 성공·실패·허용 목록 거부 화면, 401 응답 시 로그인 화면 복귀

---

## ④ 막다른 추천 버튼 제거 (P0-3)

### 현재 상태

`rag/chat.py`의 `_follow_ups(record)`는 제도마다 항상 다음 3개를 만듭니다.

| 버튼 | 질문 의도 (`search.query_intents`) | 필요한 근거 섹션 |
|---|---|---|
| `{제도명} 신청 방법` | application | `application` |
| `{제도명} 받을 수 있는 조건` | eligibility | `target`, `criteria` |
| `{제도명} 문의처` | 문의처 분기 (연락처 바로 응답) | `contacts` |

해당 제도에 검토된 원문이 없으면 앞의 두 버튼은 "확인하지 못한 항목 … 답변을 보류했어요"로 끝납니다. 인계 문서 기준으로 지금 DB의 벡터는 0건이므로, 현재는 **모든 제도에서** 두 버튼이 막다른 길입니다. 또 여러 fallback(`model_not_ready`, `unverified_quote`, `clarification` 일부)이 `suggestions: []`를 돌려줘서, 음성 인식이 막혀 버튼에 의지하는 이용자에게 누를 버튼이 남지 않습니다.

### 해결 방향

**답할 근거가 있는 버튼만 만듭니다.**

```python
FOLLOW_UPS = [
    ({"application"}, "{name} 신청 방법"),
    ({"target", "criteria"}, "{name} 받을 수 있는 조건"),
    ({"benefit"}, "{name} 지원 내용"),
]


def _follow_ups(record: ServiceRecord, chunks: list[EvidenceChunk], profile: dict | None) -> list[str]:
    sections = {c.section for c in chunks if c.service_id == record.service_id and c.source_kind != "csv_summary"}
    picks = [template.format(name=record.name) for needed, template in FOLLOW_UPS if needed & sections]
    if record.contacts:
        picks.append(f"{record.name} 문의처")
    return list(dict.fromkeys(picks + _starter_suggestions(profile)))[:4]
```

- `chunks`에는 `_answer`에서 임베딩 digest 불일치 서비스를 걸러낸 뒤의 목록을 넘깁니다. `snapshot.chunks`를 그대로 쓰면 실제로는 답할 수 없는 섹션이 버튼으로 나옵니다.
- 문의처 분기(`pinned and 문의처|연락처|전화번호`)는 digest 확인 전에 응답합니다. 이 경로에서는 `snapshot.chunks`에서 `snapshot.unavailable_services`에 든 서비스를 뺀 목록을 씁니다.
- `지원 내용` 버튼을 새로 추가합니다. 문구가 `query_intents`의 benefit 정규식(`지원 내용`)에 걸리는지 테스트로 고정합니다.
- 근거가 하나도 없는 제도는 "문의처" + 일반 추천(`_starter_suggestions`)으로 채워 버튼이 비지 않게 합니다.
- `suggestions: []`를 돌려주는 fallback은 `_starter_suggestions(profile)`로 바꿉니다. 단, "같은 이름의 제도가 여러 개" 같은 되묻기 상황은 버튼이 오히려 헷갈리게 하므로 지금처럼 비워 둡니다.

프론트 보완 (`ChatPanel.tsx`):

```tsx
setSuggestions(answer.suggestions.length ? answer.suggestions : api.initialSuggestions(profile));
```

### 완료 기준

- pytest
  - 근거가 없는 제도: 버튼에 "신청 방법"·"받을 수 있는 조건"이 없고, "문의처"와 일반 추천만 있음
  - `application` 섹션만 있는 제도: "신청 방법"만 추가됨
  - **생성된 모든 버튼 문구를 `query_intents`에 넣으면 그 제도가 가진 섹션의 의도로 분류됨** (버튼 문구와 의도 분류가 어긋나는 회귀 방지)
  - 버튼을 실제로 다시 질문으로 보냈을 때 `unanswered_intents`가 비어 있음 (가짜 저장소·리랭커로)
- Vitest: 빈 `suggestions` 응답 뒤에도 추천 버튼이 남아 있음

---

## 함께 발견한 점 (이번 범위 밖)

- 백엔드 `/api/v1/chat`은 `history`(최근 대화)를 받도록 바뀌었지만, 프론트 `ChatPanel`은 아직 `query`와 `profile`만 보냅니다. 그래서 "그거 신청은요?" 같은 이어지는 질문의 맥락이 전달되지 않습니다. P2의 멀티턴 항목에서 프론트만 연결하면 됩니다.
- 관리자 "이용 통계" 탭은 여전히 하드코딩된 목업입니다. `counselor_connections`에 실제 기록이 쌓이기 전까지는 화면에 "예시 데이터" 표시를 유지합니다.
- `BackEnd/scripts/`에는 `__pycache__`만 남아 있습니다 (P0-5).
