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
1. 로컬 Ollama에 모델 받기: `ollama pull gemma3:4b`, `ollama pull bge-m3`
2. `.env.example`을 참고해 `DATABASE_URL`, `OLLAMA_BASE_URL` 등 실제 값을 런타임에 주입합니다. 접속 문자열·키를 저장소에 넣지 않습니다.
3. 파이썬 의존성: `pip install -r requirements.txt pytest`
4. 프론트 의존성: `cd FrontEnd && npm install`

## 데이터 적재 (CSV가 바뀔 때마다)
```
python -m BackEnd.ingest.run                    # 변경된 청크만 임베딩·적재
python -m BackEnd.ingest.run --dry-run          # 모델·DB 호출 없이 CSV 검증
python -m BackEnd.ingest.run --check-embeddings # DB 호출 없이 실제 임베딩 검증
```

서비스명·분류·요약 또는 임베딩 모델이 바뀐 청크만 다시 임베딩합니다. 문의처·URL 등 메타데이터는 매번 갱신합니다. `DATABASE_URL` 또는 Supabase 모드에서는 명시적인 `--allow-shared-write` 없이는 CSV 쓰기를 거부하고 스키마를 초기화하지 않습니다. 공용 DB를 오래된 로컬 CSV로 갱신하지 않도록 대상을 먼저 확인해야 합니다. CSV에서 빠진 서비스는 기본 보존하며 삭제는 별도의 명시적인 `--prune` 작업에서만 수행합니다.

기본 인코딩은 CP949이며 UTF-8 CSV는 `--encoding utf-8-sig`를 사용합니다. 빈 파일·필수 컬럼 누락·ID 중복은 DB 반영 전에 거부합니다. 모델은 기존 `vector(1024)` 구조와 같은 1024차원이어야 합니다. 모델을 바꾸면 적재를 다시 실행해야 하며, 검색은 현재 설정한 모델의 벡터만 사용합니다.

검색은 서비스명 직접 언급과 의미·키워드 RRF 검색으로 후보를 모은 뒤, 질문과 후보 원문을 교차 인코더로 리랭킹합니다. `RETRIEVE_TOP_N`개 후보 중 `MIN_RERANK_SCORE` 이상인 최대 3개만 LLM에 전달합니다. 의미 검색 기준은 `MIN_DENSE_SIM`입니다. 리랭커가 없거나 관련성 점수가 낮으면 후보만으로 답변을 만들지 않고 보류합니다. 점수는 관련성 지표이며, 사실 정확도나 지원 자격 확률이 아닙니다.

LangChain의 `ChatPromptTemplate`·`ChatOllama`·`JsonOutputParser`로 원문 인용과 확인 질문을 생성합니다. 각 사실 인용은 실제 청크 ID와 원문의 완전한 문장에 일치해야 합니다. 검증된 섹션 원문과 주변 적용 조건·예외를 함께 표시하며, 지원 금액·자격·신청 방법에는 공식 상세 섹션과 기준 정보가 필요합니다. CSV 요약만 있으면 상세 원문으로 가장하지 않고 보류합니다. 자료가 오래됐거나 잘못 수집됐을 가능성까지 제거하는 검증은 아니며 최신 자격을 확정하지 않습니다.

서비스명이 명시되면 ID로 원문을 조회해 불필요한 임베딩 호출을 줄입니다. 일반 질문은 의미·키워드 RRF 후보를 재평가하며, 주변 조건 보완 조회는 한 번만 수행합니다. 자동 질문 분해·반복 검색은 하지 않습니다. 리랭커 준비 실패와 자료 부족은 각각 `model_not_ready`, `insufficient_evidence` 사유로 구분합니다.

## 공식 상세 원문 보강
[공공데이터포털 중앙부처복지서비스](https://www.data.go.kr/data/15090532/openapi.do)의 상세조회 API를 사용합니다. 활용신청한 `BOKJIRO_SERVICE_KEY`가 필요하며, 서비스 ID를 최대 5개만 명시해 호출합니다. 기본 명령은 DB 읽기·공식 API 조회만 하고, `--write`에서만 상세 청크를 갱신합니다.

```cmd
python -m BackEnd.ingest.details --service-id WLF00001164
python -m BackEnd.ingest.details --service-id WLF00001164 --write
```

지원대상·선정기준·급여내용·신청방법을 섹션 단위 원문으로 보존합니다. 기존 `welfare_chunks.content`의 JSON 봉투에 출처 URL·기준연도·수집일을 저장하므로 테이블 관계와 `vector(1024)`는 바꾸지 않습니다. API가 제공하지 않은 최종 수정일을 CSV 수정일이나 수집일로 채우지 않습니다. 문의처·대표 링크는 공용 DB 값을 유지합니다. 쓰기 명령도 서비스 메타데이터·누락 청크를 자동 삭제하지 않습니다.

## 공용 Supabase와 로컬 실행 분리
상주 백엔드가 IPv4 환경이면 [공식 연결 안내](https://supabase.com/docs/guides/database/connecting-to-postgres)에 따라 Session pooler를 검토합니다. 호스트·포트·사용자명은 실제 Connect 화면에서 가져오며 지역명으로 조합하지 않습니다. `DATABASE_URL`을 우선 사용하고 TLS를 요구합니다.

`DATABASE_URL`에는 비밀번호를 제외한 접속 주소를 넣고 `DATABASE_PASSWORD`에 비밀번호를 별도로 주입할 수 있습니다. 예를 들어 `postgresql://postgres.<project-ref>@<pooler-host>:5432/postgres` 형태이며, 실제 호스트·사용자명은 Connect 값을 사용합니다. 비밀번호는 URI 문자열에 이어 붙이지 않고 psycopg2의 password 인자로 전달하므로 예약 문자를 인코딩할 필요가 없습니다. 기존 비밀번호 포함 URL도 지원하며, `DATABASE_PASSWORD`가 있으면 그 값이 우선됩니다. 로컬 DB_* 경로의 `DB_PASSWORD`는 그대로 유지합니다.

```cmd
docker compose -f docker-compose.yml -f docker-compose.supabase.yml -f docker-compose.notebook.yml up -d --build backend ollama
```

Supabase 모드에서는 로컬 PostgreSQL 의존성과 시작 시 CSV 적재가 없습니다. 연결 값이 없으면 로컬 DB로 대체하지 않고 설정 오류로 종료합니다. 기존 notebook 파일은 자원 제한용이며 컨텍스트 2048·출력 300·후보 6개·CPU 스레드 2개·Ollama 2 CPU·메모리 2GB·동시 추론 및 적재 모델 각 1개 제한을 유지합니다. 큰 모델은 메모리 한도를 넘어 실행하지 못할 수 있습니다.

모델을 바꿀 때는 사용자가 `.env`의 `OLLAMA_LLM` 이름 하나만 수정합니다. 예를 들어 `qwen2.5:1.5b-instruct` 또는 `gemma3:4b`를 지정하면 backend의 선택 모델과 Ollama 준비 목록에 같은 값이 전달됩니다. 모델 이름으로 정확도나 GPU 사용 가능성을 보장하지 않습니다. 선택 모델이 없으면 기존 Ollama 시작 스크립트가 다운로드할 수 있습니다.

수정 후 Windows CMD의 저장소 루트에서 위와 같은 Compose up 명령을 다시 실행해 backend·ollama 설정을 재적용합니다. `.env` 저장이나 `docker restart`만으로 환경변수 갱신을 보장할 수 없습니다. Compose up은 변경된 컨테이너를 재생성할 수 있으며, 기존 `ollama_data/`, `postgres_data/`, 리랭커 캐시 마운트는 유지합니다. `down -v`나 데이터 폴더 초기화는 하지 않습니다. 생성 LLM만 바꾸고 임베딩 모델·청크 내용이 같으면 재임베딩할 필요가 없습니다. Supabase·bge-m3 1024차원·리랭커 모델/리비전/임계값/캐시는 그대로 사용합니다.

로컬 DB 모드는 `DATABASE_URL`을 비우고 `docker compose --profile local up --build`로 실행합니다. 기존 로컬 초기 CSV 적재 편의는 유지하며 `INGEST_ON_STARTUP=false`로 끌 수 있습니다. 기존 데이터 폴더를 보존합니다.

공용 테이블은 Data API의 노출 스키마·`anon`/`authenticated` grants·RLS 정책을 함께 확인해야 합니다. RLS를 켜고 정책을 주지 않으면 기존 Data API 접근이 차단됩니다. 다른 파트의 직접 호출 여부를 조율한 뒤 공공 자료 읽기 정책과 서버 전용 쓰기 권한을 정하며, 백엔드 시작 코드에서 권한을 일괄 변경하지 않습니다.

## 로컬 리랭커 준비
```cmd
python -m pip install -r requirements-reranker.txt
python -m BackEnd.rag.reranker
```

[BGE 다국어 리랭커](https://huggingface.co/BAAI/bge-reranker-v2-m3)의 [INT8 ONNX 변환본](https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX)을 CPU에서 후보별로 실행합니다. 가중치 다운로드는 약 571MB이며 `.env.example`의 `RERANK_MODEL`·`RERANK_REVISION`으로 모델과 버전을 고정합니다. 준비 명령만 모델을 다운로드하고, 실제 질의는 `.reranker_cache/`의 파일만 사용합니다. `RERANK_THREADS=2`, `RERANK_MAX_LENGTH=512`로 CPU 사용과 입력 길이를 제한하며, 긴 후보 원문은 리랭킹 시 잘릴 수 있습니다. 프로세스마다 모델 메모리가 필요하므로 로컬에서는 백엔드 한 프로세스로 실행합니다.

리랭커 외에도 bge-m3 임베딩과 Ollama LLM의 메모리가 필요합니다. 여유 메모리가 적거나 모델을 매번 다시 읽는 환경에서는 첫 응답이 오래 걸리거나 모델 호출이 시간 초과로 보류될 수 있습니다. 후보 수·스레드 수를 늘리면 자원 사용도 증가하므로 실제 실행 환경에 맞게 설정합니다.

Compose 백엔드는 리랭커 의존성을 설치하고 같은 캐시 폴더를 마운트합니다. 모델 캐시·데이터·환경 비밀값은 Git·Docker 빌드 컨텍스트·Vercel 업로드에서 제외합니다. Vercel의 기본 의존성에는 로컬 ONNX 런타임을 포함하지 않으므로, 별도의 리랭커 실행 환경을 연결하기 전에는 일반 상담이 보류될 수 있습니다. 서버리스에 모델을 올리거나 외부 리랭킹 서비스를 연결하는 구성은 이 로컬 실행 설정에 포함하지 않습니다.

## 로컬 실행
```
npx vercel dev -L        # 프론트+백엔드를 http://localhost:3000 하나로 실행
```
또는 `uvicorn BackEnd.main:app --port 8000`과 `cd FrontEnd && npm run dev`를 따로 실행합니다 (Vite가 `/api`를 8000으로 넘김).
백엔드 없이 화면만 보려면 `FrontEnd/.env`에 `VITE_USE_MOCK=true`.

로컬 DB에서 검증할 때는 `DATABASE_URL`을 비우고 로컬 `DB_*` 값을 사용합니다. `DATABASE_URL`이 설정되어 있으면 Supabase 등 해당 DB가 우선됩니다. Compose의 PostgreSQL은 기존 16 버전 데이터 경로를 유지하면서 pgvector를 포함하는 `pgvector/pgvector:pg16` 이미지를 사용합니다. 기존 데이터 폴더나 볼륨을 초기화하지 않습니다.

백엔드를 8000 포트로 실행하면 Swagger UI는 http://localhost:8000/docs 에서 사용할 수 있습니다. 호스트에서 실행할 때는 `DB_HOST=localhost`, `DB_PORT=5432`, `OLLAMA_BASE_URL=http://127.0.0.1:11434`를 사용합니다. Compose의 백엔드는 DB·Ollama 주소를 컨테이너 서비스명으로 지정합니다. `OLLAMA_EMBED=bge-m3`, `EMBED_DIM=1024`에 맞춰 대상 DB에 CSV를 적재하고, 답변 생성에 사용할 `OLLAMA_LLM` 모델도 같은 Ollama 서버에 준비해야 합니다.

Swagger에서 `GET /health`와 `GET /health/db`를 확인한 뒤 `POST /api/v1/chat`의 **Try it out**으로 다음 요청을 보냅니다. `/health/db` 성공은 DB 연결만 확인하며, CSV·벡터 적재나 모델 준비 완료를 뜻하지 않습니다.

```json
{"query": "기초연금은 어떤 서비스인가요?", "profile": null}
```

`GET /health/runtime`은 프로세스에 적용된 llm(모델·컨텍스트·출력·온도·스레드), embedding(모델·차원), retrieval(후보·유사도 기준), reranker(모델·리비전·임계값·입력 길이·스레드)를 반환합니다. DB 접속값·비밀번호·API 키·서버 경로는 반환하지 않습니다. `configuration_only=true`, `readiness_checked=false`이며 모델 추론·연결·적재·다운로드를 실행하거나 모델 준비·정확도를 보증하지 않습니다. 모델 변경 후 Swagger에서 적용된 설정을 확인합니다.

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
