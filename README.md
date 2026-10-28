# welfare_helper
캡스톤 프로젝트 - 복지서비스 AI챗봇

## 구성
| 위치 | 내용 |
|---|---|
| `FrontEnd/` | React + Vite 웹 (이용자 `/`, 관리자 `/admin`) |
| `BackEnd/` | FastAPI. `POST /api/v1/chat`, `/health`, `/health/db` |
| `BackEnd/ingest/` | CSV 메타데이터 확인 전용, 문서 등록은 `BackEnd/documents/` |
| `FrontEnd/vercel.json` | Vercel 프런트 전용 빌드와 SPA 경로 재작성 |

## 준비
1. Docker 실행에서는 아래 단일 Compose 명령이 Ollama 모델과 리랭커 캐시를 준비합니다. 호스트에서 직접 실행할 때만 사용할 Ollama 모델을 별도로 준비합니다.
2. 저장소 루트의 `.env.example`을 참고해 환경을 준비합니다. 사용자가 관리하는 루트 `.env`를 Compose와 Vite가 사용하며 접속 문자열·키는 저장소에 넣지 않습니다. `FrontEnd/.env`는 사용하지 않습니다.
3. 호스트에서 직접 실행할 때 파이썬 의존성: `pip install -r requirements.txt pytest`. Docker 실행은 이미지 빌드에서 설치합니다.
4. 프론트 의존성: `cd FrontEnd && npm ci`. 현재 Vercel 프런트 빌드와 정적 산출물 빌드를 유지합니다.

### 환경변수 적용 기준

현재 Supabase + Docker 구성에서는 `DATABASE_URL`과 별도 `DATABASE_PASSWORD`를 유지합니다. `DATABASE_MODE=supabase`, `INGEST_ON_STARTUP=false`로 정리하며 CSV 자동 적재는 지원하지 않습니다. `OLLAMA_LLM=qwen2.5:1.5b-instruct`, `OLLAMA_EMBED=bge-m3`, `EMBED_DIM=1024`와 고정 리랭커 모델·리비전은 현재 문서 벡터와 맞춰 사용합니다. 느린 노트북을 위한 예시 대기 시간은 `OLLAMA_TIMEOUT=600`초입니다. 예시 변경만으로 실제 런타임 설정이 바뀌지는 않습니다.

Compose는 DB 모드를 `supabase`, 시작 적재를 `false`로 고정합니다. 문서는 `DOCUMENTS_ENABLED`(기본 true)로 활성화하고 모든 환경의 관리 기능은 서버 `ADMIN_PASSWORD`로 로그인합니다. `DOCUMENTS_LOCAL_MODE`는 인증 우회에 사용하지 않습니다. `OLLAMA_BASE_URL`은 `http://ollama:11434`, `RERANK_CACHE_DIR`은 `/app/.reranker_cache`, `DOCLING_CACHE_DIR`은 `/app/.docling_cache`로 적용합니다. 코드·환경 변경 후 `docker compose up -d --build`로 반영하며 코드 bind mount·자동 reload는 사용하지 않습니다.

`LOCAL_DB_*`는 백엔드가 읽지 않으므로 삭제 권장입니다. 별도 로컬 PostgreSQL 개발이 필요할 때만 실제 이름인 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`을 사용합니다. 기본 Compose는 Supabase를 강제하므로 `--profile local`만으로 백엔드 DB가 전환되지는 않습니다. 복지로 API 키는 공식 상세 조회 유틸리티용이며 기존 PDF 채팅에는 필요하지 않습니다. `MIN_DENSE_SIM`, `MIN_RERANK_SCORE`는 기존 복지 상담·진단 경로용이고 현재 기본 PDF RAG의 점수 컷오프가 아닙니다.

Vite의 `envDir`은 설정 파일 기준 절대 경로로 저장소 루트를 가리킵니다. 기본 `VITE_` 노출 접두사를 유지하며 DB·Supabase 서버 키를 프런트에 전달하지 않습니다. `VITE_API_BASE_URL`은 채팅·제도 관리·문서 API 모두에 적용하며 로컬은 빈 값으로 두어 Vite의 `/api` 프록시를 사용합니다. 외부 서버 연결 시 `/api`를 제외한 HTTPS 기본 주소를 지정합니다. 프런트 환경변수는 빌드 시 반영되고 변경 후 Vite 재시작 또는 배포 재빌드가 필요합니다. [Vite 환경파일·노출 접두사 안내](https://vite.dev/config/shared-options#envdir)를 따릅니다.

`/admin`, `/admin/documents`, `/admin/programs`는 공통 관리자 비밀번호로 로그인합니다. 실제 비밀번호는 EC2 백엔드의 `ADMIN_PASSWORD` 환경변수에만 설정합니다. Vercel은 프런트 전용이므로 `VITE_` 변수나 브라우저 번들에 비밀번호를 넣지 않습니다. Supabase는 DB로 계속 사용하지만 관리자 이메일·사용자 계정·관리자 허용 목록 등록은 필요하지 않습니다. 기존 `VITE_ADMIN_DEMO_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`는 로그인 경로에서 사용하지 않습니다.

서버는 constant-time 비교로 비밀번호를 확인하고 32바이트 난수의 불투명 Bearer 세션을 발급합니다. 수명은 8시간, 서버 메모리에 최대 256개이며 로그아웃 시 서버에서도 폐기합니다. 단일 백엔드 프로세스의 재시작·재배포 후에는 다시 로그인해야 합니다. 로그인 실패는 서버가 보는 접속자별 60초 안에 5회까지이며 이후 429와 Retry-After를 반환합니다. 프록시 뒤에서는 같은 접속자로 묶일 수 있습니다. `ADMIN_PASSWORD`가 없으면 로그인·관리 API는 503으로 닫히며 localhost도 우회하지 않습니다.

브라우저는 비밀번호를 로그인 요청에만 사용하고 세션 토큰은 해당 탭의 sessionStorage에 보관합니다. 모든 문서·제도 API와 관리자 상담에 같은 Bearer를 전달하고 서버 `/api/v1/admin/session` 확인 후 화면을 엽니다. 401이면 해당 요청의 세션만 정리하고 공개 요청으로 재시도하지 않습니다. localhost Vite가 EC2 API를 가리켜도 동일한 서버 확인을 거칩니다. 별도 계정 생성·관리자 SQL·DDL은 수행하지 않습니다.

## CSV와 검색 근거

```cmd
python -m BackEnd.ingest.run --dry-run
```

CSV는 이름·기관·요약·문의처 등 탐색용 메타데이터다. 이 CLI는 CP949(UTF-8은 `--encoding utf-8-sig`) 파일의 형식만 확인하고 DB·모델을 호출하지 않는다. CSV 적재·`--prune`·overview 임베딩과 자동 DDL은 지원하지 않는다. 기존 DB를 옛 CSV로 덮거나 공식 자료를 자동 재투입하지 않는다. 검색 근거는 아래 문서 자동 분석·게시 경로로 등록한다.

검색은 활성 자식 원문만 대상으로 하위 의도별 벡터 `DENSE_TOP_K=30`개와 한국어 본문 BM25 `KEYWORD_TOP_K=30`개를 모으고 RRF `1/(60+순위)`로 결합합니다. `RETRIEVE_TOP_N=40`은 요청 전체 후보 상한이며 여러 의도에 균등한 기회를 줍니다. `MIN_DENSE_SIM`은 비교·진단용으로 남기고 앞단 필터에는 사용하지 않습니다. 리랭커의 `MIN_RERANK_SCORE`를 통과한 핵심 근거는 `CORE_EVIDENCE_K=6`개까지, 서비스 카드는 기존 최대 3개로 유지합니다. 필수 조건·예외 부모는 근거 수와 별개로 복원합니다. 이 수치는 미검증 초기값이며 점수는 관련성 지표로, 사실 정확도나 자격 확률이 아닙니다.

LangChain의 `ChatPromptTemplate`·`ChatOllama`·`JsonOutputParser`로 원문 인용과 확인 질문을 생성합니다. 각 사실 인용은 실제 청크 ID와 원문의 완전한 문장에 일치해야 합니다. 검증된 섹션 원문과 주변 적용 조건·예외를 함께 표시하며, 지원 금액·자격·신청 방법에는 공식 상세 섹션과 기준 정보가 필요합니다. CSV 요약만 있으면 상세 원문으로 가장하지 않고 보류합니다. 자료가 오래됐거나 잘못 수집됐을 가능성까지 제거하는 검증은 아니며 최신 자격을 확정하지 않습니다.

서비스명·괄호 안 별칭·띄어쓰기 변형을 ID에 연결하고 모호한 이름은 확인합니다. 임의의 공식 별칭을 만들어 넣지 않습니다. 명시된 서비스는 해당 ID 안에서 검색하며 문의처 질문은 DB 메타데이터만 사용합니다. 소개·금액·자격·신청 의도와 서비스 비교를 최대 3개 하위 의도로 제한하고 넘으면 범위를 묻습니다. 이전 assistant 답변은 사실 근거로 쓰지 않습니다. 본문 분석기는 [Kiwi 0.24.1](https://github.com/bab2min/kiwipiepy/releases/tag/v0.24.1)로 고정했으며 같은 분석을 문서·질의에 적용합니다. Python 3.12/Docker에서의 설치·형태소 품질은 실제 실행 검증이 필요합니다.

검색은 REPEATABLE READ의 같은 시점에 제도·문서 Markdown·게시 작업·벡터를 읽는다. 이 스냅샷의 벡터로 코사인 순위를 계산하여 요청 도중 새 문서의 벡터와 이전 본문이 섞이지 않게 한다. BM25 캐시는 스냅샷과 digest가 같을 때만 재사용하며, 교체·삭제 후 청크가 남지 않도록 요청 종료 시에도 스냅샷을 비교한다. 현재 청크나 문서가 50,000건을 넘으면 불완전한 검색을 중단한다. 전체 벡터를 읽으므로 자료 증가 시 메모리·지연 확인이 필요하다.

## 공식 상세 조회

`python -m BackEnd.ingest.details --service-id WLF00001164`는 등록된 일반 제도의 메타데이터를 기준으로 공식 API를 조회하는 읽기 경로다. `BOKJIRO_SERVICE_KEY`가 필요하고 한 번에 5개 ID까지 지정한다. `--write`는 지원하지 않으며 기존 상세·CSV 청크를 직접 만들지 않는다. 공식 조회 유틸리티와 등록 문서의 벡터 게시를 구분한다.

Docling 원문은 목표 600자·최대 800자, 실제 리랭커 tokenizer 400토큰 이내로 분할한다. 오버랩은 같은 제목 범위의 완결 문장 1개가 80자·40토큰 이내이고 다음 입력에도 들어갈 때만 사용한다. 인용은 원문 문장·필수 부모·조건·예외를 대조하며, 자동 처리됐다는 이유로 공식 정책이나 최종 자격으로 단정하지 않는다.

## Supabase와 Docker 실행
상주 백엔드가 IPv4 환경이면 [공식 연결 안내](https://supabase.com/docs/guides/database/connecting-to-postgres)에 따라 Session pooler를 검토합니다. 호스트·포트·사용자명은 실제 Connect 화면에서 가져오며 지역명으로 조합하지 않습니다. `DATABASE_URL`을 우선 사용하고 TLS를 요구합니다.

`DATABASE_URL`에는 비밀번호를 제외한 접속 주소를 넣고 `DATABASE_PASSWORD`에 비밀번호를 별도로 주입할 수 있습니다. 예를 들어 `postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres` 형태이며, 실제 호스트·사용자명은 Connect 값을 사용합니다. 비밀번호는 URI 문자열에 이어 붙이지 않고 psycopg2의 password 인자로 전달하므로 예약 문자를 인코딩할 필요가 없습니다. 기존 비밀번호 포함 URL도 지원하며, `DATABASE_PASSWORD`가 있으면 그 값이 우선됩니다. 로컬 DB_* 경로의 `DB_PASSWORD`는 그대로 유지합니다.

```cmd
docker compose up -d --build
```

노트북과 컴퓨터 모두 이 명령 하나로 backend·ollama·document-worker를 실행합니다. 장비별 Compose 파일이나 모드 선택은 없습니다. 기본 Compose에 `DATABASE_MODE=supabase`, `INGEST_ON_STARTUP=false`를 적용하므로 로컬 PostgreSQL을 시작하지 않고 공용 DB의 CSV 적재·스키마 변경도 수행하지 않습니다. 연결 값이 없으면 로컬 DB로 대체하지 않고 설정 오류로 종료합니다.

모델을 바꿀 때는 사용자가 `.env`의 `OLLAMA_LLM` 이름 하나만 수정합니다. 예를 들어 `qwen2.5:1.5b-instruct` 또는 `gemma3:4b`를 지정하면 backend의 선택 모델과 Ollama 준비 목록에 같은 값이 전달됩니다. 모델 이름으로 정확도나 GPU 사용 가능성을 보장하지 않습니다. 선택 모델이 없으면 기존 Ollama 시작 스크립트가 다운로드할 수 있습니다.

공통 2GB 메모리·2 CPU 상한은 두지 않습니다. 실행 가능한 모델 크기는 장비와 Docker의 가용 자원에 달려 있으며, 메모리가 부족하면 실행 실패나 시간 초과가 발생할 수 있습니다. Ollama의 동시 추론과 동시 적재 모델은 각각 1개로 제한합니다. 컨텍스트·출력·스레드·검색 후보 수는 장비별 분기 없이 기존 `LLM_NUM_CTX`, `LLM_NUM_PREDICT`, `LLM_NUM_THREAD`, `RETRIEVE_TOP_N` 설정과 앱 기본값을 사용합니다.

수정 후 Windows CMD의 저장소 루트에서 위와 같은 Compose up 명령을 다시 실행해 backend·ollama 설정을 재적용합니다. `.env` 저장이나 `docker restart`만으로 환경변수 갱신을 보장할 수 없습니다. Compose up은 변경된 컨테이너를 재생성할 수 있으며, 기존 `ollama_data/`, `postgres_data/`, 리랭커 캐시 마운트는 유지합니다. `down -v`나 데이터 폴더 초기화는 하지 않습니다. 생성 LLM만 바꾸고 임베딩 모델·청크 내용이 같으면 재임베딩할 필요가 없습니다. Supabase·bge-m3 1024차원·리랭커 모델/리비전/임계값/캐시는 그대로 사용합니다.

기존 로컬 PostgreSQL 서비스 정의와 데이터 경로는 보존하지만 기본 실행 대상에는 포함하지 않습니다. 로컬 DB를 직접 사용하는 별도 개발 실행에서는 공용 DB 설정과 구분해야 합니다.

공용 테이블은 Data API의 노출 스키마·`anon`/`authenticated` grants·RLS 정책을 함께 확인해야 합니다. RLS를 켜고 정책을 주지 않으면 기존 Data API 접근이 차단됩니다. 다른 파트의 직접 호출 여부를 조율한 뒤 공공 자료 읽기 정책과 서버 전용 쓰기 권한을 정하며, 백엔드 시작 코드에서 권한을 일괄 변경하지 않습니다.

## 문서 자동 처리와 현재 문서 보존

기본 경로는 파일 업로드 → Docling 분석 → 구조 기반 자동 청크 분할 → 임베딩 → 원자 게시다. 블록을 네 복지 섹션에 분류하거나 검토 메모·승인 요청을 작성하지 않는다. 제목·표·쪽·원문 위치를 보존하고, 검색된 원문의 실제 내용으로 답변 근거를 판단한다. 원문에 없는 정보는 보류한다.

### DB 준비와 인증 경계

8테이블·97컬럼을 유지한다. 기존 0004가 적용된 DB에 [자동 처리 보존형 마이그레이션](BackEnd/db/migrations/0005_automatic_document_processing.sql)을 사용자가 직접 적용한다. 기존 테이블·문서·벡터·수동 검토 기록·대기 작업을 초기화하지 않는다. 앱은 DDL을 실행하지 않는다. GET /api/v1/admin/documents/processing의 ready=true가 새 계약 준비 상태다. 준비 전에는 새 업로드·재처리를 automatic_processing_schema_required로 차단한다.

새 작업은 parse_config.processing_mode=automatic으로 구분한다. 분석 해시·출처 fingerprint·실제 처리 시각·모델/토크나이저 설정을 기록하며 reviewed_by/reviewed_at은 NULL이다. 사람 검토를 했다고 표시하지 않는다. 기존 수동 검토 게시본은 기존 출처 검증을 유지한다. 이전 awaiting_review·진행 작업은 몰래 자동 처리하지 않는다.

모든 관리자 API는 서버 공통 비밀번호 세션을 요구합니다. 제도·문서 원문은 기존 DB에 보존하고 인증 실패를 공개 검색으로 우회하지 않습니다. 일반 익명 채팅은 공개 가능한 게시 원문만 검색하고 로그인한 관리자는 같은 기본 채팅에서 test_only 문서도 확인할 수 있습니다. 서버 비밀번호·토큰을 프런트 소스나 로그에 기록하지 않습니다.

현재 DB의 nullable actor 계약을 재사용합니다. 공통 비밀번호 접수는 uploaded_by·created_by에 가짜 UUID를 넣지 않고 NULL을 사용하며, 레거시 FK 호환 필드인 local_ingestion=true와 parse_config.auth_mode=shared_password를 함께 기록합니다. 이 필드는 루프백이나 테스트 전용이라는 뜻으로 사용하지 않으며 공개 범위 test_only와 별개입니다. 서버가 확인한 공통 관리자 세션은 기존 개별 계정 문서의 교체·재시도·취소·삭제에도 명시적인 권한 맥락으로 적용됩니다. 기존 auth.users FK·과거 기록은 보존하고 새 관리자 계정·허용 목록·스키마는 만들지 않습니다.

### 파일에서 답변까지

1. 저장소 루트에서 docker compose up -d --build로 서비스를 준비한다. 실제 환경값은 사용자가 관리하며 예시는 .env.example을 참고한다.
2. 프런트 문서 관리 또는 http://127.0.0.1:8000/docs에서 GET /api/v1/admin/documents/processing을 확인한다.
3. GET /api/v1/admin/documents/programs로 연결할 제도의 service_id를 확인한다. 일반 제도는 관리자 제도 등록 API로 만들 수 있다. 기존 TEST_ 제도·문서의 test_only 격리 정책은 유지한다.
4. POST /api/v1/admin/documents에 file과 metadata JSON 문자열을 multipart로 전송한다. metadata의 service_id, name, source_url, source_organization은 실제 값을 쓴다. 확인한 basis_year 또는 source_updated_at은 선택 입력하며 날짜를 만들지 않는다. 신규 문서는 document_id를 생략하고 같은 문서 교체 시 지정한다.
5. 업로드 응답의 document_id/job_id로 GET /{id}/jobs/{job_id}를 조회한다. 새 상태 흐름은 queued → parsing → embedding → ready → succeeded다. parsing에는 모델 준비·분석·청크 구성이 포함된다. GET /{id}/markdown은 원문을 선택적으로 확인하는 읽기 경로다.
6. 해당 작업의 succeeded와 문서 active_job_id == job_id를 모두 확인한 뒤 POST /{id}/search 또는 /{id}/query에 query를 보낸다. 교체 실패 시 active=true는 이전 게시본일 수 있다. 일반 제도/문서는 일반 POST /api/v1/chat에도 반영되고 test_only는 문서 범위 경로에서만 조회한다.

위 5~6번의 /{id} 접두사는 /api/v1/admin/documents다. 과거 POST /{id}/index는 더 이상 승인 경로가 아니며 409 안내를 반환한다.

### 교체·실패·검색

동일 문서는 PUT /{id} 또는 업로드 form의 document_id로 교체한다. 새 벡터가 완성될 때까지 현재 게시본을 유지하고, 유효한 lease와 expected_active_job_id가 일치할 때 한 트랜잭션으로 원문·벡터·포인터를 교체한다. 다른 문서는 건드리지 않는다. 실패·취소 후보의 원본은 정리된다. 최초 등록 실패는 같은 ID로 파일을 재첨부한다. 이전 검토 대기도 명시적 재첨부로 새 자동 처리 작업을 만들며 자동 승인하지 않는다. 기존 게시 원본이 남은 경우 POST /{id}/retry로 새 자동 작업을 만들 수 있다.

자동 청크는 content 섹션을 사용한다. 부모는 제목 경계와 최대 1600자·700토큰, 자식은 목표 600자·최대 800자·400토큰으로 나눈다. 실제 원문 문자 범위·블록·쪽·입력 해시·모델 digest·토큰/오버랩을 보존한다. vector+BM25 hybrid 검색과 rerank 후 원문 인용·조건·예외를 검증한다. 신청 방법·지원 대상이라는 수동 섹션명이 없다는 이유로 자동 문서를 배제하지 않는다. 유사도는 정답 확률이 아니며, 검색된 내용이 질문을 뒷받침하지 못하면 보류한다.

암호화·손상·추출 불가 PDF, 파일/쪽/문자/청크 한도 초과, 표·원문 위치 불일치는 조용히 통과시키지 않는다. 모델·DB·파일 단계의 오류 코드를 확인하고 원인을 해결한 뒤 재첨부한다. HTTP 200만으로 내용 정확도를 합격 처리하지 않는다.

BackEnd/tests/document_live_check.py는 이미 실행된 루프백 API에 테스트 제도 원문을 업로드해 자동 게시를 기다리고 선택 질의를 수집하는 수동 도구다. DDL·DB 직접 쓰기·서비스 기동은 하지 않는다. 결과에는 원문이 포함될 수 있어 저장소 밖 경로를 지정한다. 이 도구의 실행은 실제 분석·임베딩·질의를 수행하므로 사용자가 필요할 때만 실행한다.

## 로컬 리랭커 준비
기본 Compose 실행은 백엔드 시작 전에 리랭커 캐시를 확인합니다. 고정된 `RERANK_MODEL`·`RERANK_REVISION`의 파일이 있으면 재사용하고, 없거나 빈 파일이면 필요한 tokenizer·INT8 ONNX 파일을 다운로드합니다. 준비 후 파일을 다시 확인하며 실패하면 오류 유형과 확인할 설정을 로그에 표시하고 백엔드를 시작하지 않습니다. 다운로드에는 네트워크와 캐시 폴더 쓰기 권한·디스크 공간이 필요하며, 파일 확인만으로 실제 추론 성공을 보장하지는 않습니다.

아래 명령은 Docker 없이 호스트에서 캐시를 별도로 준비할 때 사용합니다. 기본 Compose 실행에는 수동 준비 명령이 필요하지 않습니다.

```cmd
python -m pip install -r requirements-reranker.txt
python -m BackEnd.rag.reranker
```

[BGE 다국어 리랭커](https://huggingface.co/BAAI/bge-reranker-v2-m3)의 [INT8 ONNX 변환본](https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX)을 CPU에서 후보별로 실행합니다. 가중치 다운로드는 약 571MB이며 `.env.example`의 `RERANK_MODEL`·`RERANK_REVISION`으로 모델과 버전을 고정합니다. 시작 준비 또는 위 수동 명령에서만 다운로드하고 실제 질의는 로컬 파일만 사용합니다. 질문은 최대 128토큰, 문서는 `min(400, RERANK_MAX_LENGTH - 질문 - 실제 특수 토큰 - 16)`으로 제한합니다. 긴 문서는 원문 위치가 보존된 입력 창으로 나누고 최대 창 점수를 사용합니다. 자동 절단은 끄고 전체 범위를 검사하며, 일부 창의 높은 점수로 조건 충족을 판단하지 않습니다. `RERANK_THREADS=2`, `RERANK_MAX_LENGTH=512`, 백엔드 한 프로세스 기준입니다.

리랭커 외에도 bge-m3 임베딩과 Ollama LLM의 메모리가 필요합니다. 여유 메모리가 적거나 모델을 매번 다시 읽는 환경에서는 첫 응답이 오래 걸리거나 모델 호출이 시간 초과로 보류될 수 있습니다. 후보 수·스레드 수를 늘리면 자원 사용도 증가하므로 실제 실행 환경에 맞게 설정합니다.

Compose 백엔드는 리랭커 의존성을 설치하고 같은 캐시 폴더를 마운트합니다. 모델 캐시·데이터·환경 비밀값은 Git·Docker 빌드 컨텍스트·Vercel 업로드에서 제외합니다. 현재 Vercel 배포 대상은 프런트뿐이며 ONNX 리랭커·Ollama·문서 검색 API는 별도 Docker 백엔드에서 실행합니다. 외부 백엔드의 접근·인증·CORS를 준비하고 프런트의 API 주소를 연결하기 전까지 운영 채팅은 백엔드 미연결 상태입니다.

## 로컬 실행
저장소 루트에서 `docker compose up -d --build`로 백엔드를 켜고, 별도 터미널에서 `cd FrontEnd && npm run dev`로 프런트를 실행합니다. http://localhost:5173/ 에서 기본 채팅을 사용하며 Vite가 `/api`를 8000으로 넘깁니다. Docker 없이 직접 실행할 때는 호스트 환경을 준비한 뒤 `uvicorn BackEnd.main:app --port 8000`을 사용합니다.

### 로컬 제도·문서 관리

문서 관리 버튼은 모든 환경에서 표시합니다. 공통 비밀번호 로그인 → 제도 등록·관리 → 원문 업로드 → 자동 분석·청크·임베딩·게시 → 기본 채팅으로 이어집니다. 기존 진행 상태·검색 원문·쪽 표시를 같은 화면에서 사용합니다. 노트북도 Vite 프록시를 통해 동일한 서버 비밀번호 세션을 사용합니다.

실제 담당 부서가 없으면 운영자가 확인한 기관·부서를 departments에 먼저 등록한다. 목업 기관을 실제 제도의 담당 기관으로 사용하지 않는다. 문서가 연결된 제도는 근거가 무효화되지 않도록 이름·외부 ID·test_only 변경과 삭제를 막는다.

처리 상태를 화면 상단에서 확인한다. 모델 준비/분석/청크 생성의 세부 진행률이나 ETA는 만들지 않는다. 저장 청크 수·접수 후 경과·마지막 조회 시각은 실제 응답을 표시한다. 정상 상태는 5초마다 조회하고, 일시 실패하면 마지막 정보를 보존해 5·10·20초 간격으로 최대 3회 다시 확인한다. 게시 전이나 조회 지연 중에는 검색을 막는다.

문서 관리의 ID는 처리 상태를 이어 확인하는 용도입니다. 기본 채팅은 `/`의 POST `/api/v1/chat`을 사용하며 문서 선택·특수 URL이 필요 없습니다. 서버가 검증한 관리자 세션은 test_only 원문도 확인할 수 있지만 익명 요청은 공개 원문만 검색합니다. 잘못되거나 만료된 토큰은 거부하고 공개 검색으로 숨기지 않으며 기존 DB 공개 플래그를 바꾸지 않습니다.

관리자 상담 내용은 메모리에만 보관하고 공용 localStorage 이력에 저장하지 않습니다. 로그아웃·세션 교체·만료 시 관리자 응답과 진행 중 요청을 초기화하며 기존 익명 이력은 보존합니다. 뒤늦은 이전 요청의 401이 새 로그인 세션을 지우지 않도록 구분합니다. 관리자·채팅 API 응답에는 `Cache-Control: no-store`를 적용합니다.

기본 채팅은 저장 벡터와 BM25 검색·리랭킹 결과를 모델에 전달해 일반 텍스트로 답한다. 복지 의도·지급 주기·enum 선택·추가 내용 후검증은 이 경로에 적용하지 않는다. 검색 원문과 페이지를 답변 아래에서 확인할 수 있다. 원문 미리보기는 선택 사항이며 업로드 전후에 사람이 임베딩을 승인하는 절차는 없다.

기본 `/api/v1/chat`과 선택 문서의 `/query`는 모두 검색 원문을 모델에 전달하고 일반 텍스트 답변을 받는 문서 RAG 경로다. 추가 내용 필터와 정확 인용·조건·예외 등의 답변 후검증은 적용하지 않는다. 화면의 **검색 원문**은 모델 입력 자료이며 정확 인용 검증 결과가 아니므로 사용자가 답변과 원문을 대조한다. 자료 접근 권한·공개 환경의 격리와 선택 문서 질의의 문서 범위 검사는 유지한다.

PDF 표 분석에는 opencv-python-headless가 필요합니다. 누락 의존성은 document_dependency_missing으로 표시하며 워커 로그에는 정제한 모듈명·단계·작업 ID만 남깁니다. 실제 배포 사용에는 서버 ADMIN_PASSWORD와 EC2 HTTPS 연결이 필요합니다. 실제 환경파일·비밀번호·토큰은 응답이나 로그에 노출하지 않습니다.

호스트에서 로컬 DB를 별도 검증할 때는 `DATABASE_MODE=local`로 지정하고 `DATABASE_URL`을 비운 뒤 로컬 `DB_*` 값을 사용합니다. `DATABASE_URL`이 설정되어 있으면 Supabase 등 해당 DB가 우선됩니다. 보존된 PostgreSQL 서비스 정의는 기존 16 버전 데이터 경로와 `pgvector/pgvector:pg16` 이미지를 유지합니다. 기존 데이터 폴더나 볼륨을 초기화하지 않습니다.

백엔드를 8000 포트로 실행하면 Swagger UI는 http://localhost:8000/docs 에서 사용할 수 있습니다. 호스트에서 로컬 DB를 사용할 때는 `DB_HOST=localhost`, `DB_PORT=5432`, `OLLAMA_BASE_URL=http://127.0.0.1:11434`를 사용합니다. 기본 Compose의 백엔드는 DB에 `DATABASE_URL`로, Ollama에 `http://ollama:11434`로 연결합니다. `OLLAMA_EMBED=bge-m3`, `EMBED_DIM=1024`에 맞는 기존 대상 DB 자료를 사용하며, 답변 생성에 사용할 `OLLAMA_LLM` 모델도 같은 Ollama 서버에 준비해야 합니다.

Swagger에서 `GET /health`와 `GET /health/db`를 확인한 뒤 `POST /api/v1/chat`의 **Try it out**으로 다음 요청을 보냅니다. `/health/db` 성공은 DB 연결만 확인하며, CSV·벡터 적재나 모델 준비 완료를 뜻하지 않습니다.

```json
{"query": "기초연금은 어떤 서비스인가요?", "profile": null}
```

`GET /health/runtime`은 프로세스에 적용된 llm(모델·컨텍스트·출력·온도·스레드), embedding(모델·차원), retrieval(후보·유사도 기준), reranker(모델·리비전·임계값·입력 길이·스레드)를 반환합니다. DB 접속값·비밀번호·API 키·서버 경로는 반환하지 않습니다. `configuration_only=true`, `readiness_checked=false`이며 모델 추론·연결·적재·다운로드를 실행하거나 모델 준비·정확도를 보증하지 않습니다. 모델 변경 후 Swagger에서 적용된 설정을 확인합니다.

생성 문맥은 Ollama 모델 정보의 지원 길이와 `LLM_NUM_CTX=8192` 중 작은 값으로 제한합니다. 생성 tokenizer를 정확히 계수할 수 없어 UTF-8 바이트 길이·템플릿 길이·안전 여유 256을 보수적 입력 추정에 사용하고 출력은 기본 512토큰을 예약합니다. 추정치를 정확한 토큰 수라고 표시하지 않습니다. 필수 부모를 임의 요약하지 않고 완전한 근거 묶음만 넣으며, 넣지 못한 항목은 부분 답변이나 `context_budget` 보류로 구분합니다. 출력 길이 종료·입력 평가량 한계 도달·잘림 플래그를 검사하지만, 모델별 숨은 절단을 완전히 증명하는 검사는 아닙니다. 기준일 이후 현행 여부·의미적 관련성·실제 자격은 별도 확인 대상입니다.

생성 모델에는 요청 한정 자료 ID와 중복 없는 부모 묶음, 완전한 원문 문장 목록을 전달합니다. 검색 청크의 `MIN_RERANK_SCORE`(기본 0.5) 통과 후, 자식 범위에 걸치는 문장을 부모에서 완전히 복원해 같은 BGE 리랭커로 재정렬하고 상위 2개를 인용 후보로 사용합니다. 문장 단독 점수는 청크 점수와 구분하며 확률이나 추가 통과 기준으로 해석하지 않습니다. 필수 조건 부모는 요약하거나 줄이지 않습니다. [Ollama JSON Schema 출력](https://ollama.com/blog/structured-outputs)으로 그 후보 중 한 문장만 선택하게 하고, 서버가 후보·원문 일치·핵심 섹션·필수 부모·조건·예외·버전을 다시 검증합니다. 하위 질문마다 한 문장만 선택하며, 조건 ID나 장문의 설명을 모델이 반복 출력하지 않습니다. Docling 위치·제목·표 시작/끝 표시는 문장 후보에서만 제외하고 원문·출처에는 보존합니다. 형식 제한이나 리랭커 점수 자체가 의미적 정확도를 보증하지는 않습니다. 진단의 `sentence_rerank`, `selected_sentences`, `generation_metadata`로 후보 점수·선택 위치·입력/출력 평가량·종료 사유를 구분합니다.

### 개발용 Swagger 진단

기본 비활성인 `POST /debug/rag`는 `RAG_DIAGNOSTICS_ENABLED=true`와 32자 이상의 별도 `RAG_DIAGNOSTICS_TOKEN`을 주입한 로컬 개발 실행에서만 사용합니다. 변경 후 같은 Compose up 명령으로 재적용하고 Swagger의 `x-rag-debug-token` 헤더에 해당 값을 입력합니다. `.env.example`에는 비밀값을 넣지 않습니다. 활성화하지 않았거나 토큰이 다르면 404이며 Vercel에서는 항상 비활성입니다. 외부 공개용으로 켜지 않습니다. 기존 `/api/v1/chat` 요청·응답 계약은 그대로입니다.

진단 응답은 일반 응답과 요청 식별자·검색 단계별 청크 ID/순위/점수·원문 버전·리랭킹 창 길이/잘림 여부·복원 조건 ID·입력 예산 추정·보류 단계/이유·처리 시간을 구분합니다. 질문·원문·개인 대화·접속정보를 통째로 진단 로그에 저장하지 않습니다. DB 등 실행 오류는 503과 실패 단계로 표시하며 자료 부족으로 바꾸지 않습니다. 공식 상세 수집·DB 적재·인용 정확도·한국어 형태소·설치 호환성은 실제 자료와 Swagger 수동 평가로 검증해야 합니다. 설계 기준과 평가 항목은 [RAG 정확도 설계](docs/rag-accuracy-design.md)를 따릅니다.

`GET /health/reranker`는 캐시 경로·파일 준비만 확인하며 추론 성공을 뜻하지 않습니다. `query`를 `기초연금 문의처`, `기초연금 신청 조건`, `기초연금 신청 방법`, `우주여행 항공권 예약`으로 바꿔 확인할 수 있습니다. 상세 근거가 없거나 무관하면 보류해야 합니다. 빈 질문이나 공백만 있는 질문은 422 응답으로 거부합니다.

`history`는 선택 입력이며 최근 6턴, 최대 12개 user/assistant 메시지·전체 6000자 이내입니다. 기존 query/profile 호출은 유지합니다. 첫 요청 `{"query":"돈이 없어"}`는 도움 범위를 묻는 질문 하나를 반환하고, 후속 요청은 다음처럼 이력을 보냅니다. 이력·사용자 주장·이전 답변은 복지 사실의 근거로 사용하지 않습니다.

```json
{"query":"생활비","profile":null,"history":[{"role":"user","content":"돈이 없어"},{"role":"assistant","content":"생활비, 주거비, 병원비 중 어떤 도움이 가장 급하신가요?"}]}
```

응답의 기존 kind/text/services/suggestions와 카드 필드는 유지하며 fallback에 선택적인 `reason`을 추가합니다. 조건 확인 질문은 text에 담습니다. 프런트엔드는 history를 전송하도록 별도 연동해야 하며, 전송하지 않으면 요청 간 대화 상태를 서버에 저장하지 않습니다.

## 테스트
```
python -m pytest            # 백엔드
cd FrontEnd && npm test     # 프론트엔드
```

pgvector 통합 테스트는 `RAG_TEST_DATABASE_URL`이 지정된 경우에만 실행합니다. 대상은 일회용 로컬 `rag_test` 데이터베이스여야 하며, 새 스키마를 미리 준비한 일회용 DB를 읽기 전용으로 확인합니다. 스키마 생성·테이블 초기화·prune을 하지 않습니다. 운영 DB나 보존할 로컬 데이터를 지정하지 않습니다. 모델 없이 실행하는 테스트와 별개로, 실제 모델의 검색 품질과 응답 시간은 로컬 Ollama를 켠 뒤 확인해야 합니다.

## Vercel 프런트 전용 배포

공식 프런트 주소는 https://welfare-helper-iota.vercel.app 이며, Vercel 프로젝트는 Root Directory `FrontEnd`, Framework `Vite`, 빌드 `npm run build`, 출력 `dist`로 설정합니다. `FrontEnd/vercel.json`의 SPA 재작성으로 `/admin` 등 직접 접속도 `index.html`을 받습니다. [Vercel Vite SPA 안내](https://vercel.com/docs/frameworks/frontend/vite#using-vite-to-make-spas)를 따릅니다. 기존 루트의 FastAPI + Vite multi-service 설정은 제거했으며 이 배포는 백엔드 API를 제공하지 않습니다. 원격 프로젝트 설정 변경과 실제 배포는 별도로 수행해야 합니다.

`VITE_API_BASE_URL` 없이 빌드된 운영 화면에서는 API 호출 전에 백엔드 미연결 안내를 표시합니다. SPA HTML을 API JSON으로 처리하거나 가짜 답변을 제공하지 않습니다. 외부 Docker 백엔드를 준비한 뒤 Vercel의 프런트 빌드 환경에 해당 HTTPS 기본 주소를 설정하고 다시 배포해야 합니다. 서버 DB 비밀번호·Supabase 서버 키·Ollama 설정은 프런트 프로젝트에 주입하지 않습니다.

외부 백엔드의 공개 접근·인증·CORS 및 모델 실행 환경은 별도 연결 단계입니다. 현재 로컬 문서 접수 경계를 외부 연결용으로 해제하지 않습니다. API 주소 변수만으로 로컬 Docker에 접속할 수 있는 것은 아니며, 연결 전까지 운영 채팅은 백엔드 미연결 상태입니다. Vercel에서 Compose·Ollama·리랭커를 함께 실행하지 않으며 PC의 모델 캐시나 데이터 폴더를 배포 파일에 포함하지 않습니다.

### EC2 백엔드의 최초 준비와 갱신

EC2 Linux에는 Git, Docker Engine과 Compose v2 플러그인을 먼저 설치하고 Docker 데몬을 부팅 시 시작하도록 설정합니다. 예를 들어 systemd 환경에서 `sudo systemctl enable --now docker`를 사용하며 실행 계정의 Docker 접근 권한도 준비합니다. CPU 실행이 기본이며 GPU를 요구하지 않습니다. worker의 기본 메모리 상한은 4GB이고 Ollama·리랭커·운영체제 메모리는 별도이므로 모델·이미지·캐시를 위한 메모리와 디스크를 확보해야 합니다. 실제 EC2 사양의 처리 시간·메모리는 별도 확인 대상입니다.

`test_only` 문서는 공개 검색에서 제외되므로 공개 가능한 게시 원문이 준비되어야 합니다. EC2의 코드·모델 기동 준비와 공개 RAG 자료 준비는 별개이며, 공개 원문이 없으면 공개 질의는 근거 없음으로 응답할 수 있습니다. 로컬 검증을 위해 기존 플래그를 바꾸지 않으며 공개 원문은 적법한 관리자 경로로 등록합니다.

저장소를 받은 뒤 `.env.example`을 참고해 EC2 서버 환경을 한 번 준비합니다. 기존 DATABASE_URL·별도 DATABASE_PASSWORD, bge-m3 1024차원과 리랭커 리비전을 유지하고 `DOCUMENTS_ENABLED=true`, `ADMIN_PASSWORD`를 설정합니다. OLLAMA_LLM 하나로 생성 모델과 준비 목록을 선택합니다. 공통 관리자 로그인에 Supabase Auth 키·사용자·관리자 행은 필요하지 않으며 기존 데이터와 test_only 플래그를 바꾸지 않습니다.

최초 준비와 이후 코드 갱신은 저장소 루트에서 다음 명령을 사용합니다.

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

별도 프런트 컨테이너나 로컬 PostgreSQL은 시작하지 않습니다. 앱 코드는 이미지에 들어가며 갱신 시 rebuild로 적용됩니다. 기존 `ollama_data/`, `.reranker_cache/`, `postgres_data/`와 `docling_models` 볼륨을 보존합니다. 같은 데이터와 볼륨을 재사용하려면 저장소 경로와 Compose 프로젝트 이름을 유지합니다. 새 EC2에 노트북의 캐시가 없으면 처음 한 번 모델을 내려받으며 Docling 분석 모델은 첫 업로드 때 추가 준비될 수 있습니다. 빌드·다운로드 실패는 명령 종료 상태와 `docker compose logs backend ollama document-worker`에서 확인합니다. 데이터 초기화·`down -v`·재업로드·재임베딩은 시작 절차가 아닙니다.

Ollama는 설정된 두 모델이 존재한 뒤 healthy가 되고 backend는 그 상태를 기다립니다. backend의 `/health/ready`는 읽기 전용 DB 연결·기존 문서 계약·모델 존재·리랭커 캐시를 확인하며 worker는 backend의 healthy 이후 시작합니다. worker health는 부모 프로세스의 주기적 heartbeat를 확인합니다. 이 검사는 추론·새 임베딩·쓰기 작업을 하지 않으며 PDF 처리 성공이나 답변 품질을 보증하지 않습니다. `/health`는 프로세스 생존만 의미합니다. Compose up의 종료만으로 전체 준비를 판단하지 말고 `docker compose ps`의 healthy와 `/health/ready`의 200 응답을 확인합니다. 초기 모델 준비에는 시간이 걸릴 수 있습니다.

세 서비스는 `unless-stopped`로 Docker 재시작 후 복구됩니다. 수동으로 중지한 서비스는 자동으로 켜지지 않습니다. Docker 데몬 자체의 부팅 설정과 EC2 재부팅 복구는 실제 서버에서 확인해야 합니다. unhealthy 상태 자체가 컨테이너 재시작을 의미하지 않으므로 지속 실패 시 로그와 준비 응답을 확인합니다. [Docker 시작 순서](https://docs.docker.com/compose/how-tos/startup-order/)와 [재시작 정책](https://docs.docker.com/engine/containers/start-containers-automatically/)을 따릅니다.

### EC2 HTTPS와 Vercel 연결

기본 backend 공개 포트는 `BACKEND_BIND_HOST=127.0.0.1`, `BACKEND_PORT=8000`입니다. 같은 EC2의 HTTPS 역방향 프록시는 이 루프백으로 전달합니다. ALB가 직접 접근해야 한다면 bind 주소를 `0.0.0.0`으로 변경하고 EC2 보안 그룹의 8000 포트를 ALB 보안 그룹에만 허용합니다. Ollama 11434와 DB 5432를 인터넷에 공개하지 않습니다. CPU 추론은 수분 걸릴 수 있으므로 프록시·ALB의 응답 대기 시간을 모델 호출 대기 예산에 맞춰 준비합니다.

실제 EC2 주소와 도메인·유효한 인증서를 준비해 HTTPS API 주소를 만든 뒤, Vercel의 `VITE_API_BASE_URL`에 `/api`를 제외한 해당 HTTPS 기본 주소를 넣고 Git 자동 빌드로 반영합니다. **운영 프런트에 localhost·127.0.0.1을 넣지 않습니다.** 이는 방문자 자신의 컴퓨터를 가리키며 HTTPS 프런트에서 HTTP API 호출도 차단될 수 있습니다. EC2 주소·인증서·프록시가 없는 상태에서 실제 공개 연결 성공을 주장하지 않습니다. 이후 프런트를 정적 산출물로 옮길 때도 빌드 시 같은 주소를 주입합니다.

`CORS_ALLOWED_ORIGINS`는 공식 https://welfare-helper-iota.vercel.app 및 http://localhost:5173, http://127.0.0.1:5173 중 필요한 Origin만 JSON 배열로 허용합니다. CORS는 서버 인증을 대신하지 않습니다. 공개 채팅은 공개 원문만 읽고 관리자 기능은 공통 비밀번호로 발급한 유효 세션을 요구합니다. 비밀번호·토큰 전송은 실제 공개 환경에서 반드시 HTTPS를 사용합니다.
