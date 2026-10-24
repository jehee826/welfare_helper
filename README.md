# welfare_helper
캡스톤 프로젝트 - 복지서비스 AI챗봇

## 구성
| 위치 | 내용 |
|---|---|
| `FrontEnd/` | React + Vite 웹 (이용자 `/`, 관리자 `/admin`) |
| `BackEnd/` | FastAPI. `POST /api/v1/chat`, `/health`, `/health/db` |
| `BackEnd/ingest/` | 복지 CSV → 임베딩 → pgvector 적재 (백그라운드 CLI) |
| `vercel.json` | 프론트·백엔드를 한 Vercel 프로젝트로 배포 (`/api/*`, `/health*` → 백엔드) |

## 준비
1. Docker 실행에서는 아래 단일 Compose 명령이 Ollama 모델과 리랭커 캐시를 준비합니다. 호스트에서 직접 실행할 때만 사용할 Ollama 모델을 별도로 준비합니다.
2. `.env.example`을 참고해 `DATABASE_URL`, `OLLAMA_BASE_URL` 등 실제 값을 런타임에 주입합니다. 접속 문자열·키를 저장소에 넣지 않습니다.
3. 호스트에서 직접 실행할 때 파이썬 의존성: `pip install -r requirements.txt pytest`. Docker 실행은 이미지 빌드에서 설치합니다.
4. 프론트 의존성: `cd FrontEnd && npm install`

## 데이터 적재 (CSV가 바뀔 때마다)
```
python -m BackEnd.ingest.run                    # 변경된 청크만 임베딩·적재
python -m BackEnd.ingest.run --dry-run          # 모델·DB 호출 없이 CSV 검증
python -m BackEnd.ingest.run --check-embeddings # DB 호출 없이 실제 임베딩 검증
```

서비스명·분류·요약 또는 임베딩 모델이 바뀐 청크만 다시 임베딩합니다. 문의처·URL 등 메타데이터는 매번 갱신합니다. `DATABASE_URL` 또는 Supabase 모드에서는 명시적인 `--allow-shared-write` 없이는 CSV 쓰기를 거부하고 스키마를 초기화하지 않습니다. 공용 DB를 오래된 로컬 CSV로 갱신하지 않도록 대상을 먼저 확인해야 합니다. CSV에서 빠진 서비스는 기본 보존하며 삭제는 별도의 명시적인 `--prune` 작업에서만 수행합니다.

기본 인코딩은 CP949이며 UTF-8 CSV는 `--encoding utf-8-sig`를 사용합니다. 빈 파일·필수 컬럼 누락·ID 중복은 DB 반영 전에 거부합니다. 모델은 기존 `vector(1024)` 구조와 같은 1024차원이어야 합니다. 모델을 바꾸면 적재를 다시 실행해야 하며, 검색은 현재 설정한 모델의 벡터만 사용합니다.

검색은 활성 자식 원문만 대상으로 하위 의도별 벡터 `DENSE_TOP_K=30`개와 한국어 본문 BM25 `KEYWORD_TOP_K=30`개를 모으고 RRF `1/(60+순위)`로 결합합니다. `RETRIEVE_TOP_N=40`은 요청 전체 후보 상한이며 여러 의도에 균등한 기회를 줍니다. `MIN_DENSE_SIM`은 비교·진단용으로 남기고 앞단 필터에는 사용하지 않습니다. 리랭커의 `MIN_RERANK_SCORE`를 통과한 핵심 근거는 `CORE_EVIDENCE_K=6`개까지, 서비스 카드는 기존 최대 3개로 유지합니다. 필수 조건·예외 부모는 근거 수와 별개로 복원합니다. 이 수치는 미검증 초기값이며 점수는 관련성 지표로, 사실 정확도나 자격 확률이 아닙니다.

LangChain의 `ChatPromptTemplate`·`ChatOllama`·`JsonOutputParser`로 원문 인용과 확인 질문을 생성합니다. 각 사실 인용은 실제 청크 ID와 원문의 완전한 문장에 일치해야 합니다. 검증된 섹션 원문과 주변 적용 조건·예외를 함께 표시하며, 지원 금액·자격·신청 방법에는 공식 상세 섹션과 기준 정보가 필요합니다. CSV 요약만 있으면 상세 원문으로 가장하지 않고 보류합니다. 자료가 오래됐거나 잘못 수집됐을 가능성까지 제거하는 검증은 아니며 최신 자격을 확정하지 않습니다.

서비스명·괄호 안 별칭·띄어쓰기 변형을 ID에 연결하고 모호한 이름은 확인합니다. 임의의 공식 별칭을 만들어 넣지 않습니다. 명시된 서비스는 해당 ID 안에서 검색하며 문의처 질문은 DB 메타데이터만 사용합니다. 소개·금액·자격·신청 의도와 서비스 비교를 최대 3개 하위 의도로 제한하고 넘으면 범위를 묻습니다. 이전 assistant 답변은 사실 근거로 쓰지 않습니다. 본문 분석기는 [Kiwi 0.24.1](https://github.com/bab2min/kiwipiepy/releases/tag/v0.24.1)로 고정했으며 같은 분석을 문서·질의에 적용합니다. Python 3.12/Docker에서의 설치·형태소 품질은 실제 실행 검증이 필요합니다.

검색 스냅샷은 같은 DB 트랜잭션 시점의 서비스·청크를 읽으며 BM25 캐시는 스냅샷·임베딩 digest가 일치할 때만 재사용합니다. 검색 전에 활성 ID를 벡터 SQL에 전달하고 필수 조건도 같은 스냅샷에서 복원하므로 키워드 후보 순서나 `LIMIT 500` 때문에 조건이 누락되지 않습니다. 서비스 또는 전체 보존 청크가 50,000행을 넘으면 불완전한 검색을 중단합니다. 요청 종료 시 버전 변경을 감지하면 전체 처리를 한 번 재시도하고 다시 충돌하면 `data_version_conflict`로 보류합니다.

## 공식 상세 원문 보강
[공공데이터포털 중앙부처복지서비스](https://www.data.go.kr/data/15090532/openapi.do)의 상세조회 API를 사용합니다. 활용신청한 `BOKJIRO_SERVICE_KEY`가 필요하며, 서비스 ID를 최대 5개만 명시해 호출합니다. 기본 명령은 DB 읽기·공식 API 조회만 하고, `--write`에서만 상세 청크를 갱신합니다.

```cmd
python -m BackEnd.ingest.details --service-id WLF00001164
python -m BackEnd.ingest.details --service-id WLF00001164 --write
```

지원대상·선정기준·급여내용·신청방법 4개 섹션·공식 출처·기준연도를 모두 검증한 뒤 반영합니다. 일부 누락·오류·빈 결과는 폐지로 판단하지 않고 기존 활성본을 유지합니다. HTML 문단·목록과 표의 열 이름·단위·각주를 보존하고, 병합 셀은 범위 표기를 남기며 불완전하거나 중첩된 표는 거부합니다. 실제 XML 필드 해석과 자료 내용은 공식 응답으로 별도 확인해야 합니다.

`welfare_chunks.content`의 `welfare-evidence-v2` JSON에 원문 해시·정제/분할 버전·임베딩 digest·부모 ID·자식 순번·원문 위치·필수 부모·활성 여부를 저장합니다. ERD와 `vector(1024)`는 바꾸지 않습니다. 짧은 CSV overview는 분할하지 않고, 일반 텍스트와 v1 읽기도 유지합니다. 새 v2가 활성화되면 이전 v1 공식 상세는 검색에서 제외합니다. 부모 전체는 대표 자식 하나에 저장하고 해당 행의 벡터는 자식 본문으로 만듭니다.

상세 본문은 목표 600자·최대 800자, 서비스명/섹션/확인된 HTML 상위 제목을 포함해 실제 리랭커 tokenizer 400토큰 이내로 분할합니다. 같은 제목 범위 안에서 마지막 완결 문장 하나가 80자·40토큰 이내이고 다음 입력에도 들어갈 때만 겹칩니다. 긴 단일 문장 조각은 완결 근거로 취급하지 않으며 부모 전체를 복원합니다. 예외 관계를 확정할 수 없으므로 현재는 같은 섹션 부모와 대상·선정기준 부모 전체를 보수적으로 필수 연결합니다.

`--write`에서는 로컬 tokenizer 캐시와 설치된 임베딩 모델 digest가 필요합니다. 실제 임베딩 입력·모델·digest가 같은 벡터는 이전 버전에서도 재사용하며 수집 시각 또는 생성 LLM 변경만으로 재임베딩하지 않습니다. 모든 입력 준비 후 서비스 잠금·기존 버전 일치 검사를 거쳐 한 트랜잭션으로 활성본을 교체합니다. 이전 원문은 비활성으로 보존합니다. 같은 기준연도에 원문이 달라졌다면 충돌 검토 후 `--replace-same-basis`를 명시해야 하며, 더 오래된 연도로의 교체는 거부합니다. API가 주지 않은 효력일·최종 수정일을 추정하지 않습니다. 문의처·서비스 메타데이터는 유지합니다.

## Supabase와 Docker 실행
상주 백엔드가 IPv4 환경이면 [공식 연결 안내](https://supabase.com/docs/guides/database/connecting-to-postgres)에 따라 Session pooler를 검토합니다. 호스트·포트·사용자명은 실제 Connect 화면에서 가져오며 지역명으로 조합하지 않습니다. `DATABASE_URL`을 우선 사용하고 TLS를 요구합니다.

`DATABASE_URL`에는 비밀번호를 제외한 접속 주소를 넣고 `DATABASE_PASSWORD`에 비밀번호를 별도로 주입할 수 있습니다. 예를 들어 `postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres` 형태이며, 실제 호스트·사용자명은 Connect 값을 사용합니다. 비밀번호는 URI 문자열에 이어 붙이지 않고 psycopg2의 password 인자로 전달하므로 예약 문자를 인코딩할 필요가 없습니다. 기존 비밀번호 포함 URL도 지원하며, `DATABASE_PASSWORD`가 있으면 그 값이 우선됩니다. 로컬 DB_* 경로의 `DB_PASSWORD`는 그대로 유지합니다.

```cmd
docker compose up -d --build
```

노트북과 컴퓨터 모두 이 명령 하나로 backend·ollama를 실행합니다. 장비별 Compose 파일이나 모드 선택은 없습니다. 기본 Compose에 `DATABASE_MODE=supabase`, `INGEST_ON_STARTUP=false`를 적용하므로 로컬 PostgreSQL을 시작하지 않고 공용 DB의 CSV 적재·스키마 변경도 수행하지 않습니다. 연결 값이 없으면 로컬 DB로 대체하지 않고 설정 오류로 종료합니다.

모델을 바꿀 때는 사용자가 `.env`의 `OLLAMA_LLM` 이름 하나만 수정합니다. 예를 들어 `qwen2.5:1.5b-instruct` 또는 `gemma3:4b`를 지정하면 backend의 선택 모델과 Ollama 준비 목록에 같은 값이 전달됩니다. 모델 이름으로 정확도나 GPU 사용 가능성을 보장하지 않습니다. 선택 모델이 없으면 기존 Ollama 시작 스크립트가 다운로드할 수 있습니다.

공통 2GB 메모리·2 CPU 상한은 두지 않습니다. 실행 가능한 모델 크기는 장비와 Docker의 가용 자원에 달려 있으며, 메모리가 부족하면 실행 실패나 시간 초과가 발생할 수 있습니다. Ollama의 동시 추론과 동시 적재 모델은 각각 1개로 제한합니다. 컨텍스트·출력·스레드·검색 후보 수는 장비별 분기 없이 기존 `LLM_NUM_CTX`, `LLM_NUM_PREDICT`, `LLM_NUM_THREAD`, `RETRIEVE_TOP_N` 설정과 앱 기본값을 사용합니다.

수정 후 Windows CMD의 저장소 루트에서 위와 같은 Compose up 명령을 다시 실행해 backend·ollama 설정을 재적용합니다. `.env` 저장이나 `docker restart`만으로 환경변수 갱신을 보장할 수 없습니다. Compose up은 변경된 컨테이너를 재생성할 수 있으며, 기존 `ollama_data/`, `postgres_data/`, 리랭커 캐시 마운트는 유지합니다. `down -v`나 데이터 폴더 초기화는 하지 않습니다. 생성 LLM만 바꾸고 임베딩 모델·청크 내용이 같으면 재임베딩할 필요가 없습니다. Supabase·bge-m3 1024차원·리랭커 모델/리비전/임계값/캐시는 그대로 사용합니다.

기존 로컬 PostgreSQL 서비스 정의와 데이터 경로는 보존하지만 기본 실행 대상에는 포함하지 않습니다. 로컬 DB를 직접 사용하는 별도 개발 실행에서는 공용 DB 설정과 구분해야 합니다.

공용 테이블은 Data API의 노출 스키마·`anon`/`authenticated` grants·RLS 정책을 함께 확인해야 합니다. RLS를 켜고 정책을 주지 않으면 기존 Data API 접근이 차단됩니다. 다른 파트의 직접 호출 여부를 조율한 뒤 공공 자료 읽기 정책과 서버 전용 쓰기 권한을 정하며, 백엔드 시작 코드에서 권한을 일괄 변경하지 않습니다.

## 로컬 리랭커 준비
기본 Compose 실행은 백엔드 시작 전에 리랭커 캐시를 확인합니다. 고정된 `RERANK_MODEL`·`RERANK_REVISION`의 파일이 있으면 재사용하고, 없거나 빈 파일이면 필요한 tokenizer·INT8 ONNX 파일을 다운로드합니다. 준비 후 파일을 다시 확인하며 실패하면 오류 유형과 확인할 설정을 로그에 표시하고 백엔드를 시작하지 않습니다. 다운로드에는 네트워크와 캐시 폴더 쓰기 권한·디스크 공간이 필요하며, 파일 확인만으로 실제 추론 성공을 보장하지는 않습니다.

아래 명령은 Docker 없이 호스트에서 캐시를 별도로 준비할 때 사용합니다. 기본 Compose 실행에는 수동 준비 명령이 필요하지 않습니다.

```cmd
python -m pip install -r requirements-reranker.txt
python -m BackEnd.rag.reranker
```

[BGE 다국어 리랭커](https://huggingface.co/BAAI/bge-reranker-v2-m3)의 [INT8 ONNX 변환본](https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX)을 CPU에서 후보별로 실행합니다. 가중치 다운로드는 약 571MB이며 `.env.example`의 `RERANK_MODEL`·`RERANK_REVISION`으로 모델과 버전을 고정합니다. 시작 준비 또는 위 수동 명령에서만 다운로드하고 실제 질의는 로컬 파일만 사용합니다. 질문은 최대 128토큰, 문서는 `min(400, RERANK_MAX_LENGTH - 질문 - 실제 특수 토큰 - 16)`으로 제한합니다. 긴 문서는 원문 위치가 보존된 입력 창으로 나누고 최대 창 점수를 사용합니다. 자동 절단은 끄고 전체 범위를 검사하며, 일부 창의 높은 점수로 조건 충족을 판단하지 않습니다. `RERANK_THREADS=2`, `RERANK_MAX_LENGTH=512`, 백엔드 한 프로세스 기준입니다.

리랭커 외에도 bge-m3 임베딩과 Ollama LLM의 메모리가 필요합니다. 여유 메모리가 적거나 모델을 매번 다시 읽는 환경에서는 첫 응답이 오래 걸리거나 모델 호출이 시간 초과로 보류될 수 있습니다. 후보 수·스레드 수를 늘리면 자원 사용도 증가하므로 실제 실행 환경에 맞게 설정합니다.

Compose 백엔드는 리랭커 의존성을 설치하고 같은 캐시 폴더를 마운트합니다. 모델 캐시·데이터·환경 비밀값은 Git·Docker 빌드 컨텍스트·Vercel 업로드에서 제외합니다. Vercel의 기본 의존성에는 로컬 ONNX 런타임을 포함하지 않으므로, 별도의 리랭커 실행 환경을 연결하기 전에는 일반 상담이 보류될 수 있습니다. 서버리스에 모델을 올리거나 외부 리랭킹 서비스를 연결하는 구성은 이 로컬 실행 설정에 포함하지 않습니다.

## 로컬 실행
```
npx vercel dev -L        # 프론트+백엔드를 http://localhost:3000 하나로 실행
```
또는 `uvicorn BackEnd.main:app --port 8000`과 `cd FrontEnd && npm run dev`를 따로 실행합니다 (Vite가 `/api`를 8000으로 넘김).
백엔드 없이 화면만 보려면 `FrontEnd/.env`에 `VITE_USE_MOCK=true`.

호스트에서 로컬 DB를 별도 검증할 때는 `DATABASE_MODE=local`로 지정하고 `DATABASE_URL`을 비운 뒤 로컬 `DB_*` 값을 사용합니다. `DATABASE_URL`이 설정되어 있으면 Supabase 등 해당 DB가 우선됩니다. 보존된 PostgreSQL 서비스 정의는 기존 16 버전 데이터 경로와 `pgvector/pgvector:pg16` 이미지를 유지합니다. 기존 데이터 폴더나 볼륨을 초기화하지 않습니다.

백엔드를 8000 포트로 실행하면 Swagger UI는 http://localhost:8000/docs 에서 사용할 수 있습니다. 호스트에서 로컬 DB를 사용할 때는 `DB_HOST=localhost`, `DB_PORT=5432`, `OLLAMA_BASE_URL=http://127.0.0.1:11434`를 사용합니다. 기본 Compose의 백엔드는 DB에 `DATABASE_URL`로, Ollama에 `http://ollama:11434`로 연결합니다. `OLLAMA_EMBED=bge-m3`, `EMBED_DIM=1024`에 맞는 기존 대상 DB 자료를 사용하며, 답변 생성에 사용할 `OLLAMA_LLM` 모델도 같은 Ollama 서버에 준비해야 합니다.

Swagger에서 `GET /health`와 `GET /health/db`를 확인한 뒤 `POST /api/v1/chat`의 **Try it out**으로 다음 요청을 보냅니다. `/health/db` 성공은 DB 연결만 확인하며, CSV·벡터 적재나 모델 준비 완료를 뜻하지 않습니다.

```json
{"query": "기초연금은 어떤 서비스인가요?", "profile": null}
```

`GET /health/runtime`은 프로세스에 적용된 llm(모델·컨텍스트·출력·온도·스레드), embedding(모델·차원), retrieval(후보·유사도 기준), reranker(모델·리비전·임계값·입력 길이·스레드)를 반환합니다. DB 접속값·비밀번호·API 키·서버 경로는 반환하지 않습니다. `configuration_only=true`, `readiness_checked=false`이며 모델 추론·연결·적재·다운로드를 실행하거나 모델 준비·정확도를 보증하지 않습니다. 모델 변경 후 Swagger에서 적용된 설정을 확인합니다.

생성 문맥은 Ollama 모델 정보의 지원 길이와 `LLM_NUM_CTX=8192` 중 작은 값으로 제한합니다. 생성 tokenizer를 정확히 계수할 수 없어 UTF-8 바이트 길이·템플릿 길이·안전 여유 256을 보수적 입력 추정에 사용하고 출력은 기본 512토큰을 예약합니다. 추정치를 정확한 토큰 수라고 표시하지 않습니다. 필수 부모를 임의 요약하지 않고 완전한 근거 묶음만 넣으며, 넣지 못한 항목은 부분 답변이나 `context_budget` 보류로 구분합니다. 출력 길이 종료·입력 평가량 한계 도달·잘림 플래그를 검사하지만, 모델별 숨은 절단을 완전히 증명하는 검사는 아닙니다. 기준일 이후 현행 여부·의미적 관련성·실제 자격은 별도 확인 대상입니다.

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

pgvector 통합 테스트는 `RAG_TEST_DATABASE_URL`이 지정된 경우에만 실행합니다. 대상은 일회용 로컬 `rag_test` 데이터베이스여야 하며, 테스트마다 `welfare_services`와 연결된 청크를 비웁니다. 운영 DB나 보존할 로컬 데이터를 지정하지 않습니다. 모델 없이 실행하는 테스트와 별개로, 실제 모델의 검색 품질과 응답 시간은 로컬 Ollama를 켠 뒤 확인해야 합니다.

## 배포 환경의 모델 연결
Vercel에서는 Ollama나 Compose 전체를 실행할 수 없습니다. 배포에는 별도로 운영하는 Ollama·리랭커 실행 환경과 인증·접속 설정이 필요합니다. 로컬 리랭커만 설정한 상태에서는 일반 상담을 보류하며, 서비스명을 지정한 문의처·상세 조건 확인 안내는 DB 자료로 처리합니다. PC의 모델 캐시나 데이터 폴더를 배포 파일로 업로드하지 않습니다.
