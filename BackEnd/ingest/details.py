"""지정한 소수 서비스의 공식 상세정보를 명시적으로 보강한다."""

import argparse
import sys

import psycopg2

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.ingest.official import OfficialDataError, fetch_detail
from BackEnd.rag.ollama import OllamaClient, OllamaError
from BackEnd.rag.repository import PgServiceRepository


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="공식 상세조회 API로 지정 서비스만 보강합니다. 기본은 쓰지 않습니다.")
    parser.add_argument("--service-id", action="append", required=True)
    parser.add_argument("--write", action="store_true", help="확인한 대상 DB의 상세 청크만 갱신합니다.")
    args = parser.parse_args(argv)
    ids = list(dict.fromkeys(args.service_id))
    if len(ids) > 5:
        parser.error("쿼터 보호를 위해 한 번에 서비스 ID를 최대 5개만 지정합니다.")
    settings = get_settings()
    repo = PgServiceRepository(lambda: connect(settings), settings.ollama_embed, settings.embed_dim)
    try:
        services = {record.service_id: record for record in repo.all_services()}
        if any(sid not in services for sid in ids):
            raise ValueError("대상 DB에 없는 서비스 ID입니다.")
        chunks = [chunk for sid in ids for chunk in fetch_detail(settings, services[sid])]
        if not chunks:
            raise ValueError("공식 상세 섹션이 비어 있습니다.")
        if not args.write:
            print(f"공식 상세 {len(chunks)}개 섹션 확인. DB·모델은 변경하지 않았습니다.")
            return 0
        existing = {chunk.chunk_id: chunk for chunk in repo.chunks_for_services(ids)}
        changed = [chunk for chunk in chunks if chunk.chunk_id not in existing or
                   chunk.embedding_text() != existing[chunk.chunk_id].embedding_text()]
        llm = OllamaClient(settings.ollama_base_url, settings.ollama_embed, settings.ollama_llm,
                           settings.ollama_timeout, embed_dim=settings.embed_dim)
        vectors = llm.embed([chunk.embedding_text() for chunk in changed]) if changed else []
        count = repo.sync_details(chunks, {chunk.chunk_id: vec for chunk, vec in zip(changed, vectors, strict=True)})
        print(f"공식 상세 {count}개 갱신, 재임베딩 {len(changed)}개. 서비스 메타데이터와 누락 자료는 보존했습니다.")
        return 0
    except (OfficialDataError, DatabaseNotConfigured, psycopg2.Error, OllamaError, ValueError) as exc:
        print(f"공식 상세 보강 실패 ({type(exc).__name__}). 설정·권한·대상 ID를 확인해 주세요.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
