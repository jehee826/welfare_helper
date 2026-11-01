# RAG 구현 범위

최초 파일명은2026-10-21 설계에서 유지한다. 본문은2026-11-01 현재 경로로 갱신했다.

## 확정 범위

FastAPI·Supabase·Docling·Ollama/LangChain·bge-m3·BM25/RRF·ONNX리랭커를 사용한다. 문서 등록은 자동 처리이며 수동 검토·색인 승인 없이 게시한다. 원문 품질·모델 식별·저장 일관성 검사는 유지한다.

상담은 현재 최소 문서 근거 프롬프트로 실제 검색 원문을 사용한다. 운영 복지 자격 판정, 완전한 환각 방지, 다중 턴 문맥 통합을 완료 기능으로 취급하지 않는다. 기본 생성 모델은 기존 LLM이며 VLM은 선택적 시험 경로다.

세부 기준은 [파이프라인](../welfare-rag-pipeline-design.md), [정확도 설계](../rag-accuracy-design.md), [현재 ERD](../database/복지챗봇.erd)를 따른다. 실행은 [프로젝트 README](../../../README.md), 시험 기록은 로컬 docs/tests/results에서 관리한다.
