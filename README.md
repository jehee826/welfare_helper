<div align="center">

<h1>곁에 | welfare_helper</h1>
<p><strong>공식 복지 문서에서 근거를 찾아 답하는 복지 길잡이</strong></p>
<p>문서 등록 → 자동 분석 → 원문 검색 → 근거와 함께 답변</p>

<p>
  <img src="https://img.shields.io/badge/DOCUMENT-RAG-222222?style=flat-square&amp;labelColor=555555" alt="Document RAG" />
  <img src="https://img.shields.io/badge/LOCAL-DOCKER-444444?style=flat-square&amp;labelColor=555555" alt="Local Docker" />
  <img src="https://img.shields.io/badge/CAPSTONE-PROJECT-666666?style=flat-square&amp;labelColor=555555" alt="Capstone Project" />
</p>

<p>
  <a href="#소개">소개</a> ·
  <a href="#기술-스택">기술 스택</a> ·
  <a href="#아키텍처">아키텍처</a> ·
  <a href="#로컬-빠른-시작">로컬 실행</a> ·
  <a href="#핵심-환경변수">환경변수</a> ·
  <a href="#문서-등록과-확인">문서 등록</a>
</p>

</div>

---

## 소개

복지로 공개 화면의 Chrome 확장에서 조건을 입력하고, 공식 복지 문서를 검색해 상담받는 캡스톤 프로젝트입니다. 관리자는 기존 웹에서 원문을 등록·교체합니다.

- **문서 관리:** PDF·DOCX·Markdown을 분석하고 구조별 청크와 검색 벡터를 자동으로 생성합니다.
- **문서 상담:** 벡터 검색과 키워드 검색을 결합해 관련 원문을 찾고, 모델 답변과 원문·페이지를 함께 보여줍니다.
- **이용자 편의:** 선택 조건·이전 상담·제한된 요약을 확장에 저장하고, 추천 질문·음성으로 전송할 초안을 작성합니다.

처음 이용할 때 조건 입력 또는 **나중에 입력** → 문서 상담 → 후속 질문·이전 상담 → 필요 시 **화면 안내** 순서로 사용합니다. 기존 React 웹 상담은 보조 경로입니다. [확장 실행·패키지 안내](Extension/README.md)를 참고하세요.

조건·공개 상담·요약은 확장 전용 `chrome.storage.local`에 저장합니다. 관리자·화면 상담 이력은 메모리에, 토큰은 확장 세션 저장소에 두며 상담 전체를 DB에 저장하지 않습니다. 화면 도움은 공개 DOM 기반이며 원격 문서 패키지에서는 제공하지 않습니다.

답변 정확성이나 최종 지원 자격은 보장하지 않습니다. **로컬 Qwen1.5B 실제 서비스 질문 9건은 유효 답변 0건**이었으며 이후 코드 보완의 실제 품질은 재평가하지 않았습니다.

설계와 평가 자료의 위치는 [문서 목차](docs/README.md)를 참고하세요.

## 기술 스택

| 영역 | 기술 |
| :--- | :--- |
| 프런트엔드 | Chrome MV3 · React · TypeScript · Vite · Vitest |
| 백엔드 | Python 3.12 · FastAPI · pytest |
| 문서·AI | Docling · LangChain · Ollama/Qwen · BGE-M3 · ONNX BGE 리랭커 |
| 데이터·배포 | Supabase(PostgreSQL·pgvector) · Docker · EC2 · Vercel |

## 아키텍처

```mermaid
flowchart TB
    Extension["Chrome 확장 · 이용자 상담"] --> API["API · FastAPI"]
    Extension -->|문서 관리 열기| Web["웹 · 관리자 / 보조 상담"]
    Web --> API
    subgraph Ingest["문서 등록"]
        Worker["문서 워커<br/>Docling → 구조별 청크"] --> Embed["Ollama · BGE-M3 임베딩"]
    end
    API -->|원문 업로드| Worker
    Embed --> DB[("Supabase<br/>PostgreSQL · pgvector")]
    subgraph QA["문서 상담"]
        Search["질문 벡터 검색 + BM25<br/>RRF 결합"] --> Rank["BGE 리랭커 · ONNX"]
        Rank --> LLM["Ollama · Qwen"]
    end
    API -->|질문| Search
    DB -->|문서·벡터| Search
    LLM -->|생성 답변| API
    API -->|답변·검색 원문·페이지| Extension
    classDef ui fill:#fff,stroke:#222,color:#111
    classDef process fill:#f3f3f3,stroke:#666,color:#111
    classDef store fill:#e5e5e5,stroke:#222,color:#111
    class Extension,Web,API ui
    class Worker,Embed,Search,Rank,LLM process
    class DB store
    style Ingest fill:#fafafa,stroke:#aaa,color:#111
    style QA fill:#fafafa,stroke:#aaa,color:#111
    linkStyle default stroke:#666
```

운영은 **Vercel(프런트) + EC2(Docker API·워커·Ollama) + Supabase(DB)**로 구성합니다.

## 로컬 빠른 시작

### 1. 준비와 저장소 받기

Git, Node.js/npm, 실행 중인 Docker Desktop(Compose 포함)이 필요합니다.

> **로컬 구성: 앱·모델은 내 PC, DB는 Supabase**
>
> 프로젝트 담당자에게 기존 DB 접속정보를 받고 스키마·부서 데이터가 준비됐는지 확인하세요. 앱은 테이블을 자동 생성하거나 로컬 PostgreSQL로 대체하지 않습니다.

```cmd
git clone https://github.com/jehee826/welfare_helper.git
cd welfare_helper
copy .env.example .env
```

Windows CMD 기준입니다. macOS/Linux에서는 마지막 명령 대신 `cp .env.example .env`를 사용합니다.

### 2. 환경 설정

루트 `.env`에 **`DATABASE_URL`·`DATABASE_PASSWORD`·`ADMIN_PASSWORD`**를 입력합니다. DB URL은 비밀번호를 뺀 Supabase Connect의 **Session pooler URI**, 비밀번호는 별도 값으로 설정합니다.

[.env.example](.env.example)은 EC2 GPU 기준이므로, 로컬에서는 아래 값으로 변경합니다.

```dotenv
OLLAMA_LLM=qwen2.5:1.5b-instruct
OLLAMA_RUNTIME=runc
LLM_NUM_THREAD=2
OLLAMA_TIMEOUT=600
VITE_API_BASE_URL=
```

로컬에서는 `COMPOSE_PROFILES`를 설정하지 않습니다. `OLLAMA_EMBED=bge-m3`, `EMBED_DIM=1024`와 리랭커 리비전은 예시 그대로 유지합니다. 비밀값은 Git이나 `VITE_` 변수에 넣지 않습니다.

### 3. 백엔드와 프런트 실행

**터미널 A · 저장소 루트**

```cmd
docker compose up -d --build
docker compose ps
```

<details>
<summary>첫 실행은 모델 다운로드로 시간이 걸립니다</summary>

생성·임베딩 모델과 리랭커는 자동으로 준비합니다. 첫 PDF 처리에서는 Docling 모델도 추가로 내려받습니다.

</details>

세 서비스가 healthy이고 [준비 상태](http://127.0.0.1:8000/health/ready)가 **200**인지 확인합니다. API 명세는 [Swagger](http://127.0.0.1:8000/docs)에서 볼 수 있습니다.

<details>
<summary>문서 RAG 설정·진단 확인</summary>

`/health/runtime`은 연결 검사 없이 지원 기능과 적용 설정을 보여줍니다. `/debug/rag`는 `/api/v1/chat`과 같은 QA를 한 번 실행하며, 별도 활성화·32자 이상 `X-Rag-Debug-Token`이 필요하고 Vercel에서는 차단됩니다. 비공개·테스트 자료에는 유효한 관리자 Bearer 세션도 필요합니다. 현재 조건·최근 대화·선택적 누적 요약은 검색 의도이며 사실 근거는 이번 원문입니다. 같은 문서·버전의 관련 부모와 조건·예외를 함께 전달하고 예산이 부족하면 보류합니다. 답변의 실제 원문 인용·숫자·연락처 대응을 확인하지만 모든 주장의 의미나 최종 자격을 검증하는 것은 아닙니다. 관련 근거 없음·조건 부족·복지 외 질문은 보류하며 검색 점수 하한은 적용하지 않습니다.

문서 요청의 전체 예산은 `OLLAMA_TIMEOUT`(최대 1800초)이며, 선택적 `timeout_seconds`(1~1800 정수)로 줄일 수 있습니다. 문서·화면 실행은 **프로세스당 1개·대기 0개**로 제한하고 혼잡은 429, 기한 초과는 504, 연결 종료 취소는 가능한 경우 499로 구분합니다. 웹의 취소 버튼은 전송을 중단하며, 이미 실행 중인 DB·ONNX 작업의 즉시 종료를 보장하지 않습니다. native 작업이 끝날 때까지 다음 실행은 받지 않습니다. 다중 worker·문서 적재 프로세스에 걸친 전역 제한은 아닙니다.

리랭커 객체는 설정별 최대 4개를 재사용하지만 문서 snapshot과 BM25는 요청마다 다시 구성합니다. 공통 관리자 비밀번호는 로컬 `.env` 또는 배포 환경의 `ADMIN_PASSWORD`를 변경한 뒤 백엔드를 재생성·재기동해야 적용됩니다. Compose는 `docker compose up -d --force-recreate backend`로 환경값을 다시 주입하며, 단순 `restart`는 변경된 환경값을 반영하지 않습니다.

</details>

**터미널 B · 저장소 루트에서 시작**

```cmd
cd FrontEnd
npm ci
npm run dev
```

[http://localhost:5173](http://localhost:5173)에 접속합니다. Vite가 `/api` 요청을 로컬 백엔드로 전달합니다. 백엔드 코드 변경 후에는 같은 Compose 명령으로 재빌드합니다.

## 핵심 환경변수

- `DATABASE_URL` / `DATABASE_PASSWORD`: 기존 Supabase Session pooler의 비밀번호 없는 URI와 별도 DB 비밀번호.
- `ADMIN_PASSWORD`: 문서·제도 관리를 위한 서버 공통 관리자 비밀번호.
- `OLLAMA_LLM` / `OLLAMA_RUNTIME`: 생성 모델과 컨테이너 런타임(`runc` 또는 `nvidia`).
- `OLLAMA_EMBED` / `EMBED_DIM`: 문서·질문 임베딩 모델과 벡터 차원(`bge-m3` / `1024`).
- `LLM_NUM_THREAD` / `OLLAMA_TIMEOUT`: 생성 CPU 스레드 수와 모델 요청 대기 시간(초).
- `VITE_API_BASE_URL`: 로컬은 빈 값, 운영은 `/api`를 제외한 HTTPS API 주소이며 변경 후 프런트 재빌드 필요.

전체 설정은 [.env.example](.env.example)을 참고합니다. 프런트와 Compose 모두 저장소 루트 환경파일을 사용합니다.

## 문서 등록과 확인

1. **문서 관리**에서 `ADMIN_PASSWORD`로 로그인합니다.
2. **제도 등록·관리**에서 준비된 부서를 선택해 제도를 등록하거나, 기존 제도를 사용합니다.
3. 연결할 제도를 고르고 **PDF·DOCX·UTF-8 Markdown** 원문을 업로드합니다.
4. 자동 분석·청크 생성·임베딩·**게시 완료**를 기다린 뒤 기본 채팅에서 질문합니다.
5. **원문 근거 보기**를 펼쳐 답변과 검색 원문·페이지를 대조합니다.

**로컬 업로드도 연결된 Supabase에 실제 저장됩니다.** `TEST_`/`test_only` 자료는 로그인한 관리자 상담에서만 확인할 수 있습니다.
