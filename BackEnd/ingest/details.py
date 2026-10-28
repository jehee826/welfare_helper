"""지정한 소수 서비스의 공식 상세정보를 읽기 전용으로 조회한다."""

import argparse
import sys

import psycopg2

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.ingest.official import OfficialDataError, fetch_detail
from BackEnd.rag.chunking import ChunkingError
from BackEnd.rag.evidence import EvidenceConsistencyError
from BackEnd.rag.ollama import OllamaError
from BackEnd.rag.repository import PgServiceRepository
from BackEnd.rag.reranker import RerankerError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="공식 상세조회 API를 조회합니다. 직접 벡터 적재는 지원하지 않습니다.")
    parser.add_argument("--service-id", action="append", required=True)
    parser.add_argument("--write", action="store_true", help="호환용 옵션이며 새 저장소에서는 쓰기를 거부합니다.")
    parser.add_argument("--replace-same-basis", action="store_true", help="같은 기준연도 원문 변경을 검토한 경우에만 교체합니다.")
    args = parser.parse_args(argv)
    if args.write:
        print("직접 상세 벡터 적재는 지원하지 않습니다. 문서 API의 분석·검토·게시 경로를 사용하세요.", file=sys.stderr)
        return 1
    ids = list(dict.fromkeys(args.service_id))
    if len(ids) > 5:
        parser.error("쿼터 보호를 위해 한 번에 서비스 ID를 최대 5개만 지정합니다.")
    settings = get_settings()
    repo = PgServiceRepository(lambda: connect(settings), settings.ollama_embed, settings.embed_dim)
    try:
        snapshot = repo.snapshot()
        services = {record.service_id: record for record in snapshot.services}
        if any(sid not in services for sid in ids):
            raise ValueError("대상 DB에 없는 서비스 ID입니다.")
        chunks = [chunk for sid in ids for chunk in fetch_detail(settings, services[sid])]
        if not chunks:
            raise ValueError("공식 상세 섹션이 비어 있습니다.")
        print(f"공식 상세 {len(chunks)}개 섹션 확인. DB·모델은 변경하지 않았습니다.")
        return 0

    except (OfficialDataError, DatabaseNotConfigured, psycopg2.Error, OllamaError, RerankerError, ValueError, OSError, ImportError) as exc:
        reason = (str(exc) if isinstance(exc, (OfficialDataError, DatabaseNotConfigured, OllamaError,
                                               RerankerError, EvidenceConsistencyError, ChunkingError))
                  else "설정·권한·대상 ID·캐시를 확인해 주세요.")
        print(f"공식 상세 보강 실패 ({type(exc).__name__}): {reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
