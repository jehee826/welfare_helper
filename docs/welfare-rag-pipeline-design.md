# 복지서비스 RAG 파이프라인 설계서
### CSV → 수집 → 전처리 → 청킹 → 임베딩 → 의미검색 → 응답

> **대상 저장소**: `C:\Users\sjh43\Desktop\welfare_helper` (브랜치 `feature/vectorDB`)
> **이 문서의 위치**: [welfare-rag-chatbot-plan.md](welfare-rag-chatbot-plan.md)의 프롬프트 3, 4, 6, 7, 8을 실제 구현할 수 있는 수준으로 구체화한 설계서입니다.
> **피처 선별 근거**: [welfare-rag-features.md](welfare-rag-features.md)
> **스택**: FastAPI · PostgreSQL + pgvector · Ollama (LLM은 `OLLAMA_LLM`, 임베딩은 `OLLAMA_EMBED`) · psycopg2 · Docker Compose · 프론트엔드 React 크롬 확장 (Manifest V3, 미착수)
> **사용법**: §12의 단계별 프롬프트를 Sonnet에 하나씩 붙여 넣습니다. 한 단계가 테스트 하나, 커밋 하나입니다.
> **기준본**: `welfare_helper/docs/`에 있는 이 파일이 기준입니다. 다른 곳의 사본은 참고용입니다.
> **현재 상태 (2026-09-19)**: Step 0(환경)이 거의 끝났고, Step 1~8은 파일 뼈대(docstring 명세)만 있습니다. Step 9 이후와 프론트엔드는 아직 파일이 없습니다. 자세한 내용은 §2.3에 있습니다.

---

## 0. 핵심 결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 데이터 | `data/sources.toml`에 등록한 **소스 단위**로 관리합니다. 현재는 복지로 중앙부처 CSV(367건) 1개이고, OpenAPI 보강은 `--enrich`로 켭니다 | CSV를 계속 추가하고 고칠 예정이므로, 파일 하나에 묶인 구조 대신 소스와 스냅샷을 선언적으로 관리합니다. CSV에는 신청자격과 복지내용이 없어서 보강 없이도 전체가 동작해야 합니다 |
| **데이터 갱신** | `python -m ingest.sync` 하나로 반영합니다. **3단계 diff**(파일 지문 → 레코드 해시 → 청크 해시)로 바뀐 것만 처리하고, 스냅샷에서 빠진 서비스는 **소프트 삭제**합니다. 대량 삭제 가드, 동시 실행 잠금, 실행 이력을 둡니다 | 새 CSV를 넣을 때마다 전체를 다시 임베딩하지 않고, 잘못된 파일이 들어와도 서비스가 무너지지 않게 합니다 (§7.6) |
| **전처리** | 원본은 절대 수정하지 않습니다. 소스별 **어댑터**가 정제와 파생 피처를 만들고, 결과는 `data/processed/{source_id}.jsonl`과 품질 리포트로 남깁니다 | 인덱싱이 원본 형식과 네트워크에 의존하지 않게 하고, 결과를 사람이 직접 검토할 수 있게 합니다. 형식이 다른 CSV는 어댑터만 추가하면 됩니다 |
| 청킹 | **필드(섹션) 기반.** 서비스마다 overview 청크 1개와 섹션(지원대상/선정기준/지원내용) 청크를 만들고, 500자를 넘는 섹션만 분할합니다 | 레코드형 데이터라 고정 길이로 자르면 섹션 경계가 깨집니다 |
| 임베딩 | `bge-m3`를 Ollama로 서빙합니다 (1024차원). 대안은 `KURE-v1`입니다 | 한국어를 지원하고 로컬에서 무료로 돌아갑니다. 기존 compose의 ollama 컨테이너를 그대로 씁니다 |
| DB 접근 | **psycopg2**(기존 requirements)와 `pgvector.psycopg2.register_vector`를 씁니다. 비동기 엔드포인트에서는 `run_in_threadpool`로 호출합니다 | 기존 의존성을 유지하고, SQLAlchemy 도입 부담을 피합니다 |
| 검색 | dense(pgvector)와 키워드(Kiwi → tsvector)를 **RRF**로 합친 뒤 **서비스 단위로 집계**해 Top 5를 고릅니다. 서비스명 사전으로 pin합니다 | 서비스명을 정확히 적은 질의는 키워드가, 상황을 설명하는 질의는 dense가 강합니다 |
| 응답 | Ollama `/api/chat`을 SSE로 스트리밍합니다. **출처와 문의처는 DB에서 가져옵니다** | LLM이 URL이나 전화번호를 지어내는 것을 원천 차단합니다 |
| 평가 | golden set 30문항 이상으로 Recall@5, MRR, 무응답 정확도를 잽니다 | 파라미터를 숫자로 튜닝하기 위해서입니다 |

---

## 1. 아키텍처

```
┌──────────── 오프라인: 동기화 (python -m ingest.sync [--source ID] [--dry-run] [--enrich]) ──┐
│                                                                                          │
│  data/sources.toml ─▶ [소스별 입력 파일 선택] data/raw/{source_id}/*.csv                 │
│                           │                                                              │
│                  [① 파일 지문] 직전 반영과 같으면 건너뜀 (파일 해시 + 설정 + 버전)       │
│                           ▼                                                              │
│  [A. 수집] 어댑터 read: 인코딩·헤더 검증 ◀── (--enrich) OpenAPI ◀─▶ data/cache (캐시)    │
│                           ▼                                                              │
│  [B. 전처리] 정규화 → 파생 피처 → 보강 병합 → 검증 ─▶ data/processed/{source_id}.jsonl   │
│                           ▼                                                              │
│  [② 레코드 해시] DB와 비교 → 추가 / 수정 / 그대로 / 재활성 / 제외(소프트 삭제)           │
│                           ▼                  └─ 대량 제외 가드: 20% 초과면 중단          │
│  [C. 청킹] ─▶ [D. 임베딩 + Kiwi 토큰] ─▶ [③ 청크 해시] 바뀐 청크만 임베딩·upsert         │
│                           ▼                                                              │
│  PostgreSQL: welfare_services ◀─FK─ welfare_chunks,  ingest_runs (실행 이력)             │
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌──────────── 온라인 (POST /api/v1/chat) ─────────────────────────────────────────────────┐
│  질문 ─▶ [가드] ─▶ [E. 검색: 이름 pin + dense Top30 + keyword Top30 → RRF → 서비스 집계]│
│                         │ 결과 없음 → 고정 안내문 (LLM 호출 안 함)                       │
│                         ▼                                                               │
│               [F. 컨텍스트 구성 (6,000자 예산)] ─▶ Ollama /api/chat (stream)             │
│  SSE: sources(DB 카드) → token × N → done                                               │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 디렉터리 구조 (welfare_helper 기준)

### 2.1 현재 트리와 목표 트리
2026-09-19 저장소 기준입니다. 각 파일의 상태를 아래 표시로 구분합니다.

| 표시 | 의미 |
|---|---|
| `[완료]` | 구현되었거나 배치가 끝났습니다 |
| `[일부]` | 동작하는 최소 코드만 있습니다 |
| `[뼈대]` | 파일은 있지만 docstring(명세)만 있습니다. docstring에 담당 역할, 설계 절, 구현 Step이 적혀 있습니다 |
| `[예정]` | 아직 파일이 없습니다. 적힌 Step에서 새로 만듭니다 |
| `[로컬]` | gitignore 대상이라 각자의 PC에만 있습니다. 커밋하지 않습니다 |

```
welfare_helper/
├── .env                          # [로컬] 개발용. localhost:5433 / localhost:11435
├── .env.prod                     # [로컬] 배포용. postgres·ollama 서비스명 주소
├── .env.example                  # [완료] .env 템플릿. §3.1 키 전부 포함
├── .env.prod.example             # [완료] .env.prod 템플릿. .env.example과 주소 3개만 다름
├── .gitignore                    # [완료] .env, .env.prod, CLAUDE.md, .venv/, data/cache/*, data/processed/*, 확장 빌드·키 파일 등 (§3.1, §3.5)
├── .gitattributes                # [완료] 기본 LF. data/raw/**, tests/fixtures/**는 -text로 원본 바이트 보존
├── .dockerignore                 # [일부] 배포 이미지에서 .git, .env*, .venv, data, docs 제외. extension/ 제외는 아직 없음 (§3.5)
├── CLAUDE.md                     # [로컬] 프로젝트 지침 (스택, 개발·배포 방식)
├── README.md                     # [완료] 개발·배포 실행 방법
├── docker-compose.yml            # [완료] 개발용 인프라: postgres(5433), ollama(11435) (§3.2)
├── docker-compose.prod.yml       # [완료] 배포용: backend, postgres, ollama. 프론트엔드는 크롬 확장이라 서비스를 두지 않음 (§3.2, §3.5)
├── requirements.txt              # [완료] §3.3. Step 15에서 python-multipart 추가
├── welfare_helper.code-workspace # [완료] Pylance extraPaths, pytest cwd = BackEnd
├── .venv/                        # [로컬] 호스트 Python 3.12 가상환경
├── dockerfiles/
│   ├── Dockerfile.back           # [완료] 배포 전용. python:3.12-slim-bookworm, WORKDIR /app/BackEnd
│   └── Dockerfile.ollama         # [완료] ollama/ollama:latest + entrypoint(script.sh)
├── docker_script/
│   ├── init-vector.sql           # [완료] 빈 볼륨으로 처음 뜰 때 CREATE EXTENSION vector (§3.2 #5)
│   └── script.sh                 # [완료] ollama serve 후 OLLAMA_PULL_MODELS 자동 pull (§3.2 #6)
├── docs/
│   ├── welfare-rag-pipeline-design.md   # ← 이 문서 (기준본)
│   ├── welfare-rag-features.md          # 피처 선별 근거
│   └── welfare-rag-chatbot-plan.md      # 이전 전체 계획 (참고용. 충돌하면 이 문서가 우선)
├── data/                         # 배포 시 backend 컨테이너의 /app/data로 마운트 (이미지에는 넣지 않음)
│   ├── sources.toml                           # [완료] 데이터 소스 등록부. bokjiro_central 1개와 mapped_csv 예시(주석)
│   ├── raw/                                   # 원본. 수정 금지, 새 파일을 추가하는 방식으로만 갱신 (커밋)
│   │   └── bokjiro_central/                   # 폴더명 = source_id
│   │       ├── 20250722.csv                   # [완료] 스냅샷. 파일명 = 기준일(YYYYMMDD). CP949 원본 그대로
│   │       └── _overrides.csv                 # [예정] (필요 시) 수동 보정, Step 14. '_'로 시작하는 파일은 스냅샷이 아님
│   ├── cache/                                 # [로컬] .gitkeep만 커밋
│   │   └── detail/WLF*.xml                    # [예정] OpenAPI 원본 응답, Step 4
│   └── processed/                             # [로컬] .gitkeep만 커밋
│       ├── bokjiro_central.jsonl              # [예정] 소스별 전처리 결과, Step 3
│       └── reports/bokjiro_central/20250722.json   # [예정] 입력 파일별 품질 리포트, Step 3
├── extension/                    # [예정] React + Vite 크롬 확장 (MV3 사이드패널). 백엔드와 별도로 빌드·배포 (§3.5, §10)
│   ├── .env.example              # [예정] VITE_API_BASE_URL 등 공개 값만 (커밋)
│   ├── .env*                     # [로컬] 개발·배포용 백엔드 주소
│   ├── dist/                     # [로컬] 빌드 결과. 개발 중에는 이 폴더를 크롬에 로드하고, 배포 때는 zip으로 묶어 업로드
│   └── node_modules/             # [로컬]
└── BackEnd/                      # ★ import 루트 (개발: 호스트 cwd, 배포: 컨테이너 WORKDIR = /app/BackEnd)
    ├── main.py                   # [일부] /health가 {"status":"ok"}만 반환. Step 1에서 db 상태, Step 9~12에서 라우터와 CORS
    ├── pytest.ini                # [완료] pythonpath = . , testpaths = tests, markers(ollama, db)
    ├── core/
    │   ├── config.py             # [뼈대] pydantic-settings (.env 로드), Step 1
    │   └── db.py                 # [뼈대] 지연 생성 ThreadedConnectionPool + register_vector + get_lock_conn, Step 1
    ├── db/schema.sql             # [뼈대] 주석만 있음. §7.1, Step 1
    ├── scripts/init_db.py        # [뼈대] Step 1
    ├── schemas/rag.py            # [예정] 요청/응답 Pydantic, Step 9
    ├── routers/                  # [예정]
    │   ├── search.py             # POST /api/v1/search, Step 9
    │   ├── chat.py               # POST /api/v1/chat (SSE), Step 12
    │   ├── services.py           # GET  /api/v1/services/{service_id}, Step 12
    │   └── admin.py              # (필요 시) 동기화 트리거·실행 이력·CSV 업로드, Step 15
    ├── services/
    │   ├── embedder.py           # [뼈대] ★ 인덱싱과 질의가 공용으로 사용 (동기 httpx), Step 6
    │   ├── tokenizer.py          # [뼈대] ★ Kiwi 키워드 토큰 (공용), Step 6
    │   ├── retriever.py          # [예정] Step 9
    │   ├── prompt_builder.py     # [예정] Step 11
    │   ├── llm.py                # [예정] 비동기 스트리밍 (httpx.AsyncClient), Step 11
    │   └── rag.py                # [예정] 오케스트레이션: 가드 → 검색 → 프롬프트 → 스트림, Step 12
    ├── ingest/
    │   ├── text_clean.py         # [뼈대] 한 줄 정규화 (§5.3, Step 2), 보강 여러 줄 정제 (§5.7, Step 4)
    │   ├── records.py            # [뼈대] ServiceRecord, record_hash, PIPELINE_VERSION (§5.9), Step 2
    │   ├── sources.py            # [뼈대] sources.toml 로드, 입력 파일 선택, 지문 계산 (§4.1), Step 2
    │   ├── parsers.py            # [뼈대] 서비스명·사이트·대표문의 파서 (§5.5, §5.6), Step 3
    │   ├── adapters/
    │   │   ├── base.py           # [뼈대] SourceAdapter 프로토콜, 어댑터 등록표 (§4.2), Step 2
    │   │   ├── bokjiro_csv.py    # [뼈대] 복지로 중앙부처 CSV 어댑터 (§4.2, §5), Step 3
    │   │   └── mapped_csv.py     # [예정] (필요 시) 컬럼 매핑형 범용 CSV 어댑터, Step 14
    │   ├── enrich.py             # [뼈대] OpenAPI 수집·캐시·파싱 (§4.3, §5.7), Step 4
    │   ├── preprocess.py         # [뼈대] 소스 1개 전처리 → processed jsonl + 리포트 (§5), Step 3
    │   ├── chunker.py            # [뼈대] 청킹 (§6), Step 5
    │   ├── index.py              # [뼈대] 레코드 diff → upsert·소프트 삭제 → 청크 임베딩 (§7.5), Step 7
    │   └── sync.py               # [뼈대] ★ 동기화 CLI: 잠금·지문·실행 이력 (§7.6), Step 8
    ├── eval/                     # [예정] Step 10
    │   ├── golden.jsonl
    │   └── run_retrieval.py
    └── tests/                    # 테스트 파일은 아직 없음 (pytest -q → "no tests ran")
        └── fixtures/
            ├── bokjiro_central_20250722.csv   # [완료] 고정 fixture. data/raw 파일과 sha256이 같음. raw가 바뀌어도 테스트는 불변
            ├── detail_WLF00003249.xml         # [예정] Step 4
            └── sync/                          # [예정] 동기화 시나리오용 소형 CSV, Step 8
```

### 2.2 import 규칙
- `Dockerfile.back`이 `WORKDIR /app/BackEnd`에서 `uvicorn main:app`을 실행하므로, **`BackEnd/`가 import 루트**입니다. 예: `from services.retriever import search`, `from core.config import settings`
- 개발은 호스트에서 항상 `BackEnd/`에서 실행합니다: `cd BackEnd && uvicorn main:app --reload`, `cd BackEnd && pytest -q`
- 데이터 경로는 `../data/...`로 씁니다. 로컬에서는 `BackEnd/../data`, 컨테이너에서는 `/app/BackEnd/../data = /app/data`가 되어 **둘 다 같은 설정값으로 동작**합니다.
- 기존 패키지(`core`, `ingest`, `ingest/adapters`, `scripts`, `services`)에는 빈 `__init__.py`가 있습니다. 새로 만드는 `schemas/`, `routers/`, `eval/`에도 같은 방식으로 둡니다.
- **뼈대 파일은 새로 만들지 않고 채웁니다.** docstring이 그 파일의 명세이므로, 구현한 뒤에도 docstring은 남기고 내용만 실제 동작에 맞게 고칩니다.

### 2.3 구현 현황 (2026-09-19 확인)

| Step | 범위 | 상태 | 비고 |
|---|---|---|---|
| 0 | 사전 준비 | 거의 완료 | LLM 최종 확정, `.dockerignore` 보완, Node.js 설치가 남았습니다 (§12) |
| 1 | 설정, DB 연결, 스키마 | 뼈대 | DB에 `vector` 확장만 있고 테이블은 0개입니다 |
| 2~8 | 공통 기반 → 전처리 → 보강 → 청킹 → 임베딩 → 인덱서 → 동기화 | 뼈대 | 모든 모듈 파일이 docstring 명세 상태입니다 |
| 9~15 | 검색, 평가, LLM, `/chat`, 튜닝, 추가 소스, 관리자 API | 미착수 | 파일이 없습니다 |
| - | 프론트엔드 (React 크롬 확장) | 미착수 | 형태 결정 완료. 개발·배포는 §3.5, API 호출 방식은 §10 |

**실행 환경 확인 결과**
| 항목 | 상태 |
|---|---|
| 개발 컨테이너 | `postgres` (`pgvector/pgvector:pg16`, healthy, `5433`), `ollama` (compose 빌드 이미지, `11435`) 기동 중 |
| Ollama 모델 | `bge-m3:latest` (1.2 GB), `gemma3:4b` (3.3 GB). 자동 pull로 받아졌습니다 |
| PostgreSQL | `vector 0.8.3` 설치됨. 테이블 없음 (`scripts.init_db` 미구현) |
| 호스트 `.venv` | Python 3.12.10. fastapi 0.141.1, uvicorn 0.53.0, psycopg2-binary 2.9.13, pgvector 0.5.0, pydantic-settings 2.15.0, httpx 0.28.1, pandas 2.3.3, numpy 2.5.3, kiwipiepy 0.23.2, pytest 9.1.1 |
| 원본 데이터 | `data/raw/bokjiro_central/20250722.csv`와 fixture의 sha256이 같습니다 (`0677e1be…`, §5.8 값과 일치) |
| 테스트 | 0개 |

**프론트엔드 (결정: React 크롬 확장)**
- 프론트엔드는 **Manifest V3 크롬 확장**으로 만듭니다. React + Vite를 쓰고, 채팅 UI는 사이드패널에 둡니다. 폴더는 `extension/`입니다. 이전 계획([welfare-rag-chatbot-plan.md](welfare-rag-chatbot-plan.md) 프롬프트 9~11)과 같은 방향이고, CLAUDE.md의 작업 주제도 이에 맞게 바뀌었습니다.
- 크롬 확장은 서버에서 서빙하지 않습니다. 빌드한 결과물을 크롬에 로드하거나 웹스토어에 올립니다. 그래서 **Docker 배포 대상은 backend, postgres, ollama뿐이고** compose에는 frontend 서비스를 두지 않습니다 (§3.2 #9).
- 이 설계서는 백엔드 RAG 파이프라인이 중심입니다. 확장의 개발 환경과 웹스토어 배포는 §3.5, 확장이 백엔드를 호출하는 방식은 §10에 적습니다. 확장 UI 구현 단계는 아직 §12에 없습니다. `/chat`(Step 12)이 완성된 뒤 추가합니다.

---

## 3. 환경 설정

### 3.1 `.env.example` / `.env.prod.example`
두 파일의 키는 같고, **주소 3개만 다릅니다**. 개발은 `.env`, 배포는 `.env.prod`를 씁니다.

| 키 | `.env` (개발, 호스트 실행) | `.env.prod` (배포, 컨테이너 실행) |
|---|---|---|
| `DB_HOST` | `localhost` | `postgres` |
| `DB_PORT` | `5433` | `5432` |
| `OLLAMA_BASE_URL` | `http://localhost:11435` | `http://ollama:11434` |

아래 키는 `.env.example`과 `.env.prod.example`에 **모두 들어 있습니다**. 오른쪽 주석은 이 문서의 설명이며 템플릿 파일에는 없습니다.
```ini
# PostgreSQL
DB_HOST=localhost                     # .env.prod: postgres
DB_PORT=5433                          # .env.prod: 5432
DB_USER=welfare
DB_PASSWORD=change_me                 # .env.prod는 개발과 다른 값
DB_NAME=welfare_helper
# Ollama
OLLAMA_BASE_URL=http://localhost:11435   # .env.prod: http://ollama:11434
OLLAMA_LLM=gemma3:4b                  # 아래 "모델 상태" 참고
OLLAMA_EMBED=bge-m3                   # ✅ 설계와 일치 (1024차원)
DATA_GO_KR_SERVICE_KEY=               # "Decoding" 키. Encoding 키는 httpx가 다시 인코딩해 이중 인코딩 오류가 남
# --- 모델 ---
EMBED_DIM=1024
LLM_NUM_CTX=8192
LLM_TEMPERATURE=0.2
# --- 데이터 경로 (BackEnd/ 기준 상대경로. raw, cache, processed는 DATA_DIR 아래로 고정) ---
DATA_DIR=../data
SOURCES_FILE=../data/sources.toml
# --- 동기화 ---
MAX_DEACTIVATE_RATIO=0.2              # 한 번에 이 비율을 넘게 제외되면 중단 (--allow-mass-delete로 무시)
ADMIN_TOKEN=                          # Step 15 관리자 API를 쓸 때만. 긴 난수 문자열
# --- 검색·응답 파라미터 ---
RETRIEVE_K_DENSE=30
RETRIEVE_K_SPARSE=30
RETRIEVE_TOP_N=5
MIN_DENSE_SIM=0.45
CONTEXT_CHAR_BUDGET=6000
CORS_ORIGINS=                         # 크롬 확장 origin. chrome-extension://<확장 ID> (§3.5, §10)
```
- `DB_HOST`와 `DB_PORT`는 env 파일에서 관리합니다. compose는 주소를 주입하지 않습니다. `core/config.py`의 기본값은 개발 기준 `localhost`와 `5433`입니다.
- `core/config.py`(Step 1, 현재 뼈대)는 저장소 루트의 `.env`만 읽습니다. 경로는 cwd가 아니라 `Path(__file__)` 기준으로 계산합니다. 배포 컨테이너에는 `.env` 파일이 없고(`.dockerignore`), `docker-compose.prod.yml`의 `env_file: .env.prod`가 환경변수로 주입합니다. pydantic-settings는 환경변수를 env 파일보다 우선하므로 따로 분기할 필요가 없습니다.
- ⚠️ 값 뒤에 주석을 붙이지 않습니다. python-dotenv는 `=` 바로 뒤의 공백을 건너뛰므로, `KEY= #설명`처럼 쓰면 빈 값이 아니라 `#설명`이라는 문자열로 읽힙니다. 위 블록의 오른쪽 주석은 설명용이며 실제 파일에는 넣지 않습니다.
- 백엔드용 `.gitignore` 규칙은 `.env`와 `.env.prod` 두 이름입니다(`.env.example`, `.env.prod.example`은 커밋). 확장 쪽은 `extension/.env*`를 제외하고 `extension/.env.example`만 커밋합니다 (§3.5). `.env.local` 같은 다른 이름의 env 파일을 만들면 커밋될 수 있으니, 새 이름을 쓸 때는 `.gitignore`에 먼저 추가합니다.
- 개발 포트는 `docker-compose.yml`에 고정되어 있습니다: postgres `5433:5432`, ollama `11435:11434`. 호스트에서 실행하는 백엔드는 `8000`을 씁니다. 기본 포트(5432, 11434)를 피한 이유는 Windows에 네이티브 PostgreSQL·Ollama가 설치되어 있으면 `localhost`가 그쪽으로 붙기 때문입니다 (실제로 네이티브 PostgreSQL 18이 비밀번호 인증을 거부하고, `127.0.0.1:11434`는 네이티브 Ollama가 응답한 사례가 있음). 포트를 바꾸면 compose와 `.env`의 `DB_PORT`·`OLLAMA_BASE_URL`을 함께 고칩니다.
- ⚠️ `.env`에는 `config.py`가 아는 키만 둡니다. pydantic-settings는 기본적으로 모르는 키가 있으면 오류를 내므로, compose 전용 변수를 `.env`에 추가하지 않습니다.
- 배포(`docker-compose.prod.yml`)는 backend `8000:8000`만 외부에 엽니다. postgres와 ollama는 compose 내부 네트워크에서만 접근합니다.

> **모델 상태**
> - **임베딩**: `bge-m3`로 확정되었습니다. `EMBED_DIM=1024`와 스키마의 `VECTOR(1024)`가 그대로 맞습니다. ollama 컨테이너에 `bge-m3:latest`로 받아져 있습니다.
> - **LLM**: `gemma3:4b`로 `.env.example`과 CLAUDE.md가 일치하고, 컨테이너에도 받아져 있습니다. 바꾸더라도 `OLLAMA_LLM` 값만 고치면 되고 코드와 스키마는 바뀌지 않습니다. LLM은 Step 11부터 씁니다.

### 3.2 compose 현황
개발과 배포를 파일로 나눕니다.

| 파일 | 서비스 | env | 용도 |
|---|---|---|---|
| `docker-compose.yml` | postgres, ollama | `.env` (자동 로드) | 개발. 인프라만 띄우고 백엔드는 호스트에서 실행 |
| `docker-compose.prod.yml` | backend, postgres, ollama | `.env.prod` (`--env-file`로 지정) | 배포. 프로젝트명 `welfare_helper_prod`로 컨테이너·볼륨이 개발과 분리됨 |

- 배포 명령은 반드시 `--env-file .env.prod`를 붙입니다. 빠뜨리면 compose가 `${DB_USER}` 등을 `.env`에서 읽어, postgres 계정과 backend(`.env.prod`)의 접속 정보가 어긋납니다. `.env`도 없는 서버에서는 `${DB_USER:?}`가 기동을 막습니다.
- 배포 backend는 소스를 이미지에 굽고(`COPY BackEnd/`) `--reload` 없이 실행합니다. 코드를 바꾸면 `up -d --build`로 다시 빌드합니다.

| # | 항목 | 상태 | 이유 |
|---|---|---|---|
| 1 | postgres 이미지를 `pgvector/pgvector:pg16`으로 | ✅ 반영됨 | 기본 postgres 이미지에는 vector 확장이 없습니다. 현재 컨테이너의 확장은 `vector 0.8.3`이라 `hnsw.iterative_scan`도 쓸 수 있습니다 |
| 2 | Dockerfile 경로를 `dockerfiles/`(소문자)로 | ✅ 반영됨 | Linux나 CI에서 빌드 실패를 막습니다 |
| 3 | 배포 backend `volumes`에 `- ./data:/app/data` | ✅ 반영됨 | 컨테이너가 `data/raw`의 CSV와 `sources.toml`을 읽고, 캐시와 전처리 결과를 호스트에 남기려면 필요합니다. 개발에서는 호스트가 `data/`를 직접 읽습니다 |
| 4 | `OLLAMA_BASE_URL`·`DB_HOST` 주소 분리 | ✅ 반영됨 | `.env`는 `localhost`, `.env.prod`는 서비스명(`postgres`, `ollama`)을 씁니다 (§3.1) |
| 5 | postgres 초기화 스크립트 `docker_script/init-vector.sql` 마운트 | ✅ 반영됨 | 빈 볼륨으로 처음 뜰 때 `CREATE EXTENSION vector`를 실행합니다 |
| 6 | ollama 모델 **자동 pull** (`Dockerfile.ollama` + `docker_script/script.sh`) | ✅ 반영됨 | 기동할 때 `OLLAMA_PULL_MODELS`의 모델을 확인해 없으면 받습니다 (아래). 배포 compose는 `${OLLAMA_EMBED:?} ${OLLAMA_LLM:?}`라 값이 비면 기동을 막고, 개발 compose는 가드 없이 `${OLLAMA_EMBED} ${OLLAMA_LLM}`를 씁니다 |
| 7 | ollama `healthcheck` + backend의 `condition: service_healthy` | ⬜ 선택 | 지금은 `service_started`라, 새 볼륨에서 첫 기동 때 모델을 받는 도중에도 backend가 먼저 뜹니다. Step 6~8의 임베딩 호출이 그 사이에 실패할 수 있습니다 |
| 8 | ollama GPU 설정 (NVIDIA GPU가 있을 때) | ⬜ 선택 | CPU만으로는 LLM 응답이 수십 초 걸릴 수 있습니다. 임베딩은 CPU로도 32건 약 4.6초(367청크 약 1분)라 Step 1~8에는 지장이 없습니다 |
| 9 | 배포 compose에 frontend 서비스 | ✖ 두지 않음 | 프론트엔드가 크롬 확장이라 서빙할 컨테이너가 없습니다. 빌드한 zip을 웹스토어에 올립니다 (§3.5) |
| 10 | postgres `healthcheck` (`pg_isready`, 5초 간격, 10회) | ✅ 반영됨 | 개발·배포 compose 모두에 있습니다. 배포 backend는 `condition: service_healthy`로 DB가 준비된 뒤 뜹니다 |
| 11 | 배포 서비스 `restart: unless-stopped` | ✅ 반영됨 | 서버 재부팅이나 프로세스 종료 후 자동으로 다시 뜹니다. 개발 compose에는 없습니다 |
| 12 | **HTTPS 리버스 프록시**(Caddy 등)와 공개 도메인 | ⬜ 웹스토어 공개 전 필수 | 웹스토어에서 설치한 확장은 사용자 PC에서 인터넷을 거쳐 백엔드를 호출합니다. 지금처럼 backend `8000`을 HTTP로 열면 사용자가 입력한 장애·소득·가구 정보가 평문으로 오갑니다. 프록시가 443을 받아 backend로 넘기고, backend의 `ports`는 외부에 열지 않습니다. 개발(localhost)에는 필요 없습니다 |

> #5는 **빈 볼륨으로 처음 뜰 때만** 실행됩니다. 이미 만들어진 볼륨에는 적용되지 않지만, §7.1의 `schema.sql`이 `CREATE EXTENSION IF NOT EXISTS vector`로 시작하므로 `scripts.init_db`가 같은 일을 대신합니다.

**모델 자동 pull**: compose가 `.env`의 두 값을 이어 붙여 ollama 컨테이너에 넘기고, entrypoint가 그 값을 읽습니다.
```yaml
  ollama:
    build:
      context: .
      dockerfile: dockerfiles/Dockerfile.ollama
    environment:
      OLLAMA_HOST: 0.0.0.0
      OLLAMA_PULL_MODELS: "${OLLAMA_EMBED} ${OLLAMA_LLM}"   # 예: "bge-m3 gemma3:4b"
```
`script.sh`는 `ollama serve`를 띄우고 서버가 응답할 때까지 기다린 뒤, 목록의 모델마다 `ollama show`로 존재를 확인해 **없을 때만** pull합니다. 그래서 새 PC에서는 `docker compose up -d --build` 한 번으로 두 모델이 받아지고, 이미 있으면 `Model already exists`만 찍고 넘어갑니다. 받은 모델은 `ollama_data` 볼륨(`/root/.ollama`)에 남아서 `docker compose down`으로는 지워지지 않고, `down -v`를 하면 함께 사라집니다.

- **모델을 바꿀 때**: `.env`의 `OLLAMA_EMBED`·`OLLAMA_LLM`을 고치고 **`docker compose up -d`로 컨테이너를 재생성**합니다. 환경변수는 컨테이너 생성 시점에 고정되므로 `restart`만으로는 반영되지 않습니다. 임베딩 모델을 바꾼다면 §7.7의 `--rebuild` 절차도 함께 따릅니다.
- **수동으로 받기** (`.env`를 건드리지 않고 임시로 시험할 때): `docker compose exec ollama ollama pull <모델명>`, 확인은 `docker compose exec ollama ollama list`. `.env`에 없는 모델은 컨테이너를 재생성하면 자동으로 복구되지 않습니다.
- ⚠️ `script.sh`는 pull 실패를 `Pull failed, continuing without it`으로 넘깁니다. 모델명 오타는 개발·배포 모두 이 경로로 조용히 넘어가므로, 모델명을 바꾼 뒤에는 `ollama list`로 확인하세요. 값이 **비어 있는** 경우는 배포 compose만 `:?`로 막고, 개발 compose는 그대로 기동합니다.
- `Dockerfile.ollama`는 `ollama/ollama:latest`를 씁니다. 다시 빌드할 때마다 Ollama 버전이 바뀔 수 있으므로, 배포 환경을 고정하고 싶으면 태그를 버전으로 바꿉니다.

**GPU 설정** (NVIDIA GPU + Docker Desktop(WSL2)일 때만)
```yaml
  ollama:
    # ...기존 설정...
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

### 3.3 `requirements.txt` (반영 완료)
```
fastapi
uvicorn[standard]
psycopg2-binary>=2.9
httpx
pydantic-settings
pgvector>=0.3
pandas>=2.2,<3
numpy>=1.26,<3
kiwipiepy>=0.17   # 한국어 형태소 분석 (키워드 검색)
pytest>=8
```
- 이 설계에 필요한 패키지가 모두 들어 있습니다. 중복되어 있던 `psycopg2-binary`는 한 줄로 합쳤고, 쓰지 않는 `sqlalchemy`는 뺐습니다. §7.2와 §8.2는 psycopg2를 직접 씁니다.
- `tomllib`(§4.1)은 Python 3.11 이상의 표준 라이브러리라 추가하지 않습니다. `python-dotenv`는 pydantic-settings가 함께 설치합니다.
- 앞으로 추가할 것: Step 15(관리자 API의 파일 업로드)에서 `python-multipart`.
- 파일이 하나라서 `pytest`도 배포 이미지에 설치됩니다. 이미지 크기를 줄이고 싶으면 나중에 `requirements-dev.txt`로 분리합니다.

### 3.4 실행 위치
**개발은 하이브리드입니다.** 인프라(postgres, ollama)만 `docker-compose.yml`로 띄우고, 전처리·인덱싱·테스트·서버는 호스트의 Python 3.12 가상환경에서 `BackEnd/`를 cwd로 실행합니다. Python 버전은 `Dockerfile.back`과 같은 3.12로 맞춥니다. 팀원마다 로컬 Python 버전(예: Anaconda 3.13)이 다르면 휠 차이로 개발과 배포의 동작이 달라질 수 있습니다.
호스트에서 접속할 주소는 backend `http://localhost:8000`, postgres `localhost:5433`, ollama `http://localhost:11435`입니다.
```bash
cp .env.example .env                          # 처음 한 번. 값 채우기
docker compose up -d                          # postgres, ollama (첫 기동 때 ollama 이미지 빌드와 모델 pull)
py -3.12 -m venv .venv && .venv\Scripts\activate   # macOS/Linux: python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd BackEnd
python -m scripts.init_db          # Step 1 이후
python -m ingest.sync --dry-run    # Step 8 이후. 무엇이 바뀌는지 먼저 확인
python -m ingest.sync --enrich     # Step 8 이후. 반영
pytest -q
uvicorn main:app --reload
```
현재(§2.3)는 `uvicorn main:app --reload`(`/health`만 응답)와 `pytest -q`(테스트 0개라 "no tests ran")만 실행됩니다. 나머지 명령은 주석에 적힌 Step을 구현한 뒤에 쓸 수 있습니다.
**배포**는 `docker-compose.prod.yml`로 backend까지 컨테이너로 올립니다.
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend python -m scripts.init_db
docker compose -f docker-compose.prod.yml --env-file .env.prod exec backend python -m ingest.sync --enrich
```

### 3.5 프론트엔드: 크롬 확장 개발과 배포
크롬 확장은 Docker와 관계없이 호스트에서 빌드하고, 결과물(`extension/dist/`)을 크롬에 로드하거나 웹스토어에 올립니다. 백엔드 쪽 인프라(compose, Dockerfile, 포트, `.env` 키)는 바꾸지 않습니다.

**개발 환경**
| 항목 | 내용 |
|---|---|
| Node.js | 호스트에 LTS 버전을 설치하고, 팀원끼리 버전이 같도록 `extension/.nvmrc`로 고정합니다 |
| 환경변수 | `extension/.env`에 `VITE_API_BASE_URL`을 둡니다. 개발은 `http://localhost:8000`, 배포 빌드는 `https://<공개 도메인>`입니다. 템플릿은 `extension/.env.example`로 커밋합니다 |
| ⚠️ 비밀값 금지 | 확장에 넣은 값은 빌드 결과에 그대로 들어가서 **누구나 볼 수 있습니다.** 백엔드 주소 같은 공개 값만 넣고, `ADMIN_TOKEN`이나 API 키는 절대 넣지 않습니다 |
| 개발 중 로드 | `chrome://extensions` → 개발자 모드 켜기 → "압축해제된 확장 프로그램을 로드합니다" → `extension/dist` 선택 |
| `.gitignore` | ✅ 반영됨: `node_modules/`, `extension/dist/`, `extension/.env*`(`.env.example` 제외), `*.zip`, `*.pem` |
| `.dockerignore` | ⬜ **`extension/` 추가 필요.** backend 이미지의 빌드 컨텍스트가 저장소 루트라서, 제외하지 않으면 `node_modules`(수백 MB)가 빌드할 때마다 Docker로 전송됩니다 |

**확장 ID 고정과 CORS**
확장 ID는 백엔드의 `CORS_ORIGINS`(`chrome-extension://<ID>`)에 들어갑니다. 압축해제로 로드한 확장의 ID는 폴더 경로에 따라 달라지므로, 웹스토어 ID에 맞춰 고정합니다.
1. 첫 zip을 개발자 대시보드에 업로드해 초안으로 저장합니다. 이때 항목 ID가 발급됩니다.
2. **Package** 탭 → **View public key**에서 `BEGIN/END PUBLIC KEY` 사이의 문자열을 복사하고, 줄바꿈을 지워 한 줄로 만든 뒤 개발용 manifest의 `"key"`에 넣습니다. 이제 로컬에서 로드한 확장의 ID가 웹스토어 ID와 같아집니다.
3. `.env`와 `.env.prod`의 `CORS_ORIGINS`를 그 ID 하나로 채웁니다. 개발과 배포가 같은 값을 씁니다.
4. ⚠️ **첫 업로드 zip의 manifest에 `key`가 있으면 거부됩니다** ("key field is not allowed in manifest"). 배포 빌드에서는 `key`를 빼는 단계를 둡니다.

**웹스토어 배포 절차**
1. **개발자 계정 등록**: 크롬 웹스토어 개발자 대시보드에서 계정을 만들고 1회 등록비를 냅니다. 중요한 알림이 오는 개발자 이메일을 정합니다.
2. **배포 빌드**
   - `VITE_API_BASE_URL`을 공개 HTTPS 주소로 합니다. 웹스토어 버전은 사용자 PC에 백엔드가 없으므로 localhost를 쓸 수 없습니다. 먼저 §3.2 #12가 끝나 있어야 합니다.
   - manifest의 `host_permissions`에는 배포 백엔드 주소만 둡니다. `http://localhost:8000/*`는 개발 빌드에만 넣습니다.
   - manifest `version`을 올리고, 첫 업로드라면 `key`를 뺍니다.
3. **패키징**: `dist/`의 **내용물**을 zip으로 묶습니다. `manifest.json`이 zip의 최상위에 있어야 합니다.
4. **업로드**: 대시보드에서 **Add new item**을 누르고 zip을 올립니다.
5. **Store listing 탭**: 설명과 이미지를 채웁니다.
   - 아이콘 128×128 PNG
   - 스크린샷 1장 이상 (1280×800 또는 640×400)
   - 작은 프로모션 타일 440×280
6. **Privacy 탭**
   - 단일 목적: "복지서비스 검색·상담"
   - 권한별 사유: `sidePanel`, `host_permissions`
   - 원격 코드 실행 여부: 실행 안 함
   - 데이터 사용 공개: 사용자가 입력한 질문을 서버로 보냄
   - **개인정보처리방침 URL**: 질문에 건강·장애·소득 정보가 담길 수 있으므로 필요합니다. 수집 항목, 서버 저장 여부, 보관 기간을 적습니다.
7. **Distribution 탭**: 공개 범위를 정합니다.

   | 공개 범위 | 누가 설치하나 | 추천 용도 |
   |---|---|---|
   | Private | 지정한 테스터(Google 계정 이메일)나 Google 그룹만 | 팀 내부 테스트 |
   | **Unlisted** | 링크를 아는 사람 누구나. 검색에는 안 뜸 | **캡스톤 시연과 심사위원 배포** |
   | Public | 누구나. 웹스토어 검색에 노출 | 실제 공개 |
8. **심사 제출**
   - 심사 기간은 항목의 성격에 따라 다릅니다. 권한이 적을수록 유리하므로 `host_permissions`를 백엔드 도메인 하나로 한정합니다.
   - 제출할 때 "심사 후 바로 게시" 체크를 끄면, 통과한 뒤 30일 안에 원하는 시점에 게시할 수 있습니다. 시연 일정에 맞출 때 씁니다.
9. **업데이트**: manifest `version`을 올린 zip을 다시 올리면 다시 심사를 받습니다.

> Windows와 macOS의 크롬은 웹스토어 밖에서 받은 확장(.crx) 설치를 막습니다. 배포 방법은 **웹스토어** 또는 **개발자 모드에서 압축해제 로드**(개발·시연용) 둘 중 하나입니다.

---

## 4. 단계 A: 수집

### 4.1 데이터 소스 등록부 (`data/sources.toml`, `ingest/sources.py`)
CSV가 계속 추가되고 바뀌므로, "어떤 파일을 읽을지"를 코드나 `.env`에 박아 두지 않고 **등록부에 선언**합니다. TOML은 Python 3.11부터 표준 라이브러리(`tomllib`)로 읽을 수 있어서 추가 패키지가 필요 없습니다.

```toml
[[sources]]
id = "bokjiro_central"          # 폴더명(data/raw/<id>/)이자 DB의 source_id. 한 번 정하면 바꾸지 않음
name = "한국사회보장정보원 중앙부처 복지서비스"
adapter = "bokjiro_csv"         # ingest/adapters/의 어댑터 이름
encoding = "cp949"              # "auto"면 utf-8-sig → cp949 순으로 시도
mode = "snapshot"               # snapshot | delta (아래 표)
enrich = "bokjiro_openapi"      # 보강기 이름. 없으면 ""
id_prefix = ""                  # 복지로는 WLF 그대로. 다른 소스는 반드시 고유 접두사 (예: "SEOUL-")
exclude_ids = []                # 검색에서 영구 제외할 서비스 ID
```

**파일 규칙**
- 입력 파일은 `data/raw/{source_id}/*.csv`입니다. **파일명 오름차순의 마지막 파일이 최신**이므로 파일명은 기준일 `YYYYMMDD.csv`를 권장합니다.
- `_`로 시작하는 파일(`_overrides.csv` 등)은 입력 파일이 아닙니다.
- 원본은 수정하지 않습니다. **갱신은 새 파일을 추가하는 방식으로만** 합니다. 이전 파일을 남겨 두면 그대로 이력과 롤백 수단이 됩니다.

**모드**
| mode | 입력 | 의미 | 빠진 서비스 | 쓰는 경우 |
|---|---|---|---|---|
| `snapshot` (기본) | 최신 파일 1개 (`--file`로 지정 가능) | 파일 = 그 소스의 **전체 현재 상태** | **소프트 삭제** (`is_active=false`) | 공공데이터포털처럼 전체 목록을 주기적으로 새로 받는 경우 |
| `delta` | 모든 파일을 파일명 순으로 누적. 같은 ID는 뒤 파일이 이김 | 파일 = **추가·수정분** | 건드리지 않음. 제외는 `exclude_ids`로 | 신규 서비스만 담은 CSV를 수시로 추가하는 경우 |

**지문(fingerprint)**: `sha256(입력 파일명·해시 목록 + exclude_ids + _overrides.csv 해시 + PIPELINE_VERSION + 임베딩 모델 + enrich 여부)`. 해당 소스의 **직전 성공 실행과 지문이 같으면 아무것도 하지 않습니다** (§7.6).

**모듈 인터페이스** (`ingest/sources.py`, Step 2)
| 함수 | 동작 |
|---|---|
| `load_sources() -> list[SourceConfig]` | `tomllib`로 `SOURCES_FILE`을 읽고 검증합니다: id 중복, 등록되지 않은 adapter, 잘못된 mode는 예외 |
| `select_files(source, file=None)` | snapshot은 파일명이 가장 큰 1개(`file`을 주면 그 파일), delta는 전체를 오름차순으로. `_`로 시작하는 파일은 제외 |
| `fingerprint(source, files)` | 위 지문 계산 |
| (인코딩) | `encoding = "auto"`면 `utf-8-sig`를 먼저 시도하고 실패하면 `cp949` |

### 4.2 어댑터 (`ingest/adapters/`)
CSV 형식이 소스마다 다를 수 있으므로, "읽기와 표준 레코드 변환"을 어댑터로 분리합니다. 이후 단계(청킹, 임베딩, 검색)는 `ServiceRecord`만 알면 됩니다.

```python
class SourceAdapter(Protocol):
    def read(self, path: Path, cfg: SourceConfig) -> pd.DataFrame: ...
        # 인코딩·헤더 검증만. 정제하지 않음
    def to_records(self, df: pd.DataFrame, cfg: SourceConfig, report: Report) -> list[ServiceRecord]: ...
        # §5 전처리. 공통 부품(text_clean, parsers)을 재사용

ADAPTERS: dict[str, SourceAdapter] = {"bokjiro_csv": BokjiroCsvAdapter()}   # Step 14에서 "mapped_csv" 추가
```

**형식이 다른 CSV를 추가할 때** (Step 14의 `mapped_csv`): 코드를 짜지 않고 컬럼 매핑만 선언합니다.
```toml
[[sources]]
id = "manual_local"
name = "수기 관리 지역 서비스"
adapter = "mapped_csv"
encoding = "auto"
mode = "delta"                  # 신규·수정분만 담은 파일을 수시로 추가
enrich = ""
id_prefix = "LOC-"
exclude_ids = []
[sources.columns]               # 표준 필드 = CSV 컬럼명 (service_id, name, summary는 필수)
service_id = "ID"
name = "서비스명"
summary = "설명"
url = "링크"
ministry = "담당기관"
contact_raw = "문의처"
updated_at = "수정일"
```

**`bokjiro_csv`의 read 검증**
| 검사 | 규칙 | 실패 시 |
|---|---|---|
| 인코딩 | `pd.read_csv(path, encoding=cfg.encoding, dtype=str, keep_default_na=False)` | 예외. euc-kr 대신 cp949를 쓰는 이유는 확장 한글 때문입니다 |
| 컬럼 | 정확히 이 10개: `서비스아이디, 서비스명, 서비스URL, 서비스요약, 사이트, 대표문의, 소관부처명, 소관조직명, 기준연도, 최종수정일` | 예외. 빠진 컬럼과 남는 컬럼을 메시지에 나열합니다 (포털 형식 변경 신호) |
| 키 | `서비스아이디`가 모두 고유하고 `WLF` + 숫자 8자리 형식 | 예외 |
| 행 수 | 제한 없음. 리포트에 기록만 | 급감은 §7.5의 대량 제외 가드가 막습니다 |

> `dtype=str, keep_default_na=False`: 판다스가 빈 값을 NaN(float)으로 바꾸거나 숫자처럼 보이는 값을 변환하지 못하게 막습니다. 결측 판정은 §5에서 직접 합니다.

**서비스 ID 규칙**: `service_id`는 **모든 소스를 통틀어 고유**해야 합니다. 복지로는 WLF ID를 그대로 쓰고, 다른 소스는 `id_prefix`를 붙입니다. 적용 직전에 "다른 소스가 이미 가진 ID"와 겹치는지 검사해서, 겹치면 해당 실행을 실패시킵니다.

### 4.3 OpenAPI 상세조회 수집 (`ingest/enrich.py`, 선택)
| 항목 | 설계 |
|---|---|
| 엔드포인트 | `GET https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfaredetailedV001` |
| 파라미터 | `serviceKey`, `callTp=D`, `servId={service_id}` (callTp 값은 Swagger로 확인) |
| 캐시 | 원본 XML을 `data/cache/detail/{service_id}.xml`에 **그대로** 저장합니다. `data/cache/`는 `.gitkeep`만 커밋되므로 clone 직후에는 `detail/`이 없습니다. 쓰기 직전에 `path.parent.mkdir(parents=True, exist_ok=True)`로 만듭니다 |
| 재수집 조건 | ① 캐시가 없음 ② CSV의 `최종수정일`이 캐시 파일 수정일보다 늦음 (서비스 내용이 바뀌었다는 신호) ③ `--refresh`. 이 밖에는 캐시를 씁니다 |
| 호출 정책 | 순차 호출, 호출 사이 0.2초 대기, 재시도 3회(지수 백오프). `resultCode`가 정상이 아니면 로그를 남기고 해당 건만 건너뜁니다 |
| 파싱 | `parse_detail(xml: str) -> dict`. 원문 문자열만 추출하고, 정제는 §5.7에서 합니다 |
| **키 보호** | `serviceKey`가 URL 쿼리에 들어가므로 **요청 URL을 로그에 그대로 남기지 않습니다.** 로그에는 `servId`와 상태 코드만 기록하고, 예외를 다시 던지거나 기록할 때는 메시지 안의 키 값을 `***`로 바꿉니다. 키는 `settings`로만 읽고 출력하지 않습니다 |
| 실패 처리 | 보강에 실패해도 해당 서비스는 **CSV 필드만으로 계속 진행합니다** |

**필드 매핑**: `tgtrDtlCn`→`target_detail`, `slctCritCn`→`selection_criteria`, `alwServCn`→`benefit_content`, `applmetList`→`apply_method`, `lifeArray`→`life_stages`, `trgterIndvdlArray`→`households`, `intrsThemaArray`→`interests`, `srvPvsnNm`→`provision_type`, `sprtCycNm`→`support_cycle`, `onapPsbltYn`→`online_apply`

> ⚠️ **첫 작업으로 1건만 실제 호출**해 봅니다 (`WLF00003249` 장애인연금). `servId` 형식과 필드명이 위 표와 같은지 확인한 뒤에 367건 전체를 돌립니다.

---

## 5. 단계 B: 전처리 (`ingest/preprocess.py`)

```
python -m ingest.preprocess --source bokjiro_central [--file 20250722.csv] [--enrich] [--refresh]
  → data/processed/bokjiro_central.jsonl
  → data/processed/reports/bokjiro_central/20250722.json
```
전처리는 **소스 단위**로 동작하고 DB를 쓰지 않습니다. 평소에는 `ingest.sync`가 이 함수를 호출하고, CLI는 새 CSV를 검토하거나 디버깅할 때 씁니다. 이 절의 로직은 `bokjiro_csv` 어댑터의 `to_records()`가 공통 부품(`text_clean.py`, `parsers.py`)을 조합해서 구현합니다.
- 두 출력 경로는 gitignore 대상이고 `reports/{source_id}/`는 소스마다 새로 생기므로, 쓰기 직전에 `path.parent.mkdir(parents=True, exist_ok=True)`로 디렉터리를 만듭니다.
- 구현 순서: Step 3(CSV), Step 4(`--enrich` 통합), Step 14(`_overrides.csv`).

### 5.1 원칙
1. **원본 불변**: `data/raw/`와 `data/cache/`의 파일은 읽기만 합니다. 수동 보정은 `_overrides.csv`로 합니다 (Step 14).
2. **결정적**: 같은 입력이면 항상 같은 출력이 나옵니다. 네트워크는 §4.3의 재수집 조건에 해당할 때만 씁니다.
3. **원문 보존**: 파싱한 값(`sites`, `contacts`)을 만들더라도 원문(`site_raw`, `contact_raw`)은 함께 둡니다. 파서가 틀려도 원문으로 되돌아갈 수 있습니다.
4. **원본 오류는 고치지 않고 리포트합니다**: 전화번호 오기 같은 원본 데이터 오류를 추측으로 수정하지 않습니다.
5. **표시용 텍스트와 검색용 키를 분리합니다**: 사용자에게 보이는 텍스트는 NFC 원문을 유지하고, 검색 키(`name_keys`)만 공격적으로 정규화합니다.

### 5.2 흐름
```
adapter.read(file)                               # §4.2: 인코딩·헤더·키 검증
  → B1. 공통 텍스트 정규화 (모든 문자열 컬럼)
  → B2. 컬럼별 정제·타입 변환
  → B3. 서비스명 파싱 → target_hint, base_name, aliases, name_keys
  → B4. 사이트/대표문의 파싱 → sites[], contacts[]
  → B5. (--enrich) 캐시 XML 파싱 → 보강 텍스트 정제 → 병합
  → (delta 모드) 여러 파일의 레코드를 파일명 순으로 병합. 같은 ID는 뒤 파일이 이김
  → exclude_ids 제거, (Step 14) _overrides.csv 적용
  → B6. 검증 → reports/{source_id}/{파일명}.json
  → B7. processed/{source_id}.jsonl 저장 (UTF-8, 1줄 = 1서비스, service_id 오름차순)
```

### 5.3 B1: 공통 텍스트 정규화 (`ingest/text_clean.py`)
```python
def clean_text(s: str | None) -> str | None:
    if s is None or not s.strip():
        return None
    s = html.unescape(s)                      # &middot; → ·
    s = unicodedata.normalize("NFC", s)
    s = CONTROL_CHARS.sub("", s)              # [\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b\ufeff]
    s = re.sub(r"\s+", " ", s).strip()        # CSV 필드는 한 줄 텍스트
    return s
```
| 적용 결과 (실측) | 건수 |
|---|---|
| HTML 엔티티 복원 (`&middot;`) | 서비스요약 3건 |
| 공백 정리 (연속 공백, 앞뒤 공백) | 서비스요약 24, 서비스명 4, 사이트 1, 대표문의 1 |
| 결측 → `None` | 사이트 35건 |
| 제어문자, NBSP, 제로폭 문자 | 0건 (규칙은 방어용으로 유지) |

> ⚠️ **NFKC는 쓰지 않습니다.** 실측해 보니 NFKC를 적용하면 `유산ㆍ사산`의 `ㆍ`(U+318D, 호환 자모)가 결합형 자모(U+119E)로 바뀌어 화면에서 글자가 깨집니다. `Ⅰ`→`I` 같은 변환은 검색 키를 만들 때만 명시적인 치환표로 처리합니다 (§5.5).

### 5.4 B2: 컬럼별 정제
| 원본 컬럼 | 출력 필드 | 규칙 |
|---|---|---|
| 서비스아이디 | `service_id` | `id_prefix` + 원본 ID (복지로는 접두사 없음. read에서 검증 완료) |
| 서비스명 | `name` | 공통 정규화만 적용 (표시용 원문). 파생 필드는 §5.5 |
| 서비스요약 | `summary` | 공통 정규화. **중복 요약 표시**: 정규화 후 의료급여 계열 8건이 2개 문장을 공유합니다(6건, 2건). 리포트에 기록하고, 청크에서는 서비스명으로 구분합니다 |
| 서비스URL | `url` | `wlfareInfoId` 쿼리값이 `service_id`와 같은지 검증합니다 (실측 367/367 일치) |
| 사이트 | `site_raw`, `sites` | §5.6 |
| 대표문의 | `contact_raw`, `contacts` | §5.6 |
| 소관부처명 | `ministry` | 허용값 22종 목록과 대조합니다. 목록에 없는 값이 나오면 경고합니다 |
| 소관조직명 | `org` | 공통 정규화 |
| 기준연도 | `base_year` | `int` |
| 최종수정일 | `updated_at` | `date.fromisoformat()` 실패 시 예외 |

**before → after 예시** (`WLF00000087` 서비스요약)
```
before: 기초생활수급자, 국가유공자, 장애인 등이 부담하는 지방세를 감면&middot;면제하여 생활 안정과 시설 운영을 돕습니다.
after : 기초생활수급자, 국가유공자, 장애인 등이 부담하는 지방세를 감면·면제하여 생활 안정과 시설 운영을 돕습니다.
```

### 5.5 B3: 서비스명 파싱
괄호가 있는 서비스명은 55건이고, 그중 중첩 괄호도 있습니다. 그래서 정규식 대신 **깊이를 세는 파서**로 처리합니다.

**인터페이스** (`ingest/parsers.py`, Step 3. §5.6의 파서도 같은 파일에 둡니다)
| 함수 | 반환 |
|---|---|
| `parse_name(name)` | `target_hint, base_name, aliases, name_keys` |
| `key(s)` | 검색 키 전용 정규화 문자열 (표시에 쓰지 않음) |
| `parse_sites(s)` | `[{label, url}]` (§5.6) |
| `parse_contacts(s)` | `([{label, phone, note}], anomaly)`. `anomaly`는 자릿수가 맞지 않는 번호처럼 리포트에 남길 원본 오류 (§5.6, §5.8) |

| 파생 필드 | 규칙 | 용도 |
|---|---|---|
| `target_hint` | **맨 앞** 괄호의 내용. `^\(([^)]+)\)` | overview 태그 `대상=…`. 실측 12건: 북한이탈주민 9, 산재근로자 2, 특수교육대상자 1 |
| `base_name` | 깊이 1 이상인 괄호를 **내용째** 제거한 이름 | 이름 사전의 기본 키 |
| `aliases` | 깊이 1 괄호의 내용 중 ① target_hint가 아니고 ② 쉼표가 없으며 ③ 키 길이가 3자 이상인 것 | 이름 사전 (예: "두루누리", "K-패스"). 실측 34개 |
| `name_keys` | `key(name)`, `key(base_name)`, `key(alias…)`를 중복 없이 모은 목록. 3자 미만은 버림 | 서비스명 pin 매칭 (§8) |

```python
KEYMAP = str.maketrans({"Ⅰ": "I", "Ⅱ": "II"})
def key(s: str) -> str:               # 검색 키 전용 (표시에 쓰지 않음)
    return re.sub(r"[\s·ㆍ,.\-'~()]", "", s.translate(KEYMAP)).lower()
```

**실측 예시**
| 원문 `name` | `target_hint` | `base_name` | `aliases` | 비고 |
|---|---|---|---|---|
| (북한이탈주민)교육비 지원 | 북한이탈주민 | 교육비 지원 | | |
| 사회보험사각지대해소 사업(두루누리 사회보험료 지원사업) | | 사회보험사각지대해소 사업 | 두루누리 사회보험료 지원사업 | 사용자는 "두루누리"로 검색합니다 |
| 대중교통비 환급 지원(K-패스) | | 대중교통비 환급 지원 | K-패스 | key는 `k패스` |
| 모성보호육아지원(출산전후휴가(유산ㆍ사산휴가 포함) 급여, 육아휴직등 급여) | | 모성보호육아지원 | | 중첩 괄호. 쉼표가 있어 alias에서 제외 |
| 독립유공자 (손)자녀 생활지원금 | | 독립유공자 자녀 생활지원금 | | `name_keys`에 `독립유공자손자녀생활지원금`이 들어가 "손자녀" 검색도 매칭됩니다 |
| 교통시설 이용지원(버스,내항여객선,KTX등) | | 교통시설 이용지원 | | 쉼표가 있어 제외 |

> **여러 서비스가 공유하는 키** (실측): `의료급여` 6건, `맞춤형급여` 3건, `취약계층에너지복지사업`·`서민금융활성화지원`·`훈련수당` 각 2건. 그래서 pin은 **최대 3개**로 제한하고, pin끼리의 순서는 RRF 점수로 정합니다 (§8).

### 5.6 B4: 사이트와 대표문의 파싱
두 컬럼 모두 `기관명URL` 또는 `기관명전화번호`가 **공백 없이 붙은 채** 여러 개 이어져 있습니다. 응답 카드에 링크와 전화 버튼을 달려면 구조화해야 합니다.

**사이트 → `sites: [{label, url}]`**
```python
URL = re.compile(r"(https?://\S+|www\.\S+|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:go|or|co|re|ac)\.kr(?:/\S*)?)")
# URL 앞 텍스트가 label. scheme이 없으면 http://를 붙임. URL 뒤에 텍스트가 남으면 {label, url: None}
```
```
in : 국가건강정보포털http://health.mw.go.kr/ 국가암정보센터http://www.cancer.go.kr 국민건강보험www.nhis.or.kr
out: [{"label":"국가건강정보포털","url":"http://health.mw.go.kr/"},
      {"label":"국가암정보센터","url":"http://www.cancer.go.kr"},
      {"label":"국민건강보험","url":"http://www.nhis.or.kr"}]
```
실측: 결측이 아닌 332행을 파싱했고, 그중 331행에서 URL을 1개 이상 얻었습니다. URL을 하나도 얻지 못한 행은 1건(`WLF00000946`)이고 `{label, url: null}` 항목 하나만 남습니다. 한 행이 만드는 항목은 최대 54개(`WLF00004650` 청소년성문화센터설치운영)이므로, **UI에서는 상위 3개만 보여 주고 나머지는 "더보기"로 접습니다**.

**대표문의 → `contacts: [{label, phone, note}]`**
```python
PHONE = re.compile(
  r"(?:국번없이\s*)?"
  r"((?:0\d{1,2}-\d{3,4}-\d{4}|1\d{3}-\d{4}|1\d{2,3})"   # 지역번호형 / 15xx-xxxx / 129·1350
  r"(?:~\d{1,4})?"                                        # 범위: 02-2670-0410~9
  r"(?:,\s*\d{4}(?:-\d{4})?)*)"                           # 추가 번호: 031-670-9323, 9327
  r"(\s*\([^)]*\))?(?!\d)"                                # 비고: (내선번호 3번)
)
```
| 입력 (실제 데이터) | 출력 |
|---|---|
| `국민건강보험1577-1000 보건복지상담센터129` | `[{국민건강보험, 1577-1000}, {보건복지상담센터, 129}]` |
| `K-스타트업1357(내선번호 3번)` | `[{K-스타트업, 1357, note: 내선번호 3번}]` |
| `근로복지공단 직장보육지원센터02-2670-0410~9` | `[{…직장보육지원센터, 02-2670-0410~9}]` |
| `보건복지상담센터129 주소지 읍·면·동 주민센터주소지 읍·면·동 주민센터` | `[{보건복지상담센터, 129}, {주소지 읍·면·동 주민센터, phone: null}]` ← **반복 라벨 제거** |

- **반복 라벨 제거**: 번호 없이 남은 텍스트가 `XX` 형태(같은 문자열이 두 번 이어짐)면 절반만 남깁니다. 원본에서 "라벨+값" 자리에 라벨이 두 번 들어간 흔적으로 보입니다.
- **실측 결과**: 364/367건에서 전화번호를 1개 이상 추출했고, 전화번호가 아예 없는 행은 3건입니다(예: "학교 밖 청소년지원센터 홈페이지"). 번호 없이 라벨만 남는 항목은 11행에 있습니다.
- **원본 오류 의심 2건 (수정하지 않고 리포트)**: `WLF00003279`의 `15266-3232`(자릿수 초과, 1566-3232의 오기로 추정), `WLF00001126`의 `02-3978-600`(자릿수 부족)

### 5.7 B5: 보강 텍스트 정제 (`--enrich`일 때)
API 필드는 여러 줄에 걸친 서식 텍스트이므로 CSV와 다른 규칙을 씁니다. **줄바꿈은 유지합니다.** 청킹이 줄 단위로 동작하기 때문입니다.
정제 함수는 `ingest/text_clean.py`에 `clean_text`와 나란히 둡니다(Step 4). `enrich.py`는 XML에서 원문 문자열만 꺼내고, 정제는 이 함수에 맡깁니다.

| # | 규칙 |
|---|---|
| 1 | `html.unescape`를 적용하고, `<br>`, `</p>`, `</li>`는 `\n`으로 바꾼 뒤 나머지 태그를 제거합니다 |
| 2 | 줄마다 `clean_text` 수준의 정규화(NFC, 제어문자 제거, 줄 안의 연속 공백 1칸)를 합니다 |
| 3 | 글머리표 `○ ㅇ • ▶ ◦ · -`로 시작하는 줄은 `- `로 통일합니다. `※` 주석은 정보이므로 그대로 둡니다 |
| 4 | 빈 줄이 여러 개 이어지면 1줄로 줄이고, 바로 앞 줄과 같은 줄은 제거합니다 |
| 5 | 값 전체가 `해당없음`, `없음`, `-`, `.`, `상세 내용 참조`이면 `None`으로 처리합니다 |
| 6 | 리스트형 필드(`lifeArray` 등)는 쉼표로 split하고 strip한 뒤 중복을 제거해 `list[str]`로 만듭니다 |
| 7 | `onapPsbltYn`은 `Y`/`N`을 `True`/`False`로, 그 밖의 값은 `None`으로 바꿉니다 |
| 8 | `enriched_at`에 캐시 파일의 수정 시각을 기록합니다 |

> API 응답의 실제 서식은 아직 확인되지 않았습니다. Step 4에서 **캐시 XML 5건을 직접 열어 보고** 위 규칙을 보정합니다.

### 5.8 B6: 검증과 품질 리포트
**예외로 중단하는 경우**: `service_id` 중복, 필수 필드 결측(모든 소스 공통은 `name`, `summary`. `bokjiro_csv`는 `url`, `ministry`도 필수), URL과 ID 불일치, 날짜 파싱 실패. 실패하면 해당 소스의 실행만 `failed`로 기록하고 DB는 바뀌지 않습니다.

**`reports/bokjiro_central/20250722.json`** (값은 20250722 스냅샷 기준 실측치, 보강 항목은 실행 후 채워짐)
```json
{
  "generated_at": "…",
  "input": {"source_id": "bokjiro_central", "file": "bokjiro_central/20250722.csv",
            "sha256": "0677e1be85c745372ee6ebe0a9a3dd332016aa68fac0ca5fd235ef9465e5c7c0", "rows": 367},
  "text_clean": {"html_unescaped": {"서비스요약": 3},
                 "whitespace_fixed": {"서비스요약": 24, "서비스명": 4, "사이트": 1, "대표문의": 1},
                 "null": {"사이트": 35}},
  "name": {"target_hint": 12, "aliases": 34, "shared_keys": {"의료급여": 6, "맞춤형급여": 3}},
  "summary_duplicates": {"groups": 2, "rows": 8},
  "sites": {"rows_parsed": 332, "url_null_entries": 1, "max_per_row": 54},
  "contacts": {"rows_with_phone": 364, "rows_without_phone": 3, "rows_with_label_only_entries": 11},
  "anomalies": [
    {"service_id": "WLF00003279", "field": "대표문의", "value": "사회서비스 전자바우처15266-3232"},
    {"service_id": "WLF00001126", "field": "대표문의", "value": "저축은행중앙회 대표전화02-3978-600"}
  ],
  "enrich": {"requested": null, "cached": null, "fetched": null, "failed": [], "empty_sections": {}}
}
```
**`sites` 항목의 정의** (세는 단위가 달라서 값이 흔들리기 쉬우므로 못 박습니다. 기준은 §5.6의 `URL` 정규식과 파싱 규칙입니다)

| 필드 | 세는 단위 | 정의 | 실측 |
|---|---|---|---|
| `rows_parsed` | **행** | `사이트`가 결측이 아니어서 파싱을 시도한 행 수 (= 367 − 결측 35) | 332 |
| `url_null_entries` | **항목** | 전체 행에서 만들어진 `{label, url: null}` 항목의 합계 (URL 뒤에 남은 꼬리 텍스트 포함) | 1 |
| `max_per_row` | **항목** | 한 행이 만든 `sites` 항목 수의 최댓값 (`url: null` 항목 포함) | 54 |

- `rows_parsed`는 "URL을 얻은 행 수"가 아닙니다. URL을 1개 이상 얻은 행은 331이고, 나머지 1행(`WLF00000946`)은 라벨만 남습니다.
- `max_per_row`는 **URL 매치 수나 공백 토큰 수가 아니라 항목 수**입니다. 최댓값 행(`WLF00004650`)은 공백 토큰이 56개지만 항목은 54개입니다.

> **테스트는 `data/raw`가 아니라 고정 fixture(`tests/fixtures/bokjiro_central_20250722.csv`)로 위 수치를 assert합니다** (Step 3). `data/raw`는 계속 바뀌므로, 거기에 테스트를 묶으면 새 CSV를 넣을 때마다 테스트가 깨집니다. 새 스냅샷의 리포트 수치가 크게 달라지면 먼저 파서 회귀를 의심하고, 리포트끼리 비교해 봅니다.

### 5.9 B7: 산출물 `processed/{source_id}.jsonl`
한 줄이 서비스 하나(= `ServiceRecord` 하나)입니다. 아래는 실제 데이터 `WLF00001176`의 전처리 결과입니다 (보강 전).
```json
{"service_id":"WLF00001176","source_id":"bokjiro_central","source_file":"bokjiro_central/20250722.csv",
 "name":"암검진사업","base_name":"암검진사업","name_keys":["암검진사업"],
 "target_hint":null,"aliases":[],
 "summary":"국가 암검진 사업을 통해 암을 조기 발견, 치료를 유도함으로써 암의 치료율을 높이고 암으로 인한 사망을 줄입니다.",
 "url":"https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00001176&wlfareInfoReldBztpCd=01",
 "ministry":"보건복지부","org":"질병정책과",
 "site_raw":"국가건강정보포털http://health.mw.go.kr/ 국가암정보센터http://www.cancer.go.kr 국가암조기검진사업정보시스템http://ncs.ncc.re.kr 국민건강보험www.nhis.or.kr",
 "sites":[{"label":"국가건강정보포털","url":"http://health.mw.go.kr/"},{"label":"국가암정보센터","url":"http://www.cancer.go.kr"},
          {"label":"국가암조기검진사업정보시스템","url":"http://ncs.ncc.re.kr"},{"label":"국민건강보험","url":"http://www.nhis.or.kr"}],
 "contact_raw":"국민건강보험1577-1000 보건복지상담센터129",
 "contacts":[{"label":"국민건강보험","phone":"1577-1000","note":null},{"label":"보건복지상담센터","phone":"129","note":null}],
 "base_year":2025,"updated_at":"2025-03-12",
 "target_detail":null,"selection_criteria":null,"benefit_content":null,"apply_method":null,
 "life_stages":[],"households":[],"interests":[],"provision_type":null,"support_cycle":null,"online_apply":null,"enriched_at":null}
```

```python
# ingest/records.py
PIPELINE_VERSION = "2026.09.1"   # 전처리·청킹 규칙을 바꾸면 올림 → 같은 파일도 다시 처리됨

@dataclass
class ServiceRecord:
    service_id: str; source_id: str; source_file: str
    name: str; base_name: str; name_keys: list[str]
    target_hint: str | None; aliases: list[str]
    summary: str; url: str | None; ministry: str | None; org: str | None
    site_raw: str | None; sites: list[dict]; contact_raw: str | None; contacts: list[dict]
    base_year: int | None; updated_at: date | None
    # 보강 필드
    target_detail: str | None = None; selection_criteria: str | None = None
    benefit_content: str | None = None; apply_method: str | None = None
    life_stages: list[str] = field(default_factory=list)
    households: list[str] = field(default_factory=list)
    interests: list[str] = field(default_factory=list)
    provision_type: str | None = None; support_cycle: str | None = None
    online_apply: bool | None = None; enriched_at: datetime | None = None
    # to_json() / from_json() 제공. 청킹과 인덱싱은 이 클래스로만 입력을 받음

def record_hash(rec: ServiceRecord) -> str:
    """변경 감지용. source_file과 enriched_at은 제외한다.
    제외하지 않으면 새 스냅샷이 들어올 때마다 모든 서비스가 '수정됨'으로 잡힌다."""
```

---

## 6. 단계 C: 청킹 (`ingest/chunker.py`)

**입력**: `processed/{source_id}.jsonl`의 `ServiceRecord`. **시그니처**: `build_chunks(rec) -> list[Chunk]` (순수 함수)

| 섹션 | 원천 | 생성 조건 | 헤더 |
|---|---|---|---|
| `overview` | 서비스명, 부처, 조직, 요약, 태그 | **항상 1개** | 없음 (본문에 서비스명 포함) |
| `target` | `target_detail` | 보강되었고 20자 이상일 때 | `[서비스명] 지원대상` |
| `criteria` | `selection_criteria` | 동일. 단, target과 내용이 같으면 생략 | `[서비스명] 선정기준` |
| `benefit` | `benefit_content` | 동일 | `[서비스명] 지원내용` |

- **분할**: 본문(헤더 제외)이 `MAX_CHARS=500`자를 넘을 때만 분할합니다. 줄 단위로 채우다가 500자를 넘으면 끊고, 다음 조각은 이전 조각의 **마지막 줄 1개를 겹쳐** 시작합니다. 한 줄이 500자를 넘으면 문장 끝(`다. 요. 음. 함.`) 기준으로 먼저 자릅니다.
- **모든 조각에 헤더를 반복**합니다. 조각 하나만 검색되어도 어느 서비스 이야기인지 알 수 있어야 합니다.
- **chunk_id**: `f"{service_id}:{section}:{seq:02d}"`
- **임베딩에 넣지 않는 것**: `sites`, `contacts`, `apply_method`, `url`. 표시와 컨텍스트 전용입니다 ([welfare-rag-features.md](welfare-rag-features.md) 참고).

```python
lines = [f"서비스명: {r.name}",
         f"분류: {r.ministry}" + (f" > {r.org}" if r.org else ""),
         f"요약: {r.summary}"]
tags = []
if r.target_hint:    tags.append(f"대상={r.target_hint}")
if r.life_stages:    tags.append("생애주기=" + ",".join(r.life_stages))
if r.households:     tags.append("가구상황=" + ",".join(r.households))
if r.interests:      tags.append("관심주제=" + ",".join(r.interests))
if r.provision_type: tags.append(f"제공유형={r.provision_type}")
if tags: lines.append("태그: " + " | ".join(tags))
```
**예상 청크 수**: CSV만 쓰면 정확히 367개, 보강하면 대략 1,500~2,200개 (추정치입니다. 실제 값은 리포트에 기록하세요)

---

## 7. 단계 D: 임베딩과 저장

### 7.1 스키마 (`BackEnd/db/schema.sql`)
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS welfare_services (
  service_id         TEXT PRIMARY KEY,           -- 모든 소스를 통틀어 고유 (§4.2 ID 규칙)
  -- 출처와 생명주기 (동기화용)
  source_id          TEXT NOT NULL,              -- sources.toml의 id
  source_file        TEXT NOT NULL,              -- 마지막으로 반영한 파일 (예: bokjiro_central/20250722.csv)
  record_hash        TEXT NOT NULL,              -- 변경 감지용 (§5.9 record_hash)
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at     TIMESTAMPTZ,
  last_run_id        BIGINT,                     -- 마지막으로 바꾼 ingest_runs.run_id
  -- 서비스 내용
  name               TEXT NOT NULL,
  base_name          TEXT NOT NULL,
  name_keys          TEXT[] NOT NULL DEFAULT '{}',
  target_hint        TEXT,
  aliases            TEXT[] NOT NULL DEFAULT '{}',
  summary            TEXT NOT NULL,
  url                TEXT,                       -- bokjiro_csv는 필수로 검증. 다른 소스는 없을 수 있음
  ministry           TEXT,                       -- 동일
  org                TEXT,
  site_raw           TEXT,
  sites              JSONB NOT NULL DEFAULT '[]',
  contact_raw        TEXT,
  contacts           JSONB NOT NULL DEFAULT '[]',
  base_year          SMALLINT,
  updated_at         DATE,
  target_detail      TEXT,
  selection_criteria TEXT,
  benefit_content    TEXT,
  apply_method       TEXT,
  life_stages        TEXT[] NOT NULL DEFAULT '{}',
  households         TEXT[] NOT NULL DEFAULT '{}',
  interests          TEXT[] NOT NULL DEFAULT '{}',
  provision_type     TEXT,
  support_cycle      TEXT,
  online_apply       BOOLEAN,
  enriched_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS welfare_chunks (
  chunk_id      TEXT PRIMARY KEY,               -- {service_id}:{section}:{seq}
  service_id    TEXT NOT NULL REFERENCES welfare_services(service_id) ON DELETE CASCADE,
  section       TEXT NOT NULL CHECK (section IN ('overview','target','criteria','benefit')),
  seq           SMALLINT NOT NULL DEFAULT 0,
  content       TEXT NOT NULL,                  -- 임베딩한 텍스트 그대로 (헤더 포함)
  tokens        TSVECTOR,                       -- Kiwi 토큰 → to_tsvector('simple', …)
  embedding     VECTOR(1024) NOT NULL,
  embed_model   TEXT NOT NULL,
  content_hash  TEXT NOT NULL                   -- sha256(embed_model + '\n' + content)
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  run_id        BIGSERIAL PRIMARY KEY,
  source_id     TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('snapshot','delta')),
  input_files   JSONB NOT NULL,                 -- [{"name":"20250722.csv","sha256":"…"}]
  fingerprint   TEXT NOT NULL,                  -- §4.1 지문
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','aborted','dry_run')),
  stats         JSONB NOT NULL DEFAULT '{}',    -- §7.5 통계
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_runs_source      ON ingest_runs (source_id, run_id DESC);
CREATE INDEX IF NOT EXISTS ix_svc_source       ON welfare_services (source_id, is_active);
CREATE INDEX IF NOT EXISTS ix_chunks_service   ON welfare_chunks (service_id);
CREATE INDEX IF NOT EXISTS ix_chunks_embedding ON welfare_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS ix_chunks_tokens    ON welfare_chunks USING gin (tokens);
CREATE INDEX IF NOT EXISTS ix_svc_life         ON welfare_services USING gin (life_stages);
CREATE INDEX IF NOT EXISTS ix_svc_house        ON welfare_services USING gin (households);
CREATE INDEX IF NOT EXISTS ix_svc_interest     ON welfare_services USING gin (interests);
```
> 규모가 수천 행이라 exact scan도 수 ms면 끝납니다. HNSW는 확장에 대비한 것입니다. 필터를 건 검색에서 결과가 모자라면 `SET hnsw.iterative_scan = relaxed_order;`를 켭니다 (pgvector 0.8 이상).

### 7.2 DB 연결 (`core/db.py`)
```python
_pool: ThreadedConnectionPool | None = None

def _get_pool() -> ThreadedConnectionPool:
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(1, 10, host=…, port=…, dbname=…, user=…, password=…)
    return _pool

@contextmanager
def get_conn():
    pool = _get_pool()
    conn = pool.getconn()
    try:
        if id(conn) not in _registered:          # 연결마다 1회만
            register_vector(conn); _registered.add(id(conn))
        yield conn
        conn.commit()
    except Exception:
        conn.rollback(); raise
    finally:
        pool.putconn(conn)
```
- **풀은 지연 생성합니다.** import 시점에 연결하지 않고, 첫 `get_conn()` 호출 때 만듭니다. DB가 아직 없거나 `init_db` 전이어도 앱이 떠야 하기 때문입니다 (§10 `/health`). 스레드풀에서 여러 요청이 동시에 처음 호출할 수 있으므로, 실제 구현에서는 `_get_pool()`의 생성 부분을 `threading.Lock`으로 감쌉니다.
- ⚠️ **`register_vector`는 vector 확장이 이미 설치된 DB에서만 성공합니다.** `scripts/init_db.py`는 등록하지 않은 **일반 연결**로 schema.sql을 먼저 실행해야 합니다.
- **`get_lock_conn()`**: advisory lock 전용 연결을 돌려줍니다. 풀을 쓰지 않고 새 연결을 엽니다. advisory lock은 세션(연결) 단위라서, 잠금을 잡은 연결을 풀에 반납하면 그 연결을 다음에 빌려 간 작업이 잠금을 물려받습니다 (§7.6, Step 8).
- 등록 후에는 `numpy.ndarray`를 파라미터로 그대로 넘기면 됩니다: `ORDER BY embedding <=> %(qvec)s`
- 대량 insert에는 `psycopg2.extras.execute_values`, JSONB 값에는 `psycopg2.extras.Json`을 씁니다.
- 비동기 엔드포인트에서는 `await run_in_threadpool(retriever.search, …)`로 호출해 이벤트 루프가 막히지 않게 합니다.

### 7.3 임베더 (`services/embedder.py`)
```python
class Embedder:                                      # 동기. ingest와 retriever(스레드풀)에서 공용
    def embed_documents(self, texts: list[str]) -> np.ndarray: ...
    def embed_query(self, text: str) -> np.ndarray: ...
```
- Ollama에 `POST {OLLAMA_BASE_URL}/api/embed`, 본문 `{"model": OLLAMA_EMBED, "input": [...]}`를 보내고 응답의 `embeddings`를 씁니다.
- 배치 크기 32, timeout 60초, 재시도 3회.
- 결과는 **L2 정규화**하고 `shape[1] == EMBED_DIM`인지 assert합니다.
- bge-m3는 질의와 문서에 접두사가 필요 없습니다. 함수를 둘로 나눈 것은 접두사가 필요한 모델로 바꿀 때를 위한 것입니다. 예를 들어 `nomic-embed-text`로 바꾼다면 질의에는 `search_query: `, 문서에는 `search_document: `를 붙여야 합니다 (e5 계열은 `query: `/`passage: `).

### 7.4 키워드 토큰 (`services/tokenizer.py`)
- `Kiwi().tokenize(text)` 결과에서 품사 `NNG, NNP, NR, SN, SL, XR`만 남깁니다.
- overview 청크에는 `name_keys`도 토큰으로 추가합니다. 예: `장애인연금`, `두루누리사회보험료지원사업`
- DB에는 `to_tsvector('simple', %(tokens)s)`로 저장합니다. Kiwi가 이미 분리해 두었으므로 `simple` 설정으로 충분합니다.

### 7.5 인덱서 (`ingest/index.py`)
**시그니처**: `apply(source: SourceConfig, records: list[ServiceRecord], run_id: int, *, dry_run: bool, rebuild: bool, allow_mass_delete: bool) -> Stats`
입력은 전처리 결과인 `ServiceRecord` 목록뿐입니다. **CSV나 API를 직접 읽지 않습니다.**

**① 레코드 diff** (해당 `source_id`의 DB 행과 비교)
| 분류 | 조건 | 처리 |
|---|---|---|
| `added` | DB에 없음 | INSERT, 청크 생성 |
| `updated` | DB에 있고 `record_hash`가 다름 | UPDATE, 청크 diff |
| `reactivated` | DB에 있고 `is_active=false`였음 | 활성화, 청크 재생성 |
| `unchanged` | 해시가 같음 | `last_seen_at`, `source_file`만 갱신. **청크는 건드리지 않음** |
| `deactivated` | snapshot 모드에서 DB에는 활성인데 새 파일에 없음 (또는 `exclude_ids`) | `is_active=false`, `deactivated_at=now()`, **청크 삭제**. 서비스 행은 남김 |

- **대량 제외 가드**: `deactivated / 활성 서비스 수 > MAX_DEACTIVATE_RATIO(0.2)`이면 아무것도 쓰지 않고 `aborted`로 끝냅니다. 잘리거나 잘못 받은 CSV 하나 때문에 서비스 대부분이 검색에서 사라지는 사고를 막습니다. 정말 의도한 변경이면 `--allow-mass-delete`로 실행합니다.
- **ID 충돌 검사**: 다른 `source_id`가 이미 가진 `service_id`가 있으면 실패시킵니다.

**② 청크 diff** (`added`, `updated`, `reactivated` 서비스만)
1. `build_chunks()`로 청크를 만들고 `content_hash`를 계산합니다.
2. DB의 hash와 비교해 **바뀐 청크만 임베딩**하고, 사라진 chunk_id는 삭제합니다. `--rebuild`면 전부 다시 만듭니다.
3. 임베딩 호출은 트랜잭션 밖에서 먼저 끝내고, 쓰기는 **서비스 단위 트랜잭션**으로 합니다. 검색 중인 사용자는 서비스별로 항상 일관된 상태(이전 또는 이후)를 봅니다.

**적용 순서**: 추가, 수정, 재활성을 먼저 쓰고, **비활성화는 앞 단계가 모두 성공했을 때만 마지막에 한 트랜잭션으로** 적용합니다. 중간에 실패하면 이미 쓴 서비스는 남지만 해시가 기록되어 있으므로, 다시 실행하면 이어서 진행됩니다.

**통계 (`ingest_runs.stats`)**
```json
{"rows": 371, "added": 6, "updated": 14, "reactivated": 0, "unchanged": 349, "deactivated": 2,
 "chunks": {"embedded": 41, "skipped": 1480, "deleted": 9}}
```

### 7.6 동기화 오케스트레이터 (`ingest/sync.py`)
데이터를 반영하는 **유일한 진입점**입니다. CLI와 (Step 15의) 관리자 API가 같은 함수 `sync(...)`를 호출합니다.
```
python -m ingest.sync                                   # 모든 소스, 바뀐 것만
python -m ingest.sync --source bokjiro_central --dry-run   # 적용하지 않고 diff만 출력
python -m ingest.sync --source bokjiro_central --file 20250722.csv   # 특정 스냅샷으로 고정 (롤백)
python -m ingest.sync --enrich [--refresh]              # OpenAPI 보강 포함
python -m ingest.sync --rebuild                         # 임베딩 모델 교체 등으로 전량 재임베딩
python -m ingest.sync --allow-mass-delete               # 대량 제외 가드 해제 (의도한 경우만)
```

**흐름**
```
1. 잠금: lock_conn = core.db.get_lock_conn()
         lock_conn에서 pg_try_advisory_lock(hashtext('welfare_ingest')) 실패 → "다른 동기화가 실행 중" (종료 코드 2)
2. sources.toml 로드 → 대상 소스마다:
   a. 입력 파일 선택 (§4.1) → 지문 계산
   b. 해당 소스의 직전 succeeded 실행과 지문이 같고 --rebuild가 아니면 → "변경 없음" 출력 후 다음 소스
      (롤백을 위해 비교 대상은 "이 파일을 반영한 적이 있는가"가 아니라 "지금 DB 상태를 만든 직전 실행"이다)
   c. ingest_runs에 running 행 생성
   d. preprocess(source) → ServiceRecord 목록 (+ 리포트 파일)
   e. index.apply(...) → stats   (DB 쓰기는 풀의 get_conn()으로. lock_conn은 잠금 유지에만 씀)
   f. 실행 행을 succeeded / failed / aborted / dry_run 으로 마감
3. finally: lock_conn에서 pg_advisory_unlock → lock_conn.close()
```
> ⚠️ 잠금을 `get_conn()`으로 잡으면 안 됩니다. 잠금이 남은 채 연결이 풀에 반납되어, 그 연결을 다음에 빌려 간 작업이 잠금을 물려받습니다 (§7.2).

**`--dry-run` 출력 예시** (적용 전 검토용)
```
[bokjiro_central] 20260115.csv  sha256=3f2a…  pipeline=2026.09.1  embed=bge-m3
  rows=371  added=6  updated=14  reactivated=0  unchanged=349  deactivated=2 (0.5%)
  + WLF00005501  (새 서비스 이름)
  ~ WLF00001164  기초연금          changed: summary, contacts
  - WLF00000812  청년창업농장학금 지원
  (dry-run: DB 변경 없음)
```
`changed:` 목록은 DB 컬럼과 새 레코드를 필드별로 비교해서 만듭니다.

**종료 코드**: 0 성공(변경 없음 포함), 1 실패, 2 잠금 실패, 3 대량 제외 가드로 중단

**검색 쪽 반영**: 서비스명 사전(§8.1)은 `index_version = max(run_id) of succeeded runs`가 바뀌면 다시 읽습니다. 확인은 최대 30초에 한 번입니다. 그래서 동기화 후 **서버를 재시작하지 않아도** 새 서비스가 pin됩니다.

### 7.7 운영 절차 (CSV 추가·수정)
| 상황 | 절차 |
|---|---|
| **새 스냅샷 반영** (포털에서 새 CSV를 받음) | ① `data/raw/bokjiro_central/YYYYMMDD.csv`로 저장 (원래 파일명을 버리고 기준일로) ② `sync --source bokjiro_central --dry-run`으로 diff와 리포트 확인 ③ `sync --source bokjiro_central --enrich` ④ `ingest_runs`와 `/health`로 확인 |
| **신규 서비스 몇 건 추가** (같은 형식) | 수기로 관리할 소스를 `mode = "delta"`로 하나 두고, `data/raw/<그 소스>/YYYYMMDD.csv`로 추가한 뒤 sync. 다른 소스이므로 `id_prefix`가 필요합니다 |
| **특정 필드 오류 수정** (예: 전화번호 오기) | 원본 대신 `_overrides.csv`에 `service_id, field, value, note`를 한 줄 추가 (Step 14) → sync. 원본을 고치지 않으므로 다음 스냅샷에도 보정이 유지되고, 리포트에 보정 내역이 남습니다 |
| **서비스 영구 제외** | `sources.toml`의 `exclude_ids`에 추가 → sync (지문이 바뀌므로 자동 반영) |
| **형식이 다른 새 CSV** | `sources.toml`에 소스를 추가하고 `adapter = "mapped_csv"`로 컬럼을 매핑 (Step 14). 매핑으로 부족하면 전용 어댑터를 작성 |
| **잘못 반영한 스냅샷 되돌리기** | `sync --source <id> --file <이전 파일>` 실행. 확인이 끝나면 잘못된 파일을 `raw`에서 치웁니다 |
| **임베딩 모델 교체** | `.env`의 `OLLAMA_EMBED`와 `EMBED_DIM`을 바꾸고, 스키마 차원을 바꾼 뒤 `sync --rebuild` |
| **전처리 규칙 변경** | `PIPELINE_VERSION`을 올립니다 → 다음 sync에서 모든 소스를 다시 처리합니다 (바뀐 청크만 재임베딩) |

### 7.8 왜 이 구조인가 (검토한 대안)
| 대안 | 장점 | 단점 | 판단 |
|---|---|---|---|
| **A. 등록부 + 어댑터 + 3단계 diff sync (채택)** | 파일과 설정만으로 추가·수정·롤백이 됩니다. 원본과 전처리 결과를 사람이 볼 수 있고, 표준 라이브러리 외 의존성이 없습니다 | 코드량이 조금 늘어납니다 (sources, index, sync) | 캡스톤 규모와 "CSV 수시 추가"에 가장 잘 맞습니다 |
| B. CSV를 DB 스테이징 테이블에 넣고 SQL `MERGE`로 diff | diff가 SQL 한 번으로 끝납니다 | 전처리(파이썬)와 diff(SQL)로 로직이 흩어지고, 파일 단위 검토가 어렵습니다 | 데이터가 수십만 건이 되면 고려합니다 |
| C. 폴더 감시(watchdog)로 파일이 들어오면 자동 적재 | 사람이 명령을 안 쳐도 됩니다 | 파일이 반쯤 복사된 상태로 적재되거나, 검토 없이 반영되는 사고가 납니다 | 채택하지 않습니다. 자동화가 필요하면 Step 15의 관리자 API를 스케줄러로 호출합니다 |
| D. LlamaIndex·LangChain의 ingestion pipeline과 docstore | 문서 중복 제거를 기본 제공합니다 | 무거운 의존성이 생기고, 복지 도메인 전처리(서비스명, 연락처)와 소프트 삭제 규칙을 결국 직접 짜야 합니다 | 채택하지 않습니다 |
| E. 기존 설계 유지 (단일 `RAW_CSV_PATH` + 전체 재적재) | 가장 단순합니다 | 삭제된 서비스가 남고, 파일 두 개를 동시에 쓸 수 없고, 출처와 이력이 없습니다 | 수시 갱신 요구를 충족하지 못합니다 |

---

## 8. 단계 E: 의미검색 (`services/retriever.py`)

**시그니처**: `def search(query: str, filters: SearchFilters, top_n: int = 5) -> SearchResult` (동기 함수, 라우터에서 스레드풀로 호출)

### 8.1 알고리즘
```
1. q = clean_text(query)
2. pinned = name_dict_match(key(q))             # 서비스명 사전 매칭
     - 사전: 활성(is_active) 서비스의 name_keys → service_id 목록
       (메모리에 두고, index_version이 바뀌면 다시 로드. 확인은 최대 30초에 한 번, §7.6)
     - 질문 키 안에 사전 키가 부분 문자열로 들어 있으면 hit
     - 긴 키부터 매칭하고 최대 3개까지 (예: "의료급여"는 6개 서비스와 매칭되지만 3개로 제한)
3. q_vec = embedder.embed_query(q)
4. dense  = Top K_DENSE(30) 청크, sim = 1 - cosine_distance
5. sparse = Top K_SPARSE(30) 청크, ts_rank_cd (질문을 Kiwi 토큰화한 뒤 OR 결합)
6. RRF: chunk_score[c] = Σ_{list ∈ {dense, sparse}} 1 / (60 + rank_list(c))
7. 서비스 집계: svc_score[s] = max(chunk_score), matched_sections[s], best_sim[s]
8. 정렬: pinned 먼저(pinned끼리는 svc_score 순), 나머지는 svc_score 내림차순
9. 무응답 판정: pinned가 없고 max(best_sim) < MIN_DENSE_SIM(0.45)이면 빈 결과
10. 상위 top_n개를 welfare_services에서 1회 조회해 순서를 유지한 채 반환
```

### 8.2 SQL (psycopg2 파라미터 형식)
```sql
-- dense (필터가 있을 때만 Python에서 WHERE 절을 추가. 빈 리스트는 넘기지 않음)
SELECT c.chunk_id, c.service_id, c.section,
       1 - (c.embedding <=> %(qvec)s) AS sim
FROM welfare_chunks c
JOIN welfare_services s USING (service_id)
WHERE s.is_active
/* AND s.ministry = ANY(%(ministries)s) AND s.life_stages && %(life_stages)s::text[] */
ORDER BY c.embedding <=> %(qvec)s
LIMIT %(k)s;

-- keyword (%(kw)s = ' or '.join(질문 토큰))
SELECT c.chunk_id, c.service_id, c.section, ts_rank_cd(c.tokens, q) AS rank
FROM welfare_chunks c
JOIN welfare_services s USING (service_id),
     websearch_to_tsquery('simple', %(kw)s) q
WHERE s.is_active AND c.tokens @@ q
ORDER BY rank DESC
LIMIT %(k)s;
```
> 비활성 서비스의 청크는 동기화 때 삭제되므로 `s.is_active` 조건은 이중 안전장치입니다.

### 8.3 설계 포인트
| 포인트 | 결정 |
|---|---|
| RRF를 쓰는 이유 | cosine과 ts_rank는 점수 척도가 달라 바로 더할 수 없습니다. RRF는 순위만 쓰므로 정규화가 필요 없습니다 |
| 서비스 단위로 반환하는 이유 | 사용자가 원하는 답의 단위는 "서비스"입니다. 한 서비스의 청크 여러 개가 Top 5를 다 차지하는 것을 막습니다 |
| 필터 | UI에서 명시적으로 고른 값만 hard filter로 겁니다. 결과가 0건이면 필터를 풀고 다시 검색한 뒤 `filters_relaxed=true`로 알립니다 |
| 임계값 0.45 | **초기 추정값입니다.** §11의 부정 질의로 조정합니다 |
| 질의 분석 LLM | MVP에서는 끕니다 (+1~3초). Phase 2에서 검토합니다 |

```python
@dataclass
class RetrievedService:
    service: dict                  # welfare_services 한 행 (sites, contacts 포함)
    score: float
    best_sim: float
    matched_sections: list[str]
    pinned: bool

@dataclass
class SearchResult:
    services: list[RetrievedService]
    filters_relaxed: bool
    no_result: bool
    timings_ms: dict[str, int]
```

---

## 9. 단계 F: 응답 생성

### 9.1 컨텍스트 구성 (`services/prompt_builder.py`)
값이 없는 필드는 줄 자체를 생략합니다. 문의처는 `contacts`에서 전화번호가 있는 항목을 앞에서부터 최대 2개까지 씁니다.
```
<service rank="1" id="WLF00003249">
서비스명: 장애인연금
소관: 보건복지부 장애인자립기반과
요약: …
지원대상: …            (최대 600자)
선정기준: …            (최대 600자)
지원내용: …            (최대 600자)
신청방법: …            (최대 300자)
문의: 보건복지상담센터 129
기준일: 2025-05-07
</service>
```
- 전체 예산은 `CONTEXT_CHAR_BUDGET=6000`자입니다. 넘치면 **하위 순위 서비스부터** 필드를 줄이고, 잘린 곳에는 `…(생략: 상세는 링크 참고)`를 붙입니다.
- 검색에 걸린 섹션(`matched_sections`)은 자르는 순서에서 가장 뒤로 미룹니다.

### 9.2 시스템 프롬프트
```text
당신은 대한민국 중앙부처 복지서비스를 안내하는 상담 도우미입니다.

[규칙]
1. 반드시 <context> 안의 서비스 정보만 근거로 답합니다. 컨텍스트에 없는 서비스명·금액·자격기준·날짜·전화번호를 만들어 내지 않습니다.
2. 자격 여부를 단정하지 않습니다. "~에 해당하시면 대상이 될 수 있습니다"처럼 조건형으로 말하고, 최종 확인은 문의처나 복지로에서 해야 한다고 안내합니다.
3. 서비스명은 컨텍스트 표기 그대로 **굵게** 씁니다. URL은 쓰지 않습니다(링크는 화면에 따로 표시됩니다).
4. 답변 형식 (관련도 순, 최대 5개):
   **서비스명**
   - 해당될 수 있는 이유: (사용자 상황과 지원대상/요약을 연결해 1~2문장)
   - 지원 내용: (컨텍스트에 있을 때만)
   - 신청·문의: (신청방법 또는 문의처)
5. 사용자 정보가 부족해 판단이 갈리면, 답변 끝에 확인 질문을 1~2개 합니다(예: 나이, 가구 형태, 소득 수준, 장애 여부).
6. 컨텍스트에 자격이나 지원내용 정보가 없으면 "세부 자격은 제공된 자료에 없어 링크에서 확인이 필요합니다"라고 말합니다.
7. 관련 서비스가 없으면 없다고 말하고 보건복지상담센터(129)를 안내합니다.
8. 주민등록번호, 계좌번호 같은 개인정보는 묻지 않습니다.
9. 한국어 존댓말로, 간결하게 답합니다.
```

### 9.3 사용자 프롬프트 템플릿
```text
<context>
{service_blocks}
</context>

<question>
{query}
</question>

위 규칙과 형식에 따라 답변하세요.
```

### 9.4 LLM 호출 (`services/llm.py`)
- Ollama에 `POST {OLLAMA_BASE_URL}/api/chat`을 보냅니다. `model`은 `OLLAMA_LLM`이고, `stream: true`면 NDJSON 줄마다 `message.content` 조각이 옵니다.
- 옵션: `{"temperature": 0.2, "top_p": 0.9, "num_ctx": 8192, "num_predict": 1024}`, `keep_alive: "30m"`
- `httpx.AsyncClient` timeout은 connect 5초, read 120초입니다. 연결 오류만 재시도 1회합니다(스트림 도중에는 재시도하지 않습니다).
- system 메시지를 잘 따르지 않으면, system 내용을 첫 user 메시지 앞에 합치는 fallback을 둡니다 (`LLM_MERGE_SYSTEM=true`).

### 9.5 가드레일 (`services/rag.py`)
| 시점 | 조건 | 처리 |
|---|---|---|
| 검색 전 | 빈 질문, 500자 초과 | 400 에러 |
| 검색 전 | 위기어(`자살`, `죽고 싶`, `자해` 등) | 응답 맨 앞에 **자살예방상담전화 109**와 **보건복지상담센터 129** 안내를 고정 문구로 넣고, 검색과 응답은 그대로 진행합니다 |
| 검색 후 | `no_result` | **LLM을 호출하지 않고** 고정 문구를 반환합니다: "제공된 중앙부처 복지서비스 자료에서 관련 서비스를 찾지 못했습니다. 보건복지상담센터(129)에 문의해 보세요." |
| 생성 후 | 답변 속 **굵은 서비스명**이 검색 결과에 없음 | 로그 경고만 남기고 평가 지표로 집계합니다 |
| 항상 | 답변 하단 | "※ 중앙부처 서비스 기준, 기준일 {max(updated_at)}. 지자체 서비스는 포함되지 않습니다." |

---

## 10. API 계약

| 메서드 | 경로 | 파일 | 응답 |
|---|---|---|---|
| POST | `/api/v1/search` | `routers/search.py` | JSON `SearchResponse` |
| POST | `/api/v1/chat` | `routers/chat.py` | `text/event-stream` |
| GET | `/api/v1/services/{service_id}` | `routers/services.py` | JSON (전처리 결과 전체). 비활성 서비스는 `is_active: false`로 반환 (이전 대화의 링크가 깨지지 않게) |
| GET | `/health` | `main.py` (현재 `{"status":"ok"}`만 반환. Step 1에서 `db`, Step 12에서 나머지) | `{status, db, ollama, models: {llm, embed}, index: {active_services, chunks, last_sync_at, index_version}}`. 연결이나 `register_vector` 실패는 잡아서 `"db": "error"`로 응답합니다. DB가 아직 준비되지 않았거나, `init-vector.sql` 없이 만들어진 기존 볼륨이라 `init_db` 전까지 vector 확장이 없으면 예외가 납니다. 이때 앱이 죽으면 `init_db`를 실행할 배포 컨테이너도 뜨지 않습니다 |
| POST | `/api/v1/admin/sync` | `routers/admin.py` (Step 15, 필요 시) | 백그라운드로 `sync()` 실행. 이미 실행 중이면 409. 헤더 `X-Admin-Token` 필수 |
| GET | `/api/v1/admin/runs` | 동일 | 최근 `ingest_runs` 목록 |
| POST | `/api/v1/admin/sources/{source_id}/files` | 동일 | CSV 업로드. 어댑터 `read()` 검증을 통과한 파일만 `raw/<source_id>/`에 저장하고 dry-run 결과를 반환 |

```python
class SearchFilters(BaseModel):
    ministries: list[str] = []
    life_stages: list[str] = []
    households: list[str] = []
    interests: list[str] = []
    online_only: bool = False

class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    filters: SearchFilters = SearchFilters()
    top_n: int = Field(5, ge=1, le=10)
```

### SSE 이벤트 순서
```
event: sources
data: {"services":[{"service_id":"WLF00001176","name":"암검진사업","url":"https://www.bokjiro.go.kr/…",
        "ministry":"보건복지부","updated_at":"2025-03-12","matched_sections":["overview"],
        "contacts":[{"label":"국민건강보험","phone":"1577-1000"},{"label":"보건복지상담센터","phone":"129"}],
        "sites":[{"label":"국가암정보센터","url":"http://www.cancer.go.kr"}]}],
       "filters_relaxed":false,"no_result":false}

event: token        ← N회
data: {"text":"**암검진사업**\n- 해당될 수 있는 이유: …"}

event: done
data: {"timings_ms":{"retrieve":140,"generate":5200}}

event: error        ← 오류 시 (done 대신)
data: {"code":"LLM_TIMEOUT","message":"응답 생성이 지연되고 있습니다. 잠시 후 다시 시도해 주세요."}
```
`sources`의 `sites`는 상위 3개까지만 보냅니다. 전체 목록은 `/api/v1/services/{id}`로 조회합니다.

### 크롬 확장에서 호출하기
| 항목 | 결정 | 이유 |
|---|---|---|
| 호출 위치 | **사이드패널 페이지**(React)에서 직접 `fetch`합니다. 백그라운드 서비스 워커를 거치지 않습니다 | MV3 서비스 워커는 30초 동안 이벤트가 없을 때, fetch 응답이 30초 넘게 오지 않을 때, 요청 하나가 5분을 넘길 때 종료될 수 있습니다. CPU 추론으로 긴 답변을 스트리밍하다가 끊길 위험이 있습니다 |
| 스트림 수신 | `fetch` + `response.body.getReader()` + `TextDecoder`로 받아, 빈 줄(`\n\n`) 단위로 나눈 뒤 `event:`와 `data:`를 파싱합니다 | `/api/v1/chat`은 POST라 `EventSource`(GET 전용)를 쓸 수 없습니다 |
| 권한 | manifest `host_permissions`에 백엔드 origin을 넣습니다. 개발 빌드는 `http://localhost:8000/*`, 배포 빌드는 `https://<공개 도메인>/*` | 확장 페이지는 `host_permissions`에 있는 주소를 CORS 제약 없이 호출할 수 있습니다 |
| content script | 백엔드 호출에 쓰지 않습니다 | content script는 방문 중인 웹페이지 origin의 CORS 규칙을 따릅니다 |
| CORS | 백엔드 `CORSMiddleware`에 `CORS_ORIGINS`(쉼표 구분, `chrome-extension://<ID>`)를 등록합니다 (Step 9) | 주 수단은 `host_permissions`이고, CORS는 권한이 빠졌을 때를 대비한 보조입니다. CORS는 인증이 아니므로 API 보호 수단으로 쓰지 않습니다 |
| 중단 | 사이드패널을 닫거나 사용자가 중지하면 `AbortController`로 요청을 취소합니다. 백엔드는 클라이언트 연결이 끊기면 Ollama 스트림을 멈춥니다 (Step 12) | CPU 추론은 비싸므로, 아무도 읽지 않는 답변을 끝까지 생성하지 않습니다 |

---

## 11. 평가

### 11.1 golden set (`BackEnd/eval/golden.jsonl`)
CSV 실제 서비스 ID로 만든 시드 15개입니다. 30문항 이상으로 늘려서 쓰세요.
```jsonl
{"q":"기초연금 신청하고 싶어요","expected":["WLF00001164"],"type":"name"}
{"q":"65세 넘은 부모님이 매달 받을 수 있는 연금","expected":["WLF00001164"],"type":"situation"}
{"q":"중증장애인인데 생활비로 받는 연금이 있나요","expected":["WLF00003249"],"type":"situation"}
{"q":"갑자기 수술해야 하는데 병원비가 없어요","expected":["WLF00003179"],"type":"situation"}
{"q":"겨울 난방비가 너무 부담돼요","expected":["WLF00000072","WLF00001162"],"type":"situation"}
{"q":"혼자 아이 키우는 엄마인데 양육비 지원 있나요","expected":["WLF00001068"],"type":"situation"}
{"q":"보육원에서 나와 혼자 살게 된 청년 지원","expected":["WLF00001175","WLF00005445"],"type":"situation"}
{"q":"부모님 치매 검사 비용 지원","expected":["WLF00005004"],"type":"situation"}
{"q":"일하다 다쳤는데 원래 회사로 돌아가고 싶어요","expected":["WLF00001085"],"type":"situation"}
{"q":"결혼이민자 통역 도움 받을 수 있나요","expected":["WLF00003175"],"type":"situation"}
{"q":"돌 안 된 아기 키우는 집에 주는 돈","expected":["WLF00004657","WLF00001171"],"type":"situation"}
{"q":"참전유공자 수당","expected":["WLF00001066"],"type":"name"}
{"q":"월세 내기 힘든 저소득층 주거비 지원","expected":["WLF00003201"],"type":"situation"}
{"q":"고용보험 없는 프리랜서인데 출산했어요","expected":["WLF00000838"],"type":"situation"}
{"q":"오늘 서울 날씨 어때","expected":[],"type":"negative"}
```
> 전처리에서 만든 alias와 name_keys를 검증하는 문항도 추가하세요.
> ```jsonl
> {"q":"K-패스 환급 받고 싶어요","expected":["WLF00005440"],"type":"name"}
> {"q":"두루누리 지원 받을 수 있나요","expected":["WLF00000095"],"type":"name"}
> {"q":"독립유공자 손자녀 지원금","expected":["WLF00003209"],"type":"name"}
> ```
> 뒤의 두 문항은 이름 사전 키(`두루누리사회보험료지원사업`, `독립유공자손자녀생활지원금`)가 질문 키 안에 통째로 들어 있지 않아 **pin이 걸리지 않습니다.** 키워드와 dense 검색만으로 찾아내는지 확인하는 문항입니다. 여기서 틀리면 Phase 2에서 "질문 키가 사전 키의 앞부분과 일치하면 매칭"하는 방식을 검토합니다.

> **데이터가 바뀌면**: `run_retrieval`은 실행 전에 `expected`의 서비스가 활성 상태인지 확인합니다. 비활성화된 ID가 있으면 경고를 출력하고 그 문항을 집계에서 뺍니다. 새 스냅샷을 반영한 뒤에는 평가를 다시 돌려서 이전 결과와 비교합니다.

### 11.2 지표 (`python -m eval.run_retrieval --mode hybrid`)
| 지표 | 정의 | 초기 목표 (측정 후 조정) |
|---|---|---|
| Recall@5 | expected 중 하나라도 Top 5에 있으면 1 | CSV만 쓸 때 0.70 이상, 보강 후 0.85 이상 |
| MRR@10 | 첫 정답 순위의 역수 평균 | 0.6 이상 |
| 무응답 정확도 | negative 문항에서 `no_result=True`인 비율 | 0.9 이상 |
| 무응답 오탐 | 정상 문항에서 `no_result=True`인 비율 | 0.05 이하 |

### 11.3 실험 순서 (한 번에 하나씩 바꾸고 표로 기록)
1. dense만 쓸 때와 hybrid(RRF)를 비교합니다.
2. 이름 pin을 켤 때와 끌 때를 비교합니다.
3. overview만 쓸 때와 섹션 청크를 추가했을 때(보강 전후)를 비교합니다.
4. `MIN_DENSE_SIM`을 0.35~0.60 범위에서 sweep합니다.
5. `MAX_CHARS`를 300, 500, 800으로 바꿔 봅니다.
6. `bge-m3`와 `KURE-v1`을 비교합니다 (같은 1024차원이므로 `--rebuild`만 하면 됩니다).

---

## 12. 바이브코딩 실행 계획

> 워크플로: welfare_helper에서 Claude Code를 열고 `/clear`, `/model sonnet`을 한 뒤 **한 단계씩** 붙여 넣습니다. 테스트가 통과하면 커밋합니다. 같은 오류로 3번 실패하면 Opus로 넘깁니다.
> 모든 명령은 §3.4처럼 인프라(`docker compose up -d`)를 띄운 뒤 호스트의 `.venv`에서 `cd BackEnd` 후 실행합니다.
> 🔐 **비밀값 보호**: 도구 출력은 대화에 포함됩니다. Claude가 `.env`·`.env.prod`를 읽거나 `env`, `printenv`, `docker compose config`, `docker compose exec … env`처럼 환경변수 값을 출력하는 명령을 실행하려고 하면 승인하지 마세요. 코드는 변수 **이름**만 알면 되고, 값은 실행 시점에 `.env`에서 읽힙니다. 키가 한 번이라도 출력되었다면 즉시 재발급(rotate)합니다.

### Step 0: 사전 준비 (사람이 직접)
- [x] 설계서, 피처 문서, 이전 전체 계획을 `welfare_helper/docs/`에 복사
- [x] CSV를 `data/raw/bokjiro_central/20250722.csv`로 배치 (원본 CP949 그대로)
- [x] `data/sources.toml` 작성 (소스 `bokjiro_central` 1개)
- [x] 같은 CSV를 테스트용 고정 fixture `BackEnd/tests/fixtures/bokjiro_central_20250722.csv`로 배치
- [x] 임베딩·동기화 단계에 필요한 `BackEnd/` 뼈대 생성. 각 파일의 docstring이 담당 역할, 설계 절, Step을 적은 명세입니다
- [x] compose: pgvector 이미지, 경로 대소문자, `./data:/app/data` 볼륨
- [x] 하이브리드 전환: devcontainer 제거, 개발 `docker-compose.yml`(인프라만) + `.env` / 배포 `docker-compose.prod.yml` + `.env.prod`
- [x] 호스트에 Python 3.12 `.venv` 생성 후 `pip install -r requirements.txt`
- [x] 개발 포트를 postgres `5433`, ollama `11435`로 변경 (네이티브 PostgreSQL 18·Ollama와 충돌 회피, §3.1)
- [x] 임베딩 모델 확정: `OLLAMA_EMBED=bge-m3` (`.env` 반영됨)
- [x] `requirements.txt` 정리 (§3.3), `.env.example`·`.env.prod.example`에 §3.1 키 전부 반영
- [x] `docker compose up -d --build` (2026-09-19 확인: postgres healthy, ollama 기동, `vector 0.8.3`)
- [x] 모델 준비: 자동 pull로 `bge-m3`, `gemma3:4b`가 받아졌습니다. 확인은 `docker compose exec ollama ollama list`. 수동 pull은 필요 없습니다
- [x] 공공데이터포털 활용신청을 하고 Decoding 키를 `.env`에 등록. `.env.example`·`.env.prod.example`의 키 줄을 빈 값으로 정리
- [x] 프론트엔드 형태 결정: React 크롬 확장 (MV3 사이드패널, `extension/`). CLAUDE.md 반영 (§2.3)
- [x] `.gitignore`에 확장 규칙 추가 (`node_modules/`, `extension/dist/`, `extension/.env*`, `*.zip`, `*.pem`)
- [x] LLM 확정 (현재 `gemma3:4b`. Step 11 전까지)
- [ ] `.dockerignore`에 `extension/` 추가 (§3.5. 확장 폴더를 만들기 전에)
- [ ] 호스트에 Node.js LTS 설치 (확장 개발을 시작하기 전에, §3.5)

### Step 1: 설정, DB 연결, 스키마
**파일**: `core/config.py`, `core/db.py`, `db/schema.sql`, `scripts/init_db.py`, `main.py`
```
@docs/welfare-rag-pipeline-design.md §2, §3, §7.1, §7.2, §10(/health)을 읽고 Step 1만 구현해줘.
- BackEnd/가 import 루트. core/config.py는 pydantic-settings로 §3.1 키 전부 로드.
  env_file은 Path(__file__) 기준 저장소 루트의 .env
- schema.sql은 §7.1의 세 테이블(welfare_services, welfare_chunks, ingest_runs)과 인덱스. IF NOT EXISTS로 재실행 안전하게
- core/db.py는 지연 생성 ThreadedConnectionPool + 연결별 1회 register_vector + get_lock_conn() (§7.2)
- scripts/init_db.py는 register_vector 없이 일반 연결로 schema.sql 실행
- main.py의 /health에 db 상태 추가. 연결·register_vector 실패는 잡아서 "db": "error"
- 뼈대 파일이 이미 있으니 각 파일의 docstring을 명세로 삼아 채울 것 (파일 새로 만들지 말 것)
- requirements.txt와 .env.example은 이미 반영되어 있으니 건드리지 말 것
완료되면 init_db 실행 결과와 \d welfare_chunks 출력을 보여주고 멈춰.
```
**완료 기준**: 세 테이블이 생성되고 `embedding`이 `vector(1024)`입니다. `/health`의 `db`가 `ok`이고, postgres를 멈춘 상태에서도 앱이 뜨며 `/health`가 `"db": "error"`를 돌려줍니다.

### Step 2: 공통 기반 (텍스트 정규화, 레코드, 소스 등록부)
**파일**: `ingest/text_clean.py`, `ingest/records.py`, `ingest/sources.py`, `ingest/adapters/base.py`, `tests/test_text_clean.py`, `tests/test_sources.py`
```
@docs/welfare-rag-pipeline-design.md §4.1, §4.2(프로토콜), §5.3, §5.9를 읽고 Step 2만 구현해줘.
- clean_text(): §5.3 코드 그대로. NFKC 사용 금지
- records.py: ServiceRecord(to_json/from_json), record_hash(source_file·enriched_at 제외), PIPELINE_VERSION
- sources.py: tomllib로 sources.toml 로드·검증(id 중복, 없는 adapter, 잘못된 mode),
  select_files(source, file=None), fingerprint(...), encoding="auto"(utf-8-sig → cp949)
- adapters/base.py: SourceAdapter Protocol과 ADAPTERS 등록표 (구현체는 Step 3)
테스트 (tmp_path에 임시 소스 폴더를 만들어서):
  clean_text('감면&middot;면제') == '감면·면제', clean_text('  a   b ') == 'a b', clean_text('   ') is None,
  '유산ㆍ사산'이 clean_text 후에도 U+318D 유지,
  snapshot은 파일명이 가장 큰 1개, delta는 전체를 오름차순, '_overrides.csv'는 입력에서 제외,
  파일 내용이나 exclude_ids가 바뀌면 fingerprint가 바뀜, source_file만 다른 두 레코드의 record_hash는 같음.
```
**완료 기준**: 테스트가 통과합니다.

### Step 3: 복지로 어댑터와 전처리
**파일**: `ingest/parsers.py`, `ingest/adapters/bokjiro_csv.py`, `ingest/preprocess.py`, `tests/test_bokjiro_adapter.py`
```
@docs/welfare-rag-pipeline-design.md §4.2, §5 전체를 읽고 Step 3만 구현해줘 (--enrich는 아직 빼고).
- parsers.py: 서비스명 파서(깊이 카운트), key(), sites/contacts 파서, 반복 라벨 제거
- bokjiro_csv.py: read()는 헤더·키 검증, to_records()는 §5 B1~B4
- preprocess.py: 소스 1개 → processed/{source_id}.jsonl + reports/{source_id}/{파일명}.json, exclude_ids 적용, delta 병합
테스트는 반드시 tests/fixtures/bokjiro_central_20250722.csv로 (data/raw 사용 금지). §5 실측치 그대로 assert:
  367행, target_hint 12, aliases 34, 사이트 결측 35, contacts 전화번호 있는 행 364, anomalies 2건,
  summary 중복 groups 2/rows 8,
  '모성보호육아지원(출산전후휴가(유산ㆍ사산휴가 포함) 급여, 육아휴직등 급여)'.base_name == '모성보호육아지원',
  '대중교통비 환급 지원(K-패스)'.name_keys에 'k패스' 포함,
  WLF00001176 레코드가 §5.9 JSON과 동일,
  헤더가 하나 빠진 CSV는 빠진 컬럼명을 담은 예외.
python -m ingest.preprocess --source bokjiro_central 실행 후 리포트를 보여주고 멈춰.
```
**완료 기준**: 테스트가 통과하고, 리포트 수치가 §5.8과 같습니다.

### Step 4: OpenAPI 보강
**파일**: `ingest/enrich.py`, `tests/fixtures/detail_WLF00003249.xml`, `tests/test_enrich.py`
```
@docs/welfare-rag-pipeline-design.md §4.3, §5.7을 읽고 Step 4만 구현해줘.
1) 먼저 WLF00003249 한 건만 실제 호출해 캐시에 저장하고, 필드명을 §4.3 매핑과 대조한 결과를 보여줘. 다르면 멈춰.
2) 일치하면 캐시 5건의 원문 서식을 보여주고, §5.7 정제 규칙에 보정할 점이 있는지 제안해줘.
3) 이후 수집·파싱·정제와 §4.3의 재수집 조건, 키 보호를 구현하고 preprocess --enrich에 통합.
   테스트는 fixture XML로 (네트워크 없이): 캐시가 최신이면 호출 0회, 최종수정일이 캐시보다 늦으면 1회,
   가짜 키로 실패 응답을 흉내 냈을 때 로그(caplog)와 예외 메시지에 키 값이 나오지 않음.
주의: .env를 읽거나 키 값을 출력하는 명령은 실행하지 말 것. 실제 호출 결과는 servId와 응답 필드명만 보여줄 것.
```
**완료 기준**: fixture 테스트가 통과하고, 리포트의 `enrich` 항목이 채워집니다.

### Step 5: 청커
**파일**: `ingest/chunker.py`, `tests/test_chunker.py`
```
@docs/welfare-rag-pipeline-design.md §6을 읽고 Step 5만 구현해줘. build_chunks(rec) 순수 함수.
테스트: (a) 보강 없는 레코드 → overview 1개, target_hint 있으면 '태그: 대상=…' 포함
       (b) 1,200자 target → 헤더 반복된 3개 조각, 본문 ≤500자, 1줄 overlap
       (c) criteria == target 이면 생략 (d) 20자 미만 섹션 생략 (e) 모든 청크에 서비스명 포함
```
**완료 기준**: 테스트가 통과하고, fixture 전체로 만든 청크가 367개입니다.

### Step 6: 임베더와 토크나이저
**파일**: `services/embedder.py`, `services/tokenizer.py`, `tests/test_embedder.py`
```
@docs/welfare-rag-pipeline-design.md §7.3, §7.4를 읽고 Step 6만 구현해줘.
테스트(mark 'ollama'): shape (n,1024), L2 norm ≈ 1,
  cos("기초연금","노인에게 매달 주는 연금") > cos("기초연금","산림 가꾸기 일자리"),
  tokenize("장애인연금 신청 방법") 에 '장애인','연금' 포함.
```
**완료 기준**: 테스트가 통과합니다.

### Step 7: 인덱서
**파일**: `ingest/index.py`, `tests/test_index.py`
```
@docs/welfare-rag-pipeline-design.md §7.5를 읽고 Step 7만 구현해줘.
apply(source, records, run_id, dry_run, rebuild, allow_mass_delete) -> Stats.
레코드 diff 5분류, 대량 제외 가드, ID 충돌 검사, 청크 content_hash diff, 서비스 단위 트랜잭션, 비활성화는 마지막에.
테스트(mark 'db', 임베더는 가짜로 바꿔서 호출 횟수를 셈):
  3건 적용 → added 3 / 같은 3건 재적용 → unchanged 3, 임베딩 호출 0
  1건 요약 변경 → updated 1, 그 서비스의 overview 청크만 재임베딩
  snapshot에서 1건 빠짐 → deactivated 1, 청크 삭제, 서비스 행은 남음 / 다시 들어오면 reactivated
  10건 중 3건 빠짐(30%) → aborted, DB 변경 없음 / allow_mass_delete=True면 적용
  다른 source_id가 가진 ID → 실패
```
**완료 기준**: 테스트가 통과합니다.

### Step 8: 동기화 CLI
**파일**: `ingest/sync.py`, `tests/fixtures/sync/` (소형 CSV), `tests/test_sync.py`
```
@docs/welfare-rag-pipeline-design.md §4.1, §7.6, §7.7을 읽고 Step 8만 구현해줘.
advisory lock(core.db.get_lock_conn() 전용 연결에서 잡고 finally에서 unlock + close. get_conn() 사용 금지),
지문 비교로 건너뛰기(해당 소스의 직전 succeeded 실행 기준), ingest_runs 기록,
--source/--dry-run/--file/--enrich/--refresh/--rebuild/--allow-mass-delete, 종료 코드.
tests/fixtures/sync/에 복지로 형식 CSV 두 개를 만들어줘: v1(5건), v2(v1에서 1건 수정, 1건 추가, 1건 삭제).
테스트(mark 'db'): v1 sync → added 5 / 그대로 재실행 → 건너뜀(새 run 없음)
      / v2 dry-run → DB 불변, diff 출력 / v2 sync → updated 1, added 1, deactivated 1
      / --file로 v1 지정(롤백) → reactivated 1 / 잠금을 잡은 상태에서 실행 → 종료 코드 2.
마지막으로 실제 데이터로 python -m ingest.sync 를 두 번 연속 실행한 출력을 보여줘.
```
**완료 기준**: 테스트가 통과합니다. 실제 데이터 첫 실행에서 `added=367`, `chunks.embedded=367`이 나오고, 두 번째 실행은 "변경 없음"으로 건너뜁니다.

### Step 9: 검색과 `/search`
**파일**: `services/retriever.py`, `schemas/rag.py`, `routers/search.py`, `main.py`, `tests/test_retriever.py`
```
@docs/welfare-rag-pipeline-design.md §8, §10을 읽고 Step 9만 구현해줘.
이름 사전 pin(name_keys, 최대 3) + dense + keyword + RRF + 서비스 집계 + 임계값 + 필터 완화.
활성 서비스만 검색하고, index_version이 바뀌면 이름 사전을 다시 로드(최대 30초에 한 번 확인).
라우터는 async def + run_in_threadpool.
main.py에 CORSMiddleware 추가: CORS_ORIGINS(쉼표 구분)만 허용. 비어 있으면 CORS 미등록.
테스트: "기초연금" top1 == WLF00001164, "K-패스 환급 받고 싶어요" top1 == WLF00005440 (alias pin),
       "의료급여" 결과 pinned ≤ 3, "오늘 서울 날씨 어때" → no_result=True,
       비활성화한 서비스는 이름으로 검색해도 결과에 없음.
```
**완료 기준**: 테스트가 통과하고, `curl`로 `/api/v1/search`를 호출하면 JSON이 돌아옵니다.

### Step 10: 평가 하네스
**파일**: `eval/golden.jsonl`, `eval/run_retrieval.py`
```
@docs/welfare-rag-pipeline-design.md §11을 읽고 Step 10만 구현해줘.
--mode {dense,hybrid}, --no-pin 옵션. type별 Recall@5 / MRR@10 / 무응답 정확도 표, 틀린 문항은 Top5 출력.
expected에 비활성 서비스가 있으면 경고하고 그 문항은 집계에서 제외.
```
**완료 기준**: 모드별 결과 표를 만들고 §11 아래에 기록합니다.

### Step 11: LLM 클라이언트와 프롬프트 빌더
**파일**: `services/llm.py`, `services/prompt_builder.py`, `tests/test_prompt_builder.py`
```
@docs/welfare-rag-pipeline-design.md §9.1~9.4를 읽고 Step 11만 구현해줘.
prompt_builder: 예산 초과 시 하위 순위부터 절단, matched_sections는 마지막에 절단, 빈 필드 줄 생략,
                문의는 contacts 중 phone 있는 것 최대 2개.
llm.stream_chat(messages) -> AsyncIterator[str].
테스트: 컨텍스트 길이 ≤ CONTEXT_CHAR_BUDGET, 보강 없는 서비스 블록에 '지원대상:' 줄 없음.
```
**완료 기준**: 테스트가 통과하고, 스크립트로 질문 1개를 넣었을 때 토큰이 스트리밍됩니다.

### Step 12: `/chat` SSE와 가드레일
**파일**: `services/rag.py`, `routers/chat.py`, `routers/services.py`, `main.py`, `tests/test_chat.py`
```
@docs/welfare-rag-pipeline-design.md §9.5, §10을 읽고 Step 12만 구현해줘.
SSE 순서 sources → token* → done (오류 시 error). sources의 sites는 상위 3개.
no_result면 LLM 호출 없이 고정 문구. 위기어 감지 시 109/129 고정 안내 선행.
클라이언트 연결이 끊기면(request.is_disconnected) Ollama 스트림을 닫고 생성을 멈춤.
/health 확장(db, ollama, 모델 존재, index: 활성 서비스 수·청크 수·마지막 동기화 시각). 테스트는 LLM을 mock으로.
```
**완료 기준**: `curl -N -X POST localhost:8000/api/v1/chat -H "Content-Type: application/json" -d '{"query":"중증장애인 연금"}'`을 실행했을 때 sources, token, done이 순서대로 오고, 날씨 질문에서는 LLM이 호출되지 않습니다.

### Step 13: 튜닝 (Opus 권장)
```
eval 결과 표를 보고 §11.3 실험 1→6 순서로 파라미터를 조정해줘. 변경마다 표에 한 줄씩 기록.
```

### Step 14 (필요 시): 형식이 다른 CSV 소스와 수동 보정
형식이 다른 CSV를 추가하거나, 원본을 고치지 않고 특정 필드를 바로잡아야 할 때 진행합니다.
**파일**: `ingest/adapters/mapped_csv.py`, `ingest/preprocess.py`, `tests/test_mapped_csv.py`, `tests/test_overrides.py`
```
@docs/welfare-rag-pipeline-design.md §4.1, §4.2, §7.7을 읽고 Step 14만 구현해줘.
1) mapped_csv 어댑터: sources.toml의 [sources.columns]로 표준 필드와 CSV 컬럼을 매핑.
   필수는 service_id·name·summary, 나머지는 선택. service_id에 id_prefix 적용, 파서는 parsers.py 재사용.
2) _overrides.csv(service_id, field, value, note): 허용 필드만 덮어쓰고, site_raw·contact_raw를 바꾸면 다시 파싱.
   적용 내역은 리포트에 기록.
테스트: 매핑 CSV 3건 → ServiceRecord 3건, 필수 컬럼 누락 시 예외,
       override 적용 → record_hash 변경 → sync에서 updated 1.
```
**완료 기준**: 테스트가 통과하고, `sources.toml`에 예시 소스를 추가해 `sync --dry-run`하면 diff가 나옵니다.

### Step 15 (필요 시): 관리자 API
서버에서 CSV 업로드와 동기화를 하거나, 스케줄러로 자동 실행하고 싶을 때 진행합니다.
**파일**: `routers/admin.py`, `main.py`, `requirements.txt`, `tests/test_admin.py`
```
@docs/welfare-rag-pipeline-design.md §7.6, §10을 읽고 Step 15만 구현해줘.
- X-Admin-Token 검증은 hmac.compare_digest로. ADMIN_TOKEN이 비어 있으면 admin 라우터 자체를 등록하지 않음
- POST /api/v1/admin/sync: BackgroundTasks로 sync() 실행, 잠금 실패면 409
- GET /api/v1/admin/runs: 최근 ingest_runs
- POST /api/v1/admin/sources/{source_id}/files: 어댑터 read() 검증을 통과한 파일만
  raw/<source_id>/YYYYMMDD.csv로 저장하고 dry-run 결과 반환
- requirements.txt에 python-multipart 추가
```
**완료 기준**: 테스트가 통과하고, 토큰 없이 호출하면 401, 동기화 중에 다시 호출하면 409가 나옵니다.

---

## 13. 리스크와 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| 모델 자동 pull이 조용히 실패 (`.env` 값 오타나 공백) | 모델 없이 기동해 Step 6~8의 임베딩 호출에서야 드러남 | `script.sh`가 `Pull failed, continuing without it`으로 넘기므로, 모델을 바꾼 뒤에는 `ollama list`로 확인합니다. 빈 값은 배포 compose의 `:?`가 막지만 오타는 막지 못하고, 개발 compose는 빈 값도 막지 않습니다 (§3.2 #6) |
| 웹스토어 심사 지연이나 반려 (권한 사유·개인정보처리방침 누락, 넓은 `host_permissions`) | 시연 일정까지 배포가 안 됨 | `host_permissions`를 백엔드 도메인 하나로 한정하고, Privacy 탭을 빠짐없이 채우고, 여유 있게 먼저 제출한 뒤 심사 후 수동 게시를 씁니다 (§3.5) |
| 웹스토어 공개 후에도 백엔드가 HTTP로 열려 있음 | 사용자의 장애·소득·가구 정보가 평문으로 전송 | 공개 전에 HTTPS 리버스 프록시를 둡니다 (§3.2 #12) |
| 서비스 워커에서 스트리밍 호출 | MV3 서비스 워커가 종료되어 답변이 중간에 끊김 | 사이드패널 페이지에서 직접 `fetch`합니다 (§10) |
| 확장 빌드에 비밀값이 들어감 | 누구나 확장 파일을 열어 값을 볼 수 있음 | 확장에는 공개 값(`VITE_API_BASE_URL`)만 넣고, 관리자 토큰·API 키는 백엔드에만 둡니다 (§3.5) |
| 확장 ID가 개발과 배포에서 다름 | `CORS_ORIGINS`가 한쪽에서만 맞음 | 웹스토어 공개키를 개발용 manifest `key`에 넣어 ID를 고정합니다. 첫 업로드 zip에서는 `key`를 뺍니다 (§3.5) |
| API `servId`나 필드명이 이 문서와 다름 | 보강 실패 | Step 4에서 1건을 먼저 호출해 대조합니다 |
| 공공데이터포털 일일 트래픽 한도 | 보강 중단 | 원본 캐시를 남기고 이어서 실행할 수 있게 합니다 |
| 전처리 파서 회귀 (다음 연도 CSV 형식 변경) | 연락처나 링크가 조용히 누락 | 고정 fixture로 실측치를 assert하고, 새 스냅샷은 리포트끼리 비교하며, 원문(`*_raw`)을 보존합니다 |
| 잘리거나 잘못 받은 CSV를 반영 | 서비스 대부분이 검색에서 사라짐 | 대량 제외 가드(20%)와 `--dry-run` 검토, `--file` 롤백 (§7.5~7.7) |
| 포털 CSV의 헤더 변경 (컬럼 추가·이름 변경) | 전처리 실패 또는 필드 누락 | 어댑터가 헤더를 정확히 검증하고, 빠진 컬럼과 남는 컬럼을 나열하며 실패합니다. DB는 바뀌지 않습니다 |
| 소스 간 서비스 ID 충돌 | 다른 서비스를 덮어씀 | `id_prefix` 규칙과 적용 직전 충돌 검사 (§4.2) |
| 동기화 두 개가 동시에 실행됨 (CLI와 API) | 중복 임베딩, 꼬인 상태 | PostgreSQL advisory lock (§7.6) |
| 동기화 후에도 검색이 옛 데이터를 씀 | 새 서비스가 pin되지 않음 | `index_version`이 바뀌면 이름 사전을 다시 로드 (§7.6, §8.1) |
| 보강 캐시가 오래됨 | 바뀐 자격기준을 옛 내용으로 안내 | CSV의 최종수정일이 캐시보다 늦으면 재수집 (§4.3) |
| 원본 데이터 오류 (전화번호 오기 등) | 잘못된 번호 안내 | 수정하지 않고 리포트에 남깁니다. 응답에는 파싱된 번호만 쓰고, 이상 항목은 번호 없이 라벨만 보여 줍니다 |
| 선정기준이 해마다 바뀜 | 오래된 정보 안내 | 답변에 기준일을 표기하고, 새 스냅샷을 `raw/<source_id>/`에 추가해 sync합니다 (바뀐 것만 반영) |
| Ollama를 CPU만으로 추론 | 응답 지연 | §3.2 #8 GPU 설정, `num_predict` 제한, 필요하면 더 작은 LLM으로 교체 (`OLLAMA_LLM` 값만 변경) |
| 의료급여 8건이 요약 문장 2개를 공유 | 검색 순위가 뒤섞임 | 서비스명을 임베딩에 포함하고, pin은 3개로 제한하며, 보강 섹션으로 구분합니다 |
| 임베딩 모델 교체 | 벡터가 섞여 호환되지 않음 | hash에 모델명을 포함하고, 교체 시 `--rebuild`합니다 |
| 중앙부처 서비스만 포함 | 지자체 서비스 질문에 답할 수 없음 | 답변 하단에 범위를 고지합니다 |
| LLM이 자격을 단정함 | 사용자 오판 | 시스템 프롬프트 규칙 2를 두고, 평가 때 샘플 10개를 수동 점검합니다 |

---

## 14. Phase 2 (MVP 이후)

- **멀티턴**: 대화 이력으로 후속 질문을 독립 질문으로 재작성합니다 ("그거 신청 어떻게 해?" → "장애인연금 신청 방법").
- **질의 분석**: Ollama structured output(`format`에 JSON schema)으로 `{생애주기, 가구상황, 관심주제, 의도}`를 추출해 soft boost합니다.
- **재순위**: `BAAI/bge-reranker-v2-m3`로 Top 20을 다시 정렬합니다 (평가상 이득이 있을 때만).
- **사용자 프로필**: 나이, 가구, 소득 구간을 입력받아 필터를 자동으로 채웁니다.
- **지자체 서비스 확장**: `지자체복지서비스` API나 CSV를 `sources.toml`에 새 소스로 등록합니다. 형식이 맞으면 `mapped_csv`로, 아니면 전용 어댑터로 처리합니다. 검색 필터에 `source_id`를 추가합니다.
- **정기 자동 동기화**: 포털 CSV를 주기적으로 받는다면, 스케줄러(cron, Windows 작업 스케줄러)가 Step 15의 `/admin/sync`를 호출하게 합니다. 폴더 감시 방식은 쓰지 않습니다 (§7.8).
