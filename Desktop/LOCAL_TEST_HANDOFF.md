# 다른 Windows PC에서 플로팅 UI 테스트하기

## Codex에 전달할 요청

아래 문장을 새 PC의 Codex에 전달한다. 저장소 pull은 사용자가 먼저 완료한다.

> `Desktop/LOCAL_TEST_HANDOFF.md`를 읽고 현재 PC에서 로컬 화면 안내 테스트를 준비하고 진행해. 먼저 실제 브랜치·코드·실행 중인 서비스를 확인하고, 이 문서와 다르면 실제 코드 기준으로 차이를 알려줘. 기존 데이터와 사용자 Chrome은 보존해. 필요한 설정이 없으면 비밀값을 채팅에 요청하지 말고 사용자에게 로컬 설정 방법을 안내해. 자동 클릭·입력·제출 없이 화면 안내를 기능별 한 번만 확인하고, 확인한 결과와 미검증 항목을 구분해 보고해. EC2·Vercel·공용 DB 구조·원격 Git은 변경하지 마.

## 테스트 대상과 성공 기준

- 개발 브랜치: `codex/feat-floating-ui`. 이 문서는 main 반영을 전제로 하지 않는다.
- Windows 트레이 앱이 **일반 Google Chrome**의 복지로 선택 탭을 감지해 패널을 연다.
- 공식 진입 주소: https://www.bokjiro.go.kr/ssis-tbu/index.do
- 화면 안내는 UI Automation으로 얻은 공개 버튼·링크·메뉴 후보를 로컬 FastAPI로 보내고, Ollama가 다음 행동 하나를 안내한다. 화면 캡처나 VLM 방식이 아니다.
- RAG 상담과 화면 안내는 **같은 `OLLAMA_LLM` 하나**를 사용한다. 이번 우선 테스트는 화면 안내이며, 문서 업로드·임베딩·RAG 추론을 추가 실행하지 않는다.
- 성공은 실제 복지로에서 패널 표시 → 실제 요소 수집 → 모델 응답 → 해당 요소 안내까지 확인한 경우다. 빌드 성공·HTTP 200·고정 데모 응답만으로 성공 처리하지 않는다.

기존에는 회귀검사와 빌드까지만 확인했다. **실제 복지로의 자동 열림과 모델 안내는 이 PC에서 확인해야 한다.**

## 1. 실행 전 확인

프로젝트 지침과 관련 로컬 스킬을 먼저 적용한다. 다른 PC에는 Git에서 제외한 개인 지침·스킬이 없을 수 있으며, 이 문서는 그 파일들이 설치됐다고 가정하지 않는다.

저장소 루트에서 다음을 확인한다. 기존 수정은 보존하고 자동으로 브랜치를 전환하거나 pull·reset하지 않는다.

```cmd
git branch --show-current
git status --short
node --version
npm --version
docker version
docker compose version
docker compose ps
```

필요 조건은 Windows, 일반 Google Chrome, **Node.js 22.12 이상**, 실행 중인 Docker Desktop의 Linux 컨테이너 환경이다. 8000·11434 포트가 다른 프로그램에 점유돼 있으면 해당 프로그램을 임의 종료하지 않는다.

## 2. 루트 환경 설정

`.env`와 모델·리랭커 캐시는 원격에 포함되지 않는다. 다른 PC에 이미 설정돼 있으면 보존한다. `.env`가 없으면 사용자가 `.env.example`을 복사해 실제 값을 입력한다. **Codex의 `.env` 직접 열람·수정은 별도 사용자 허용이 없으면 하지 않는다.**

`.env.example`은 EC2의 큰 모델·NVIDIA 런타임 기준이다. 가벼운 로컬 테스트에는 아래 값을 사용한다.

```dotenv
OLLAMA_LLM=qwen2.5:1.5b-instruct
OLLAMA_RUNTIME=runc
LLM_NUM_THREAD=2
OLLAMA_TIMEOUT=600
DESKTOP_GUIDANCE_ENABLED=true
BACKEND_BIND_HOST=127.0.0.1
BACKEND_PORT=8000
```

- `DATABASE_URL`, `DATABASE_PASSWORD`: 기존 Supabase 프로젝트의 실제 접속값을 사용자가 입력한다. 기본 Compose는 Supabase 모드이며 로컬 PostgreSQL로 자동 전환되지 않는다.
- `ADMIN_PASSWORD`: 문서 관리에 사용할 기존 서버 공통 비밀번호. 화면 안내 자체는 관리자 로그인이 필요 없다.
- `OLLAMA_EMBED=bge-m3`, `EMBED_DIM=1024` 및 리랭커 설정은 유지한다.
- 로컬에서는 `COMPOSE_PROFILES=edge`를 활성화하지 않는다. EC2 주소·인증서 프록시가 필요 없다.
- `VITE_API_BASE_URL`은 Desktop 연결에 사용하지 않는다. Desktop 기본 API는 `http://127.0.0.1:8000`이다.

Desktop은 자체 `.env`를 자동으로 읽지 않는다. 기본 API를 사용할 때는 Desktop 전용 환경변수를 설정할 필요가 없다. 현재 클라이언트는 HTTP localhost/127.0.0.1의 **8000 포트만 허용**한다.

## 3. 백엔드와 모델 실행

저장소 루트에서 실행한다.

```cmd
docker compose up -d --build
docker compose ps
```

최초 실행에는 Docker 이미지, Qwen, bge-m3, 리랭커 다운로드가 필요할 수 있다. Ollama 모델 준비가 끝난 뒤 백엔드가 시작되므로 느리다는 이유만으로 재시작하지 않는다. 기존 `ollama_data/`, `.reranker_cache/`, `postgres_data/`와 Docker 볼륨은 삭제하지 않는다.

진행 확인이 필요할 때만 제한된 로그를 읽는다. 비밀값이나 문서 본문을 보고서에 복사하지 않는다.

```cmd
docker compose logs --tail 60 ollama backend
docker compose exec ollama ollama list
curl.exe -f http://127.0.0.1:8000/openapi.json -o NUL
```

API 준비 확인은 추론 성공 확인이 아니다. DB 인증 오류·모델 다운로드 실패·리랭커 캐시 오류가 있으면 원인을 구분하고, DB 초기화나 반복 추론으로 우회하지 않는다.

## 4. Desktop 실행

새 CMD에서 실행한다. **다른 PC의 첫 실행에는 `npm ci`가 필요하다.** 이후 의존성 변경이 없다면 `npm start`만 실행한다.

```cmd
cd Desktop
npm ci
npm start
```

작업 디렉터리가 저장소 루트인지 먼저 확인한다. 기존 웹 프론트의 `npm run dev`는 필요 없다. `npm start`는 개발 실행이며 설치 프로그램이나 Windows 자동 시작 등록이 아니다.

이미 Desktop이 실행 중이면 트레이 메뉴의 **종료** 후 다시 실행한다. 창의 `×`는 숨김이다. 사용자 Chrome을 재시작하거나 디버깅 포트·확장 프로그램·새 프로필을 추가하지 않는다.

## 5. 실제 화면 안내 확인, 각 기능 한 번

1. 일반 Chrome에서 공식 복지로 주소를 열고 해당 탭을 활성화한다. 패널이 자동으로 표시되는지 확인한다. 자동 열림 실패를 수동 열림 성공으로 대체하지 않는다.
2. 패널의 **화면 안내**에서 개인정보 없는 목표, 예를 들어 `복지서비스를 찾아보고 싶어`를 입력하고 현재 화면 안내를 요청한다. 개발 시연 모드는 사용하지 않는다.
3. 모델이 선택한 버튼·메뉴가 실제 화면에 있는지 확인한다. Chrome을 다시 활성화했을 때 해당 요소와 강조 위치가 맞는지 확인한다. 패널에 포커스가 있는 동안 강조가 숨는 것은 현재 동작이다.
4. 필요한 화면 이동은 사용자가 직접 수행한 뒤 **화면 변화 확인**을 누른다. 클릭했다는 이유만으로 다음 단계가 완료됐다고 판단하지 않는다. 실제 신청·인증·개인정보 입력까지 진행하지 않는다.
5. 다른 앱으로 전환했을 때 잘못된 강조가 사라지는지 확인한다. 보이지 않는 대상의 방향을 알 수 없으면 방향을 지어내지 않고 보류해야 한다.

Codex 도구로 일반 Chrome과 실제 Desktop을 확인할 수 없으면 사용자에게 해당 조작만 부탁하고, 임의의 데모나 API 대역으로 실제 성공을 주장하지 않는다. 실패한 요청을 반복하지 말고 오류 코드와 해당 시각의 제한된 로그로 원인을 좁힌다.

## 오류 구분과 알려진 한계

| 현상 | 확인할 지점 |
|---|---|
| 자동 열림 실패·Chrome 감지 보류 | 일반 Chrome 선택 탭과 UIA의 주소창·탭 검증 결과 |
| `url_scheme_missing` | UIA 주소에 HTTPS scheme이 없어 검증 불가. 제목으로 우회하거나 HTTPS를 추측하지 않음 |
| 연결 오류·비활성 안내 | 백엔드 준비, `DESKTOP_GUIDANCE_ENABLED=true`, loopback 8000 연결 |
| 모델 안내 보류·시간 초과 | 실제 후보 유무, 서버 오류, 모델 처리 시간. 느림과 잘못된 응답을 구분 |

Chrome 감지 문제에만 저장소 루트에서 다음 읽기 전용 진단을 한 번 실행할 수 있다. 모델 호출·자동 클릭·화면 캡처는 하지 않는다.

```cmd
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File Desktop/native/watch.ps1 -Diagnose
```

현재 공개 라벨 목록 밖의 버튼은 후보에 포함되지 않는다. UIA에서 노출되지 않는 요소도 안내할 수 없다. 여러 모니터·배율과 가림 판정은 실제 환경에서 제한이 있을 수 있다.

**Desktop 화면 안내의 요청 제한은 현재 90초다.** 서버의 `OLLAMA_TIMEOUT=600`과 별개이므로 90초 종료를 모델 실패로 단정하지 않는다. Desktop 취소 이후에도 서버 생성이 이어질 수 있고, 그동안 새 안내 요청은 429로 거절될 수 있다. 즉시 반복 요청하지 않는다.

## 결과 보고와 종료

확인한 브랜치·커밋, 준비 상태, 자동 패널 표시, 실제 모델 안내, 강조 위치, 실패 코드·소요 시간, 미검증 항목을 짧게 보고한다. 비밀값·전체 URL 쿼리·화면 입력값은 기록하지 않는다.

기존 서비스는 유지하고 테스트 전용으로 시작한 프로세스만 종료한다. 사용자가 계속 테스트하도록 켜두라고 요청했다면 유지하고 상태를 알린다. 데이터 삭제, 공용 DB 변경, EC2·Vercel 변경, 커밋·push·PR·merge는 이 테스트 요청에 포함되지 않는다.
