# 곁에 Chrome 확장

개발자 모드의 압축해제된 MV3 확장이다. 공식 복지로에서만 실행하며 실제 클릭은 사용자가 한다.

1. Chrome의 `chrome://extensions`에서 **개발자 모드**를 켠다.
2. **압축해제된 확장 프로그램을 로드합니다**에서 이 `Extension` 폴더를 선택한다.
3. 기존 일반 Chrome에서 https://www.bokjiro.go.kr/ssis-tbu/index.do 를 연다. 하위 화면의 새로고침에서 **양식 다시 제출** 창이 뜨면 취소하고 이 공개 진입 주소로 돌아간다.
4. **개발용 표시 검사**는 모델 없이 현재 요소 1~3개에 번호·테두리를 적용한다. 제품 답변이나 모델 정확도 검사가 아니다.
5. 스크롤 검사는 **본문 요소 표시**를 누른 뒤 대상이 화면에 남도록 조금 스크롤한다. 상단 메뉴와 fixed/sticky 영역은 제외한다. 대상이 없으면 직접 본문 버튼이 보이도록 내린 뒤 다시 누른다. 대상이 화면 밖으로 나가면 표시를 지운다.

## 화면 질문 실행

Docker Desktop이 정상일 때 저장소 루트 CMD에서 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Extension\start-local.ps1`을 실행한다. 기존 Qwen1.5B/bge-m3 캐시만 사용하며 새 모델을 다운로드하지 않는다.

서버가 준비되면 확장과 복지로 공개 진입 탭을 새로고침하고, 패널의 **연결 설정**에서 `.local\extension-connection.json`을 불러온다. 토큰은 채팅/Git에 보내지 않으며 브라우저를 닫으면 확장 세션에서 지워진다. 질문에 따라 설명만 하거나 실제 요소 0~3개를 표시한다. ‘표시 없이 설명만’ 요청은 대상 0개로 제한한다.

이미지는 기본 off다. **이미지 체크는 화면 첨부 여부이며 모델 선택이 아니다.** 서버의 `OLLAMA_LLM`이 일반 RAG와 화면 상담에 공통 적용된다. 확장 아이콘으로 현재 탭 캡처 권한을 부여한 뒤 **이미지 범위 검사 · 전송 없음**으로 수집 범위만 확인할 수 있다. 이는 VLM 추론 검사가 아니다.

제품 실행에는 Desktop/Electron 앱이나 UIA 수집기가 필요 없다. 다른 사이트, 로그인·인증·개인정보 화면과 닫힌 Shadow DOM은 시연 범위 밖이다. 입력란과 프레임·캔버스·영상 영역은 검게 가리고 나머지 공개 영역만 보낸다. 가림이 있으면 부분 화면으로 전달하며, 모달·열린 선택 목록·닫힌 Shadow DOM은 캡처를 거절한다. 탭·스크롤·화면 크기·마스크 위치가 캡처 중 바뀌어도 전송하지 않는다.

DOM 안전성 검사는 기존 프론트엔드의 개발 의존성 `jsdom`을 사용한다. 저장소 루트에서 `node --test Extension/tests/dom.test.cjs`로 실행한다. 이 검사는 실제 Chrome 설치·표시 검증을 대신하지 않는다.

## 연결 설정과 처리 시간

- `DESKTOP_GUIDANCE_ENABLED`: 화면 상담 API 활성화 여부.
- `DESKTOP_EXTENSION_TOKEN`: 영문·숫자·`_`·`-`로 구성한 32~128자 연결 토큰.
- `DESKTOP_IMAGE_ENABLED`: 이미지 첨부 허용 여부, 모델의 vision 지원도 필요하다.
- `OLLAMA_LLM` / `LLM_NUM_CTX`: 공통 생성 모델과 문맥 길이.
- `OLLAMA_TIMEOUT`: 대기 시간(초), 화면 상담은 올림 후 1~1800초로 제한한다.
- `BACKEND_BIND_HOST`: 화면 상담은 `127.0.0.1`로 바인딩한다.

연결 JSON의 `timeoutSeconds`를 서버 설정에서 내보내 확장에 전달한다. 질문 준비·캡처도 전체 대기 시간에 포함한다. 서버는 남은 예산과 서버 한도 중 작은 값을 사용하고, 메타데이터 조회부터 생성 스트림 종료까지 제한한다. 시간 초과는 HTTP 504, 연결 종료에 따른 취소는 서버에서 499로 분류한다. 이미 끊긴 연결에는 499 응답이 전달되지 않을 수 있으며 자동 재시도하지 않는다. 연결 종료 시 서버도 조회/생성 HTTP 스트림을 닫은 뒤 처리 잠금을 해제한다. Ollama 엔진 자체의 즉시 추론 중단까지 보장하지는 않는다. 기존 3필드 연결 파일/시간 필드 없는 요청만 90초 호환값을 사용한다.

모델·토큰·이미지·시간 설정을 바꾼 뒤에는 실제 서버에서 연결 파일을 다시 내보내고 확장 설정에 다시 불러온다. 아래 명령은 저장소 루트에서 실행하며 파일 내용은 출력하지 않는다.

```cmd
if not exist .local mkdir .local
docker compose exec -T backend python -m BackEnd.desktop_connection /tmp/gyeote-extension-connection.json
docker compose cp backend:/tmp/gyeote-extension-connection.json .local/extension-connection.json
docker compose exec -T backend rm /tmp/gyeote-extension-connection.json
```

## EC2 전환 준비

EC2 실행은 별도 기동·테스트 요청 후 진행한다. 변경 코드가 승인 후 원격에 게시된 경우, 초기 런타임 환경 주입 이후 갱신은 저장소에서 다음 두 명령을 사용한다. 현재 로컬 변경이 자동으로 EC2에 전달되는 것은 아니다.

```sh
git pull --ff-only
docker compose up -d --build
```

기존 Compose에 모델·토큰·이미지·시간 설정을 주입한다. 생성 모델 비교 후보는 기존 [qwen3:30b-a3b-instruct-2507-q4_K_M](https://ollama.com/library/qwen3:30b-a3b-instruct-2507-q4_K_M)(약 19GB)와 같은 규모의 [qwen3-vl:30b-a3b-instruct-q4_K_M](https://ollama.com/library/qwen3-vl:30b-a3b-instruct-q4_K_M)(약 20GB)이며 아직 채택하지 않았다. VLM은 Ollama 0.12.7 이상이 필요하다. 파일 크기는 VRAM 사용량이 아니며, 마지막 알려진 T4 약 15GiB에서는 전체 GPU 적재를 보장할 수 없다. 실제 GPU/RAM·CPU offload·최대 메모리를 확인해야 한다.

서버에서는 `mkdir -p .local` 후 위 Docker 내보내기·복사·임시 파일 제거 명령을 사용한다. 만든 비공개 JSON만 Windows에 안전하게 전달한다. 8000/11434는 외부에 공개하지 않고, 공개 Caddy의 `/api/v1/desktop/*` 차단을 확인한다. Windows의 8000 포트가 비어 있을 때 SSH 터널로 확장의 고정 주소를 유지한다.

```cmd
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -L 127.0.0.1:8000:127.0.0.1:8000 -i 키파일경로 ubuntu@현재IP
```

동일 공개 화면·질문·DOM·이력으로 LLM과 VLM을 순차 비교하고 생성 모델 두 개를 동시에 상주시키지 않는다. 이미지 off/on, 답변 근거·대상 일치·시간·최대 메모리를 확인한다. 모델이 다르면 전체 구성 비교이며 이미지 효과만 입증한 것은 아니다. 교체 전 모델 태그/digest·문맥·옵션을 확보하고, 채택 전에는 원래 설정으로 복귀한다. bge-m3/1024·리랭커·DB·모델 캐시는 유지한다.
