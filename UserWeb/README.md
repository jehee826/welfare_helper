# 곁에 사용자 웹 (UserWeb)

최초 작성: 2026-11-10 · 최신 업데이트: 2026-11-10 13:30 KST

질문 하나를 보내고 답변·연락처를 받는 단발성 복지 안내 화면이다. Chrome 확장의 공개 문서 상담을 줄인 버전이며, 기존 EC2 백엔드의 `/api/v1/chat`을 그대로 사용한다. 새 서버·모델·DB·RAG 로직은 없다.

## 범위

- 포함: 질문 입력(최대 300자), 답변·안내(fallback) 표시, 연락처 안내(`tel:` 링크), 한국어 음성 입력(최대 30초), 기기 내 한국어 음성으로 답변 읽기, 요청 취소, 로딩·오류 안내.
- 제외: 대화 문맥·요약·주제 전환, 추천 질문, 내 정보, 화면/DOM 안내, 로그인, 상담 기록 저장.
- 최근 질문·답변 한 세트만 메모리에 둔다. localStorage·IndexedDB·쿠키를 쓰지 않으며 새로고침하면 초기화된다.

## API 계약

| 요청 | 내용 |
| --- | --- |
| `GET {VITE_API_BASE_URL}/api/v1/chat/capabilities` | 처음 열 때와 질문 전송 직전에 확인. `referral_records_enabled === true`일 때만 수집·90일 보존 안내 표시. 404는 비활성, 그 외 실패는 질문을 보내지 않고 재시도 안내 |
| `POST {VITE_API_BASE_URL}/api/v1/chat` | 본문은 `{"query", "timeout_seconds": 600}`만 보낸다. `credentials: "omit"`, Authorization 헤더 없음 |

- 응답에서 `kind`·`text`·`reason`·`contacts`만 사용하고 나머지 필드는 무시한다. `fallback`은 정상 안내로 표시한다.
- 연락처는 전화번호 형식·종류·확인일 형식을 검증한 항목만 표시한다. `source_url`·`checked_at`은 화면에 표시하지 않는다.
- 422(입력·개인정보), 429, 503, 504/시간 초과(600초), 네트워크 오류를 구분해 안내하고 입력 내용은 보존한다. 자동 재전송은 하지 않는다.
- 취소·시간 초과·새 요청 이후 도착한 이전 응답은 요청 식별자로 버린다. 브라우저 취소는 서버 추론의 즉시 종료를 보장하지 않는다.

## 환경변수

공개 빌드 변수 하나만 쓴다. 비밀값을 넣지 않는다.

```
VITE_API_BASE_URL=https://15.164.190.21
```

값이 없거나 https가 아니면 연결 설정 오류를 표시하고 요청하지 않는다(localhost로 대체 연결하지 않음). 로컬은 `UserWeb/.env.local`(Git 제외)에, Vercel은 프로젝트 환경변수에 등록한다.

## 실행과 검사

```
cd UserWeb
npm ci
npm test
npm run build
npm run dev
```

## Vercel 배포

- 별도 Vercel 프로젝트를 만들고 Root Directory를 `UserWeb`으로 지정한다. 설정은 `vercel.json`(Vite, `dist`)을 따른다.
- 정적 프런트엔드만 배포한다. API 프록시·CORS 우회는 두지 않는다.
- 운영·Preview 주소는 백엔드 담당에게 전달해 CORS 허용 Origin으로 등록한다. 등록 전에는 브라우저에서 EC2 요청이 CORS로 차단된다.
