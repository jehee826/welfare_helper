---
name: vercel-workflow
description: Build and verify the administrator-only React frontend on Vercel and its EC2 HTTPS API integration.
---

# 관리자 웹·Vercel

최신 업데이트: 2026-11-04 12:50 KST

1. FrontEnd/package.json·FrontEnd/vercel.json·현재 관리자 설계와 연결된 Vercel 프로젝트/저장소를 확인한다. 기존 프로젝트와 main 추적을 유지하며 임의 새 프로젝트를 만들지 않는다.
2. 이 프로젝트의 Vercel 대상은 React/Vite 정적 관리자 웹이다. FastAPI·Ollama·문서 worker를 Vercel로 옮기거나 지운 일반 챗봇 화면을 복원하지 않는다. 모바일 사용자 앱은 별도 승인 설계 범위다.
3. 공개 API 주소가 기존 EC2 HTTPS를 가리키는지 확인한다. 사용자 브라우저에 localhost/SSH 주소·서버 키·관리자 비밀번호를 빌드 값으로 넣지 않는다. build 시점의 공개 변수와 실행 서버 환경을 구분한다.
4. 필요한 FrontEnd 검사/타입/빌드만 수행한다. lockfile·실제 스크립트를 재사용하고 unrelated 의존성 갱신을 하지 않는다. UI 변경 시 로그인 실패·만료·업로드 상태·교체 실패와 기존 게시본 보존의 소비자 계약을 확인한다.
5. 배포/환경 변경은 완성된 범위와 승인에 따라 한 담당자가 수행한다. main 추적의 자동 배포가 켜져 있으면 PR 병합도 배포를 유발할 수 있으므로 병합 준비에 그 영향과 EC2 API 호환을 표시한다. 별도 배포 명령이 없다는 이유로 운영 영향 없음이라고 하지 않는다. Vercel 연결 도구를 우선하고 기능 부족 시 설명한 뒤 지원 경로를 사용한다. 버전 의존 CLI/API는 공식 문서로 확인한다. 실제 .env를 읽거나 편집하지 않는다.
6. 로컬 dist 빌드, 배포 ready, 관리자 라우트 열기, EC2 API 접근/인증, 실제 문서 업로드/게시를 따로 검증한다. SPA fallback의 HTTP200은 관리자 인증 또는 API 성공이 아니다. 정적 JS 접근 제한과 서버의 관리자 API 보호도 혼동하지 않는다.
7. 배포 보호는 지원 인증으로 처리한다. 테스트 편의를 위한 인증/CORS 우회·보호 해제는 하지 않는다. 실제 배포 URL/커밋·검사·미확인을 설계에 전달한다.
