---
name: extension-workflow
description: Implement and verify the floating Chrome extension UI, local conversations, public DOM guidance and voice lifecycle.
---

# 확장 UI·상태·검증

최신 업데이트: 2026-11-10 10:46 KST

1. merge_plan.md의 배정된 태스크와 Extension/README·manifest·protocol 및 관련 UI/worker만 읽는다. 자신의 작업 루트·전용 브랜치(`claude/feat-Extension`)·Extension 허용 경로를 확인한다. content.js/worker.js/protocol.js/conversations.js/conversation-panel.js의 작성자는 한 명이며 공유 API 변경은 서버 담당과 먼저 맞춘다. 공통 CI/루트 설정을 직접 고치지 말고 지정 담당에게 전달한다.
   현재 작업 루트·브랜치·담당은 handoff.md, 변경 범위·완료 기준은 merge_plan.md와 연결된 devlog.md를 따른다. 원래 설치 폴더에 개발 파일을 복사해 덮지 않는다. 실제 설치본 적용은 해당 태스크의 검토된 버전·적용 경로가 준비된 뒤 수행하며 그전에는 독립 대역 검사를 진행한다.
2. EC2 HTTPS 전용 연결과 질문/안내 모드 경계를 유지한다. 문서 질문에 화면/이미지를, 공개 DOM 안내에 저장 프로필/상담/관리자 자격 증명을 혼입하지 않는다. 저장 정보는 기본 OFF·구 profile 미전송이며, W13의 현재 프로필 revision과 별도 제공 동의가 유효한 명시 ON에만 허용 5필드(나이·소득·가구·지역·장애 여부)를 최종 생성에 제공하고 검색·준비에는 사용하지 않는다. 직접 발화·최신 정정과 보호 대상 구분을 우선하며 OFF 전환 때 화면 기록은 남기고 파생 요약·조건·문서 참조까지 새 자동 맥락으로 분리한다. DOM 입력값·민감 화면·확장 자체 UI는 수집하지 않는다.
3. chrome.storage.local은 worker의 검증된 sender·TRUSTED_CONTEXTS·직렬 revision 경로로 쓴다. content에서 임의 키를 쓰거나 기존 상담/프로필을 초기화하지 않는다. 최근30문답·원자 저장·quota/실패·주제 경계를 유지한다.
4. 요청/저장/음성의 늦은 결과는 request ID·revision·현재 모드/대상으로 구분한다. 취소 후 이력 재삽입, 삭제 후 복구, 모드/권한 변경 뒤 응답 혼입을 막는다. 시간 경계/새 설정/요약 기능은 배정된 태스크에서만 추가한다.
5. 패널 위치·크기·접기·키보드·포커스·200%확대·좁은 viewport를 해당 변경 범위에서 확인한다. DOM 선택은 실제 가시성/유효 ID/현재 스냅샷 기준으로 검증하고 클릭은 사용자에게 맡긴다. 자동 클릭·이미지 캡처를 추가하지 않는다.
6. node --test의 관련 기존 검사와 필요한 구문 확인부터 한다. Node 대역은 실제 Chrome/마이크/음성합성/서버 추론 성공이 아니다. 외부 호출 없이 재현 가능한 저장/시간/resize 경계부터 확인한다.
7. 실제 확장 검증은 한 담당자만 수행한다. 다른 checkout을 새 확장으로 등록하지 않는다. 설치 확장이 연결된 checkout에서 기능 브랜치를 쓰면 다시 로드 시 미검토 코드가 적용되므로 지정된 시점에만 다시 로드한다. 기존 설치 폴더/프로필·시험 코드 버전을 먼저 확인하고, 검토된 산출물을 기존 설치 경로에 적용하는 방법/범위를 확정한 뒤 다시 로드한다. 상대 소스 폴더에 파일을 덮어씌우지 않는다. 삭제·재설치·Chrome 강제 재시작·전체 상담 삭제를 기본 절차로 사용하지 않는다. 도구 접근 거절을 우회하지 않는다.
8. 사용자만 가능한 시험은 수정 항목의 내부 확인을 끝낸 후 묶어서 짧은 선택형 카드로 요청한다. 최소 조작과 기대결과를 적고 기존 자료는 보존한다. 변경·검사·실제UI/사용자 확인·미검증을 설계에 전달한다.
