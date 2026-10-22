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

검색은 서비스명 직접 언급을 우선하고, 의미 검색과 키워드 검색을 RRF 순위 합산으로 결합합니다. 의미 검색 유사도 기준은 `MIN_DENSE_SIM`, 후보 수는 `RETRIEVE_TOP_N`으로 설정합니다. 자료에 없는 금액·자격·문의처·URL은 질문에 적혀 있어도 답변 근거로 쓰지 않습니다.

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

## 배포 사이트에서 LLM 쓰기
Vercel에서는 Ollama를 실행할 수 없으므로, Ollama가 켜진 PC를 터널(ngrok 등)로 공개하고 Vercel 환경변수 `OLLAMA_BASE_URL`에 그 주소를 등록합니다. PC가 꺼져 있으면 챗봇은 키워드 검색과 연락처 안내로만 동작합니다.
