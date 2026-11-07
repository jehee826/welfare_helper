# 공개 edge와 운영 경계

최신 업데이트: 2026-11-08 01:51 KST

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

Uvicorn 시작은 `--no-proxy-headers`를 유지한다. 관리자 로그인은 **제한 키별60초 동안 실패5회 후429**로 제한하며 성공 또는 창 만료 시 해당 키의 실패가 정리된다. 관리 세션은8시간·최대256개, 단일 서버 프로세스 메모리에 보관한다.

`ADMIN_TRUSTED_PROXY_IPS`는 실제 backend 연결 peer의 개별 IP를 담는 JSON 목록이며 기본은 `[]`다. 기본/미신뢰 peer에서는 전달 헤더를 무시하고 peer로 제한한다. CIDR·호스트명·`*`·zone ID는 설정할 수 없다. 실제 proxy 주소를 확인하기 전에는 값을 추측해 추가하지 않는다.

실제 peer가 목록에 있을 때만 단일 `X-Forwarded-For` IP를 제한 키로 사용하며 IPv4/IPv6를 정규화한다. 중복 헤더·쉼표 체인·빈 값·잘못된 IP·45자 초과는 peer로 되돌아간다. `X-Real-IP`와 `Forwarded`는 이 판단에 사용하지 않는다. Caddy는 `header_up X-Forwarded-For {remote_host}`로 직접 접속자의 IP 하나를 덮어쓴다. CDN/다중 프록시 체인은 현재 지원하지 않는다.

이 키는 로그인 실패와 상담 요청 수 구분에만 사용하며 인증·권한이나 request.client를 바꾸지 않는다. 관리자 Bearer 세션과 로컬/화면 요청의 forwarded 헤더 거절은 그대로다. 신뢰 목록이 비어 있으면 프록시 뒤 사용자가 제한을 공유할 수 있으며 실제 proxy 경로와 배포 검증은 별도로 필요하다.

공통 추론 gate는 **프로세스당 실행1·대기0**이다. 사용자별/IP별 사용량 제한이나 다중 인스턴스 공용 제한이 아니며 요청 기한·취소와 별개다. 설정만으로 분산 제한을 제공한다고 표현하지 않는다.

별도로 `POST /api/v1/chat`과 활성화된 `/api/v1/screen/guide`는 같은 IP의 최근60초 `CHAT_RATE_LIMIT_PER_MINUTE`회 예산을 공유한다. 기본30·범위1~600이며 경로를 바꿔도 상한이 늘지 않는다. 익명·관리자 모두 적용하고 로그인·다른 관리자 API에는 적용하지 않는다. 비활성 원격 DOM의404는 차감하지 않는다. 단조 시계와 잠금을 사용하고 프로세스당 최대4096키를 보관한다. 활성 키를 축출하지 않으며 가득 찬 상태의 새 키도 유한한 Retry-After와429로 거절한다.

빈도 제한은 서비스·리랭커·모델/검색 준비 전에 거절하며 detail은 `chat_rate_limited`다. 실행 gate의 `inference_busy`와 구분하고 두 응답 모두429·no-store를 유지한다. 확장·관리자 확인 폼은 안전한 오류 안내 후 대기를 끝내며 자동 재시도하지 않는다. 프로세스 재시작으로 기록이 사라지고 여러 worker/서버가 제한을 공유하지 않는 한계가 있다.

## 재현성의 현재 범위

Python 3.12 Linux AMD64의 backend/worker/dev·빌드 도구를 버전·해시 잠금으로 분리했고 Docker와 모델 없는 CI가 해당 파일을 사용한다. 생성·설치·검사 범위는 [의존성 잠금](../requirements/README.md)을 참고한다. Windows나 다른 CPU 플랫폼의 설치 성공과 원격 CI·배포 성공까지 보장하지 않는다.

Ollama는 기존 실행에서 확인한 0.40.13과 같은 공식 태그로 고정했다. Python/Caddy/Ollama 태그는 이미지 digest 고정이 아니며 OS apt 저장소와 모델 파일도 별도 식별이 필요하다. 프로세스·모델 캐시·GPU deploy 수동 주석 해제 방식을 이 변경으로 바꾸지 않는다.

## 연락처 기록 활성화와 복구

기본 `REFERRAL_RECORDS_ENABLED=false`는 0006 없이 기존 상담을 유지한다. 실제 활성화는 후보 SHA·대상 DB·기존 게시 문서/부서 버전·변경/복구 범위를 확인한 별도 운영 단계다. 앱이나 worker는 DDL을 자동 실행하지 않는다.

1. 읽기 점검으로 `public.contact_referrals` 존재·RLS/권한·기존 department 키와 공개 게시 버전을 확인한다. 새 테이블이면 승인된 대상에 `BackEnd/db/migrations/0006_contact_referrals.sql`만 적용한다. 기존 테이블을 재생성하거나 문서·관리자·다른 자료를 삭제하지 않는다.
2. backend·document-worker를 같은 후보로 준비하되 수집은 OFF로 둔다. 새 확장의 공개 상담 최초 진입에서 입력창 위 고지가 보이고, 질문 전송 직전 `/api/v1/chat/capabilities` 재확인이 성공하는지 확인한다. 수집 상태 확인 실패 시 새 확장은 질문을 전송하지 않는다. 옛 404 서버의 비활성 호환은 운영 수집 ON의 근거가 아니다. 지원하는 클라이언트의 고지 준비를 확인한 뒤에만 활성화한다.
3. 승인된 런타임에서 backend와 worker에 같은 `REFERRAL_RECORDS_ENABLED=true`를 적용한다. 정해진 공개 자료의 합성 연락처 응답 최소 1건으로 기록·관리자 기간/부서 집계·권한을 확인한다. 서버 생성 안내 건수이며 실제 수신·전화 발신·신청 횟수로 해석하지 않는다. 질문·답변·요약·프로필·IP는 기록하지 않는다.
4. 기록은 90일 이상이면 조회·통계에서 제외한다. 기존 worker는 유휴/문서 작업 heartbeat에서 최대 10분마다 만료 기록 물리 삭제를 시도한다. worker 중단이나 삭제 실패 시 물리 삭제가 지연될 수 있으므로 worker 전체를 끄지 않는다. 관리자 기간 삭제는 선택한 KST 날짜·부서 범위와 해당 집계를 함께 줄이며 실제 삭제는 승인 범위에서만 실행한다.
5. 이상이 있으면 양쪽 수집 flag를 OFF로 되돌려 추가 기록을 중단하고 기존 기록은 보존한다. 코드/이미지 복구 시도 때문에 0006 테이블·운영 문서·볼륨을 삭제하지 않는다. flag OFF는 기존 행 삭제나 고지 검증 완료를 뜻하지 않는다.
