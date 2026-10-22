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
2. 루트 `.env`에 `DATABASE_URL`(Supabase Transaction pooler), `OLLAMA_BASE_URL=http://127.0.0.1:11434` 설정 (`.env.example` 참고)
3. 파이썬 의존성: `pip install -r requirements.txt pytest`
4. 프론트 의존성: `cd FrontEnd && npm install`

## 데이터 적재 (CSV가 바뀔 때마다)
```
python -m BackEnd.ingest.run                    # 변경된 청크만 임베딩·적재
python -m BackEnd.ingest.run --dry-run          # 모델·DB 호출 없이 CSV 검증
python -m BackEnd.ingest.run --check-embeddings # DB 호출 없이 실제 임베딩 검증
```

서비스명·분류·요약 또는 임베딩 모델이 바뀐 청크만 다시 임베딩합니다. 문의처·URL 등 메타데이터는 매번 갱신합니다. CSV에서 빠진 서비스는 기본적으로 보존합니다. 전체 스냅샷에서 누락된 서비스를 실제로 삭제하려면 내용을 확인한 뒤 `--prune`을 명시합니다.

기본 인코딩은 CP949이며 UTF-8 CSV는 `--encoding utf-8-sig`를 사용합니다. 빈 파일·필수 컬럼 누락·ID 중복은 DB 반영 전에 거부합니다. 모델은 기존 `vector(1024)` 구조와 같은 1024차원이어야 합니다. 모델을 바꾸면 적재를 다시 실행해야 하며, 검색은 현재 설정한 모델의 벡터만 사용합니다.

검색은 서비스명 직접 언급과 의미·키워드 RRF 검색으로 후보를 모은 뒤, 질문과 후보 원문을 교차 인코더로 리랭킹합니다. `RETRIEVE_TOP_N`개 후보 중 `MIN_RERANK_SCORE` 이상인 최대 3개만 LLM에 전달합니다. 의미 검색 기준은 `MIN_DENSE_SIM`입니다. 리랭커가 없거나 관련성 점수가 낮으면 후보만으로 답변을 만들지 않고 보류합니다. 점수는 관련성 지표이며, 사실 정확도나 지원 자격 확률이 아닙니다.

LangChain의 `ChatPromptTemplate`·`ChatOllama`·`JsonOutputParser`로 LLM의 자료 선택을 처리합니다. LLM은 확인된 서비스 ID만 선택하며, 표시할 설명은 선택된 DB 요약 원문으로 구성합니다. 자유 생성한 금액·자격·전화번호·URL은 표시하지 않습니다. 문의처·링크·자료 수정일도 DB 값으로 유지합니다. 자료가 낡았거나 요약에 상세 조건이 없으면 원문만으로 최신 자격을 확정할 수 없습니다.

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

`query`를 `기초연금 문의처`, `기초연금 신청 조건`으로 바꾸면 자료 기반 문의처 안내와 상세 자격 정보가 없을 때의 안내를 확인할 수 있습니다. 빈 질문이나 공백만 있는 질문은 422 응답으로 거부합니다.

## 테스트
```
python -m pytest            # 백엔드
cd FrontEnd && npm test     # 프론트엔드
```

pgvector 통합 테스트는 `RAG_TEST_DATABASE_URL`이 지정된 경우에만 실행합니다. 대상은 일회용 로컬 `rag_test` 데이터베이스여야 하며, 테스트마다 `welfare_services`와 연결된 청크를 비웁니다. 운영 DB나 보존할 로컬 데이터를 지정하지 않습니다. 모델 없이 실행하는 테스트와 별개로, 실제 모델의 검색 품질과 응답 시간은 로컬 Ollama를 켠 뒤 확인해야 합니다.

## 배포 환경의 모델 연결
Vercel에서는 Ollama나 Compose 전체를 실행할 수 없습니다. 배포에는 별도로 운영하는 Ollama·리랭커 실행 환경과 인증·접속 설정이 필요합니다. 로컬 리랭커만 설정한 상태에서는 일반 상담을 보류하며, 서비스명을 지정한 문의처·상세 조건 확인 안내는 DB 자료로 처리합니다. PC의 모델 캐시나 데이터 폴더를 배포 파일로 업로드하지 않습니다.
