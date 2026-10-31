# 곁에 Chrome 확장

개발자 모드의 압축해제된 MV3 확장이다. 공식 복지로에서만 실행하며 실제 클릭은 사용자가 한다.

1. Chrome의 `chrome://extensions`에서 **개발자 모드**를 켠다.
2. **압축해제된 확장 프로그램을 로드합니다**에서 이 `Extension` 폴더를 선택한다.
3. 기존 일반 Chrome에서 https://www.bokjiro.go.kr/ssis-tbu/index.do 를 연다. 이미 열린 페이지라면 새로고침한다.
4. **개발용 표시 검사**는 모델 없이 현재 요소 1~3개에 번호·테두리를 적용한다. 제품 답변이나 모델 정확도 검사가 아니다.
5. 스크롤 검사는 **본문 요소 표시**를 누른 뒤 대상이 화면에 남도록 조금 스크롤한다. 상단 메뉴와 fixed/sticky 영역은 제외한다. 대상이 없으면 직접 본문 버튼이 보이도록 내린 뒤 다시 누른다. 대상이 화면 밖으로 나가면 표시를 지운다.

## 화면 질문 실행

Docker Desktop이 정상일 때 저장소 루트 CMD에서 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File Extension\start-local.ps1`을 실행한다. 기존 Qwen1.5B/bge-m3 캐시만 사용하며 새 모델을 다운로드하지 않는다.

서버가 준비되면 확장과 복지로 탭을 새로고침하고, 패널의 **연결 설정**에서 `.local\extension-connection.json`을 불러온다. 토큰은 채팅/Git에 보내지 않으며 브라우저를 닫으면 확장 세션에서 지워진다. 질문에 따라 설명만 하거나 실제 요소 0~3개를 표시한다.

이미지는 기본 off다. 확장 아이콘을 눌러 현재 탭 캡처 권한을 부여한 뒤 **이미지 범위 검사 · 전송 없음**으로 공개 화면의 수집 범위만 확인할 수 있다. 이는 VLM 추론 검사가 아니다. 자세한 실행·EC2 전환·복귀 절차는 `Desktop/LOCAL_TEST_HANDOFF.md`를 참고한다.

Electron·Windows UIA는 실행하지 않는다. 다른 사이트, 로그인·인증·개인정보 화면, 교차 출처 iframe과 닫힌 Shadow DOM은 시연 범위 밖이다.

DOM 안전성 검사는 기존 프론트엔드의 개발 의존성 `jsdom`을 사용한다. 저장소 루트에서 `node --test Extension/tests/dom.test.cjs`로 실행한다. 이 검사는 실제 Chrome 설치·표시 검증을 대신하지 않는다.
