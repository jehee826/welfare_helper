# 복지 안내 챗봇 화면 목업 설계 (하위 프로젝트 ①)

- 작성일: 2026-10-21
- 상태: 승인됨
- 입력 문서: `docs/요구사항분석보완_7조.docx`, `docs/페르소나_보완7조.docx`, `docs/프로세스목록_보완7조.docx`, `docs/프로세스설계_보완_7조.docx`, `docs/이벤트설계_보완_7조.docx`

## 1. 목적과 범위

요구사항(FR-1~FR-6)을 실제 화면으로 검증하기 위한 목업을 만들고 Vercel에 배포한다. RAG/LLM 없이 목 데이터로 동작하며, 이후 하위 프로젝트 ③(통합)에서 그대로 실제 프론트엔드가 된다.

전체 분해:
1. **화면 목업 + Vercel 배포** ← 이 문서
2. RAG 백엔드 (`feature/vectorDB`의 파이프라인 설계 구현)
3. 통합 (실제 API 연결, Ollama 호스팅 위치 결정)

### 범위 밖 (②·③으로 이월)
실제 RAG/LLM 호출, STT 후 AI 문장 다듬기, 조건·이력의 서버 저장, 실제 관리자 인증, 실제 상담원 연결, ERD 불일치 정리

## 2. 기술 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| 프론트엔드 | React + Vite + TypeScript, `FrontEnd/` | 상태가 많은 화면(채팅·사이드패널·관리자)을 컴포넌트로 관리. 목업이 실제 제품으로 이어짐 |
| 목 데이터 | 앱 내부 목 API 모듈(`src/api/`). 인터페이스와 구현 분리 | 의존성 없이 스트리밍 흉내 가능. ③에서 구현만 `fetch`로 교체 |
| 데이터 원천 | 복지로 CSV(`한국사회보장정보원_복지서비스정보_20250722.csv`)의 실제 서비스 약 20건 | 실제 문의처로 FR-4 흐름 시연 |
| 디자인 | codex 브랜치 목업의 '곁에' 디자인 계승 (흑백, 필 버튼), 구조는 FR 기준 재구성 | 팀 결과물 존중 + 요구사항 정합 |
| 라우팅 | `react-router`: `/` 이용자, `/admin` 관리자 | |
| 배포 | 별도 Vercel 프로젝트, Root Directory = `FrontEnd`, SPA rewrite | 루트의 FastAPI 배포 설정과 분리 |
| 테스트 | Vitest + React Testing Library | |

## 3. 이용자 화면 (`/`)

| 영역 | FR | 내용 |
|---|---|---|
| 헤더 | - | 로고 · 글자 크게 토글 · 내 조건 변경 · 지난 상담 |
| 조건 입력 | FR-1 | 나이, 소득구간(기준중위소득 기준, "잘 모름" 포함), 가구형태, 거주지역(시도), 장애여부. "나중에" 가능. localStorage 저장(목업 한정), "내 정보 지우기" 제공 |
| 답변 카드 | FR-1·3 | 서비스명, 요약, 소관부처, 문의처, 복지로 링크, 기준일 |
| 추천 질문 칩 | FR-3 | 매 답변 하단에 다음 질문 후보 버튼. 클릭 시 해당 질문으로 다음 턴 진행 |
| 확인 필요 카드 | FR-4 | 검색 결과 없음/모호 시 추측 답변 대신 담당 부서 연락처와 "상담원 연결 요청" 버튼(목업은 접수 안내만 표시) |
| 마이크 버튼 | FR-2 | Web Speech API로 STT. 미지원 브라우저는 버튼 숨김. 2회 실패 시 버튼 선택 안내 |
| 지난 상담 패널 | FR-5 | 질문별 요약 카드, 원문 펼쳐보기. 데스크톱 우측 사이드바, 모바일 드로어. localStorage |

## 4. 관리자 화면 (`/admin`)

| 영역 | FR | 내용 |
|---|---|---|
| 키 로그인 | FR-6 | 클라이언트 비교이므로 보안이 아님을 화면에 명시. 실제 인증은 ③ |
| 복지제도 관리 | FR-6 | 목록·검색, 추가·수정·삭제 모달(제도명, 신청자격, 지원내용, 신청방법, 담당부서, 문의처), 샘플 질문으로 반영 확인 |
| 통계 | 팀장 페르소나 | 월별 문의 건수·상담원 연결 건수 수치 타일 + 표 (목 데이터) |

관리자 변경 사항은 목업 세션 동안 이용자 화면 검색에도 반영된다(같은 목 저장소 사용).

## 5. 목 API 인터페이스

```ts
interface WelfareApi {
  ask(query: string, profile: UserProfile | null): Promise<ChatAnswer>;
  listPrograms(): Promise<WelfareProgram[]>;
  savePrograms(programs: WelfareProgram[]): Promise<void>;
  getMonthlyStats(): Promise<MonthlyStat[]>;
}
type ChatAnswer =
  | { kind: "answer"; text: string; services: WelfareProgram[]; suggestions: string[] }
  | { kind: "fallback"; text: string; contacts: Contact[]; suggestions: string[] };
```

목 검색: 질문과 프로필에서 키워드를 뽑아 서비스명·요약·태그와 매칭해 점수화. 점수가 기준 미만이면 `fallback`.

## 6. 완료 기준
- `npm run test`, `npm run build` 통과
- 375px 폭에서 가로 스크롤 없음, 키보드로 전 기능 조작 가능
- Vercel 프리뷰 배포 URL 확인
