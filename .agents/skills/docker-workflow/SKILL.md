---
name: docker-workflow
description: Review or operate welfare_helper Compose and EC2 services while preserving GPU settings, data and existing services.
---

# Docker·EC2 실행

최신 업데이트: 2026-11-04 12:50 KST

1. 실제 docker-compose.yml·Dockerfile·deploy/README와 허용된 운영 override를 읽어 대상 서비스를 확인한다. EC2 운영과 노트북의 격리 검사를 구분하고 PostgreSQL 컨테이너가 배포 DB라고 가정하지 않는다.
2. 기본 기동 명령 docker compose up -d --build가 유지되도록 한다. 실제 EC2에서는 기존 승인된 profile/override/systemd 경로를 함께 사용한다. 모델/GPU 설정을 노트북 편의 때문에 끄거나 새 모델을 내려받지 않는다.
3. .env.example로 설정을 설명한다. 실제 .env 읽기/편집, 전체 환경변수나 비밀이 치환된 Compose 출력은 금지한다. 정적 검사는 더미 환경과 필요한 값만으로 검증한다.
4. 운영 Git 반영·설정 변경·재빌드/재기동은 허용된 범위를 확인한 뒤 지정된 한 운영 담당자가 관련 서비스만 수행한다. 독립 clone이라도 Docker daemon·고정 container_name·포트·볼륨은 공유될 수 있으므로 동시에 Compose를 실행하지 않는다. 코드 수정/PR 병합 승인이 재기동/EC2 변경 승인을 대신하지 않는다. 시작 전 기존 컨테이너·데이터·복구 수단을 구분한다.
5. bind mount·volume·postgres_data/·ollama_data/·인증서/모델 캐시를 보존한다. prune/down -v/초기화를 통상 정리로 사용하지 않는다. DB 버전/마운트 변경은 별도 호환 검토가 필요하다.
6. container running, API readiness, 모델 연결, 문서 worker 게시를 각각 구분해 필요한 응답만 확인한다. systemd enabled 확인과 실제 재부팅 복구 성공도 다르다. 승인 없이 서버를 재부팅해 확인하지 않는다.
7. 시험 때문에 시작한 서비스만 종료하고 종료를 확인한다. 변경·연결 중단·실제 검증·복구 사항을 설계에 전달한다.
