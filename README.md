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
python -m BackEnd.ingest.run              # docs/의 복지로 CSV 367건 적재
python -m BackEnd.ingest.run --dry-run    # DB에 쓰지 않고 검증만
```

## 로컬 실행
```
npx vercel dev -L        # 프론트+백엔드를 http://localhost:3000 하나로 실행
```
또는 `uvicorn BackEnd.main:app --port 8000`과 `cd FrontEnd && npm run dev`를 따로 실행합니다 (Vite가 `/api`를 8000으로 넘김).
백엔드 없이 화면만 보려면 `FrontEnd/.env`에 `VITE_USE_MOCK=true`.

## 테스트
```
python -m pytest            # 백엔드
cd FrontEnd && npm test     # 프론트엔드
```

## 배포 사이트에서 LLM 쓰기
Vercel에서는 Ollama를 실행할 수 없으므로, Ollama가 켜진 PC를 터널(ngrok 등)로 공개하고 Vercel 환경변수 `OLLAMA_BASE_URL`에 그 주소를 등록합니다. PC가 꺼져 있으면 챗봇은 키워드 검색과 연락처 안내로만 동작합니다.
