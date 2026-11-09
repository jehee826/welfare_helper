# 공개 edge와 운영 경계

최신 업데이트: 2026-11-09 14:18 KST

`Caddyfile`의 공개 프록시는 다음 경계를 사용한다. 백엔드8000·Ollama11434를 직접 외부 공개하지 않고 edge로만 접근하게 한다. 로컬/내부 API 경로 자체를 삭제하는 설정은 아니다.

| 경로 | 공개 edge 동작 |
|---|---|
| `/health` | 단순 API 상태 확인을 backend에 전달 |
| `/api/v1/chat`, `/api/v1/chat/capabilities`, `/api/v1/conversation/summary`, `/api/v1/admin/*` | 상담·지원 기능 확인·요약·관리자 API에 전달, 서버 인증·게시 범위 유지 |
| `/health/*`, `/docs`·`/redoc` 및 하위 경로, `/openapi.json`, `/debug` 및 하위 경로 | 404, DB/의존성 점검·구성 정보·API 문서/진단을 공개하지 않음 |
| `/api/v1/desktop` 및 하위 경로 | 기존404 유지, 로컬/SSH 화면 안내 전용 |

`/api/v1/screen/guide`는 별도의 공개 익명 DOM 전용 경로다. `REMOTE_DOM_GUIDANCE_ENABLED=false`가 기본이며 비활성·Vercel에서는404, 활성화된 서버에서도 원격 확장의 명시 옵션이 있어야 UI에서 선택할 수 있다. 이미지 키·제목·URL·프로필·문서 맥락·임의 입력 필드는 받지 않고64KiB 본문과 공통 gate/deadline/단절·안전 오류를 적용한다. 기존 desktop 차단을 해제하는 설정이 아니다. 실제 원격 전송·배포는 별도 검증 범위다.

실제 DNS/TLS·프록시 배포 적용은 별도 확인이 필요하다. 정적 경로 검사는 Caddy 런타임 라우팅 성공을 의미하지 않는다. [Caddy path matcher](https://caddyserver.com/docs/caddyfile/matchers#path)는 기본 정확 일치이며 하위 경로는 `/*`로 명시한다. [validate](https://caddyserver.com/docs/command-line#caddy-validate)는 서비스를 시작하지 않는 설정 검사지만 실제 배포·인증서·요청 경로 검증을 대신하지 않는다.

## 로그인과 추론 제한

관리자 후보 검증은 Vercel에서 확인한 `welfare-helper-git-<branch>-welfare7.vercel.app`의 HTTPS Origin 하나를 `CORS_ALLOWED_ORIGINS`에 명시해 진행할 수 있다. 브랜치 별칭을 자동 허용하는 정규식 CORS는 사용하지 않으며 기본 허용값은 기존 운영 주소다. 다른 팀/프로젝트·와일드카드·임의 배포 해시 주소·경로/쿼리/포트가 붙은 Origin은 설정 검증에서 거절한다. 실제 등록/복구는 승인된 서버 런타임 변경으로 수행하고 `allow_credentials=false`·관리자 Bearer 인증은 유지한다.

Uvicorn 시작은 `--no-proxy-headers`를 유지한다. 관리자 로그인은 **제한 키별60초 동안 실패5회 후429**로 제한하며 성공 또는 창 만료 시 해당 키의 실패가 정리된다. 관리 세션은8시간·최대256개, 단일 서버 프로세스 메모리에 보관한다.

`ADMIN_TRUSTED_PROXY_IPS`는 실제 backend 연결 peer의 개별 IP를 담는 JSON 목록이며 기본은 `[]`다. 기본/미신뢰 peer에서는 전달 헤더를 무시하고 peer로 제한한다. CIDR·호스트명·`*`·zone ID는 설정할 수 없다. 실제 proxy 주소를 확인하기 전에는 값을 추측해 추가하지 않는다.

실제 peer가 목록에 있을 때만 단일 `X-Forwarded-For` IP를 제한 키로 사용하며 IPv4/IPv6를 정규화한다. 중복 헤더·쉼표 체인·빈 값·잘못된 IP·45자 초과는 peer로 되돌아간다. `X-Real-IP`와 `Forwarded`는 이 판단에 사용하지 않는다. Caddy는 `header_up X-Forwarded-For {remote_host}`로 직접 접속자의 IP 하나를 덮어쓴다. CDN/다중 프록시 체인은 현재 지원하지 않는다.

이 키는 로그인 실패와 상담 요청 수 구분에만 사용하며 인증·권한이나 request.client를 바꾸지 않는다. 관리자 Bearer 세션과 로컬/화면 요청의 forwarded 헤더 거절은 그대로다. 신뢰 목록이 비어 있으면 프록시 뒤 사용자가 제한을 공유할 수 있으며 실제 proxy 경로와 배포 검증은 별도로 필요하다.

공통 추론 gate는 **프로세스당 실행3·대기0**이다. 상담·요약·문서 확인·화면 안내가 같은 3칸을 공유하고 네 번째 요청은 즉시429로 거절한다. 취소·기한 초과가 발생해도 동기 실행이 끝나기 전에 슬롯을 반환하지 않는다. 사용자별/IP별 사용량 제한이나 다중 인스턴스 공용 제한은 아니며 Uvicorn 프로세스를 늘려 상한을 우회하지 않는다.

별도로 `POST /api/v1/chat`과 활성화된 `/api/v1/screen/guide`는 같은 IP의 최근60초 `CHAT_RATE_LIMIT_PER_MINUTE`회 예산을 공유한다. 기본30·범위1~600이며 경로를 바꿔도 상한이 늘지 않는다. 익명·관리자 모두 적용하고 로그인·다른 관리자 API에는 적용하지 않는다. 비활성 원격 DOM의404는 차감하지 않는다. 단조 시계와 잠금을 사용하고 프로세스당 최대4096키를 보관한다. 활성 키를 축출하지 않으며 가득 찬 상태의 새 키도 유한한 Retry-After와429로 거절한다.

빈도 제한은 서비스·리랭커·모델/검색 준비 전에 거절하며 detail은 `chat_rate_limited`다. 실행 gate의 `inference_busy`와 구분하고 두 응답 모두429·no-store를 유지한다. 확장·관리자 확인 폼은 안전한 오류 안내 후 대기를 끝내며 자동 재시도하지 않는다. 프로세스 재시작으로 기록이 사라지고 여러 worker/서버가 제한을 공유하지 않는 한계가 있다.

## 재현성의 현재 범위

Python 3.12 Linux AMD64의 backend/worker/dev·빌드 도구를 버전·해시 잠금으로 분리했고 Docker와 모델 없는 CI가 해당 파일을 사용한다. 생성·설치·검사 범위는 [의존성 잠금](../requirements/README.md)을 참고한다. Windows나 다른 CPU 플랫폼의 설치 성공과 원격 CI·배포 성공까지 보장하지 않는다.

Ollama는 기존 실행에서 확인한 0.40.13과 같은 공식 태그로 고정했다. Python/Caddy/Ollama 태그는 이미지 digest 고정이 아니며 OS apt 저장소와 모델 파일도 별도 식별이 필요하다. 프로세스·모델 캐시·GPU deploy 수동 주석 해제 방식을 이 변경으로 바꾸지 않는다.

## 동시 추론·모델 상주 설정

Compose는 기존 Ollama에 `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_QUEUE=3`, `OLLAMA_MAX_LOADED_MODELS=2`, `OLLAMA_KEEP_ALIVE=-1`을 지정한다. 앱의 실행3·대기0과 Ollama의 생성 병렬1·내부 유한 대기는 별개이며 HTTP 요청의 FIFO를 보장하지 않는다. 두 모델 허용은 검색용 bge-m3 때문에 Qwen3를 매번 교체하는 일을 줄이고, 음수 keep-alive는 한 번 로드한 모델의 유휴 만료를 막는다. 서버 시작이나 readiness가 모델을 자동으로 로드하지는 않는다. 승인된 운영 단계에서 기존 설치 모델만 워밍업한 뒤 실제 `/api/ps`의 동시 상주를 확인한다. [Ollama 메모리·동시 처리 설명](https://docs.ollama.com/faq), [사용 버전의 설정 구현](https://github.com/ollama/ollama/blob/v0.40.13/envconfig/config.go)을 참고한다. 현재 적용값과 실행 결과는 [실행 계획](../docs/plan/merge_plan.md)과 [인계](../docs/plan/handoff.md)를 함께 확인한다.

Compose의 backend와 worker는 `EMBED_CPU_ONLY=true`를 기본으로 사용한다. 이 설정은 `/api/embed`에만 `options.num_gpu=0`을 보내 검색용 bge-m3를 CPU로 분리한다. 생성 모델의 GPU 옵션·기존 모델/다이제스트·벡터 차원은 바꾸지 않는다. Compose 밖의 설정 기본값은 기존 동작인 false이며 필요하면 환경에서 명시한다. 실제 T4에서 병렬3/ctx16384의 Qwen3 준비 후 GPU 임베딩 모델이 축출됐으므로, 두 모델 적재 허용만으로 공존을 판정하지 않는다. CPU 분리 반영 후 `/api/ps`의 두 모델·임베딩 GPU 사용0·생성 모델 유지·검색 지연을 다시 확인한다.

병렬 수는 컨텍스트 메모리도 늘린다. 모델 2개 허용만으로 GPU/RAM에 모두 들어간다고 보장하지 않는다. 기존 모델·컨텍스트/출력 예산·GPU runtime·캐시를 유지하며 현재 속도 판정은 단건 전송부터 최종 HTTP 응답까지30초 우선, 품질을 유지한 조정으로 달성하지 못하면50초→60초 단계로 진행한다. 큐 대기도 전체 기한에 포함하고 모델 준비/첫 요청·상주 요청을 구분한다. 실제 Chrome 최종 표시·품질과 GPU/호스트 메모리는 별도 확인하며 생성 병렬1에서3건 동시 생성을 완료 조건으로 삼지 않는다. 기존 worker의 2 CPU/4GB 제한과 작업별 Docling 자식 종료를 유지하고 문서 임베딩 업로드와 성능 시험을 겹치지 않는다.

실제 반영은 후보 SHA·대상 서비스·워밍업/추론 상한·중단/복구 범위를 정한 뒤 수행한다. 메모리 부족·설정과 다른 실행·시간 목표 미달이면 성공으로 처리하지 않는다. 새 모델 다운로드·교체·유료 증설을 자동 수행하지 않는다. 설정 복구 시 이전 이미지와 병렬/상주 값만 되돌리고 모델/문서/인증 볼륨은 보존한다.

## 연락처 기록 활성화와 복구

기본 `REFERRAL_RECORDS_ENABLED=false`는 0006 없이 기존 상담을 유지한다. 실제 활성화는 후보 SHA·대상 DB·기존 게시 문서/부서 버전·변경/복구 범위를 확인한 별도 운영 단계다. 앱이나 worker는 DDL을 자동 실행하지 않는다.

1. 읽기 점검으로 `public.contact_referrals` 존재·RLS/권한·기존 department 키와 공개 게시 버전을 확인한다. 새 테이블이면 승인된 대상에 `BackEnd/db/migrations/0006_contact_referrals.sql`만 적용한다. 기존 테이블을 재생성하거나 문서·관리자·다른 자료를 삭제하지 않는다.
2. backend·document-worker를 같은 후보로 준비하되 수집은 OFF로 둔다. 새 확장의 공개 상담 최초 진입에서 입력창 위 고지가 보이고, 질문 전송 직전 `/api/v1/chat/capabilities` 재확인이 성공하는지 확인한다. 수집 상태 확인 실패 시 새 확장은 질문을 전송하지 않는다. 옛 404 서버의 비활성 호환은 운영 수집 ON의 근거가 아니다. 지원하는 클라이언트의 고지 준비를 확인한 뒤에만 활성화한다.
3. 승인된 런타임에서 backend와 worker에 같은 `REFERRAL_RECORDS_ENABLED=true`를 적용한다. 정해진 공개 자료의 합성 연락처 응답 최소 1건으로 기록·관리자 기간/부서 집계·권한을 확인한다. 서버 생성 안내 건수이며 실제 수신·전화 발신·신청 횟수로 해석하지 않는다. 질문·답변·요약·프로필·IP는 기록하지 않는다.
4. 기록은 90일 이상이면 조회·통계에서 제외한다. 기존 worker는 유휴/문서 작업 heartbeat에서 최대 10분마다 만료 기록 물리 삭제를 시도한다. worker 중단이나 삭제 실패 시 물리 삭제가 지연될 수 있으므로 worker 전체를 끄지 않는다. 관리자 기간 삭제는 선택한 KST 날짜·부서 범위와 해당 집계를 함께 줄이며 실제 삭제는 승인 범위에서만 실행한다.
5. 이상이 있으면 양쪽 수집 flag를 OFF로 되돌려 추가 기록을 중단하고 기존 기록은 보존한다. 코드/이미지 복구 시도 때문에 0006 테이블·운영 문서·볼륨을 삭제하지 않는다. flag OFF는 기존 행 삭제나 고지 검증 완료를 뜻하지 않는다.

## 관리자 비밀번호 영속 전환

`ADMIN_CREDENTIALS_FILE` 미설정은 기존 서버 공통 비밀번호 로그인을 유지하며 재발급은 비활성이다. 설정한 뒤에는 파일이 없거나 손상됐을 때 옛 환경 비밀번호로 자동 복귀하지 않는다. 실제 초기화·재발급·backend 재생성은 관리자 접근을 바꾸므로 후보 SHA·시점·복구 범위를 승인받은 운영 단계에서만 수행한다. DB 스키마는 변경하지 않는다.

1. Compose의 `admin_credentials` 볼륨과 `/app/.local/admin-credentials` 마운트를 확인한다. 후보 이미지의 `BackEnd.admin.credentials`가 포함됐는지, 파일이 이미 존재하는지·버전·권한과 남은 디스크만 확인한다. 해시/평문 비밀번호·토큰·환경 전체를 출력하지 않는다.
2. 새 파일일 때 기존의 승인된 서버 런타임 비밀번호를 이용해 최초 이관한다. 아래 명령은 준비 예시이며 실제 `.env` 내용을 읽거나 비밀번호를 명령 인자로 넣지 않는다. 동일 볼륨에 이미 파일이 있으면 initialize는 409로 중단하며 덮어쓰지 않는다.

   ```sh
   docker compose run --rm --no-deps --entrypoint python -e ADMIN_CREDENTIALS_FILE=/app/.local/admin-credentials/credentials.json backend -m BackEnd.admin.credentials initialize
   ```

3. 이관 성공과 파일 `0600`·볼륨 보존을 확인한 뒤 같은 경로를 승인된 backend 런타임에 적용한다. backend만 후보로 반영하고 기존 비밀번호 로그인·새 관리자 세션을 확인한다. 이때 초기 이관 값은 기존 비밀번호이며 임의로 바꾸지 않는다.
4. 별도로 정한 실제 전환 시점에 관리자 웹에서 현재 비밀번호 재확인 → 32자 새 비밀번호 일회 표시 → 수신 뒤 자동 적용을 검증한다. 발급 권한은 60초이며 새 값을 화면 메모리 외 저장소나 일반 로그에 보관하지 않는다. 적용 뒤 구 세션·구 비밀번호를 거절하고 새 값으로 로그인한 다음 컨테이너 재생성 후에도 새 로그인이 유지되는지 확인한다.
5. 적용 응답이 유실되면 화면에 받은 새 값으로 먼저 로그인해 적용 여부를 확인한다. 발급 응답을 받지 못해 적용이 시작되지 않은 경우 기존 비밀번호가 유지된다. 적용된 새 값을 잃은 상태를 옛 해시 복원·파일 삭제·환경 비밀번호 강제 복귀로 처리하지 않는다. 운영 권한으로 필요한 복구 범위를 다시 정하고, 코드 복구 중에도 현재 버전의 해시 볼륨은 보존한다. 분실 비밀번호 복구 API는 제공하지 않는다.
