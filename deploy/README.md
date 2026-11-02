# 공개 edge와 운영 경계

`Caddyfile`의 공개 프록시는 다음 경계를 사용한다. 백엔드8000·Ollama11434를 직접 외부 공개하지 않고 edge로만 접근하게 한다. 로컬/내부 API 경로 자체를 삭제하는 설정은 아니다.

| 경로 | 공개 edge 동작 |
|---|---|
| `/health` | 단순 API 상태 확인을 backend에 전달 |
| `/api/v1/chat`, `/api/v1/admin/*` | 기존 상담·관리자 인증/문서 API에 전달, 서버 인증·게시 범위 유지 |
| `/health/*`, `/docs`·`/redoc` 및 하위 경로, `/openapi.json`, `/debug` 및 하위 경로 | 404, DB/의존성 점검·구성 정보·API 문서/진단을 공개하지 않음 |
| `/api/v1/desktop` 및 하위 경로 | 기존404 유지, 로컬/SSH 화면 안내 전용 |

실제 DNS/TLS·프록시 배포 적용은 별도 확인이 필요하다. 정적 경로 검사는 Caddy 런타임 라우팅 성공을 의미하지 않는다. [Caddy path matcher](https://caddyserver.com/docs/caddyfile/matchers#path)는 기본 정확 일치이며 하위 경로는 `/*`로 명시한다. [validate](https://caddyserver.com/docs/command-line#caddy-validate)는 서비스를 시작하지 않는 설정 검사지만 실제 배포·인증서·요청 경로 검증을 대신하지 않는다.

## 로그인과 추론 제한

Uvicorn 시작은 `--no-proxy-headers`를 유지한다. 관리자 로그인은 **제한 키별60초 동안 실패5회 후429**로 제한하며 성공 또는 창 만료 시 해당 키의 실패가 정리된다. 관리 세션은8시간·최대256개, 단일 서버 프로세스 메모리에 보관한다.

`ADMIN_TRUSTED_PROXY_IPS`는 실제 backend 연결 peer의 개별 IP를 담는 JSON 목록이며 기본은 `[]`다. 기본/미신뢰 peer에서는 전달 헤더를 무시하고 peer로 제한한다. CIDR·호스트명·`*`·zone ID는 설정할 수 없다. 실제 proxy 주소를 확인하기 전에는 값을 추측해 추가하지 않는다.

실제 peer가 목록에 있을 때만 단일 `X-Forwarded-For` IP를 제한 키로 사용하며 IPv4/IPv6를 정규화한다. 중복 헤더·쉼표 체인·빈 값·잘못된 IP·45자 초과는 peer로 되돌아간다. `X-Real-IP`와 `Forwarded`는 이 판단에 사용하지 않는다. Caddy는 `header_up X-Forwarded-For {remote_host}`로 직접 접속자의 IP 하나를 덮어쓴다. CDN/다중 프록시 체인은 현재 지원하지 않는다.

이 키는 로그인 실패와 상담 요청 수 구분에만 사용하며 인증·권한이나 request.client를 바꾸지 않는다. 관리자 Bearer 세션과 로컬/화면 요청의 forwarded 헤더 거절은 그대로다. 신뢰 목록이 비어 있으면 프록시 뒤 사용자가 제한을 공유할 수 있으며 실제 proxy 경로와 배포 검증은 별도로 필요하다.

공통 추론 gate는 **프로세스당 실행1·대기0**이다. 사용자별/IP별 사용량 제한이나 다중 인스턴스 공용 제한이 아니며 요청 기한·취소와 별개다. 설정만으로 분산 제한을 제공한다고 표현하지 않는다.

별도로 `POST /api/v1/chat`은 IP별 최근60초에 `CHAT_RATE_LIMIT_PER_MINUTE`회, 기본30·범위1~600으로 제한한다. 익명·관리자 모두 같은 경로에 적용하며 로그인·다른 관리자 API에는 적용하지 않는다. 단조 시계와 잠금을 사용하고 프로세스당 최대4096키를 보관한다. 활성 키를 축출하지 않으며 가득 찬 상태의 새 키도 유한한 Retry-After와429로 거절한다.

빈도 제한은 서비스·리랭커·모델/검색 준비 전에 거절하며 detail은 `chat_rate_limited`다. 실행 gate의 `inference_busy`와 구분하고 두 응답 모두429·no-store를 유지한다. 확장·관리자 확인 폼은 안전한 오류 안내 후 대기를 끝내며 자동 재시도하지 않는다. 프로세스 재시작으로 기록이 사라지고 여러 worker/서버가 제한을 공유하지 않는 한계가 있다.

## 재현성의 현재 범위

Python은3.12 범위이고 직접 의존성 일부만 고정했다. Python 전체 전이 의존성·해시 잠금과 깨끗한 설치 CI는 완료하지 않았다. 프런트는 package-lock과 npm ci 경로가 있지만 이것만으로 깨끗한 전체 설치·배포를 검증한 것은 아니다.

Docker의 Python/Caddy 버전 태그와 Ollama latest는 이미지 digest 고정이 아니다. apt·pip 자체 업그레이드와 플랫폼별 패키지 선택도 재현성에 영향을 준다. 검증된 근거 없이 버전을 추측해 고정하거나 현재 환경을 업그레이드하지 않는다. 완전한 잠금 생성·깨끗한 설치·실제 이미지/모델 식별 검증은 승인 환경에서 별도로 수행한다.
