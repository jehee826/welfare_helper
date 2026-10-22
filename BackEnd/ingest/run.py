"""복지로 CSV 검증과 변경된 overview 청크의 증분 적재를 한다."""

import argparse
import sys
import time

import psycopg2

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.ingest.csv_loader import DEFAULT_CSV, CsvFormatError, chunk_text, load_csv
from BackEnd.rag.ollama import OllamaClient, OllamaError
from BackEnd.rag.repository import PgServiceRepository


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="복지서비스 CSV를 검증하고 변경된 청크만 벡터 DB에 적재합니다.")
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--encoding", default="cp949")
    parser.add_argument("--dry-run", action="store_true", help="모델·DB 호출 없이 CSV와 청크를 검증합니다.")
    parser.add_argument("--check-embeddings", action="store_true", help="DB 호출 없이 실제 임베딩을 검증합니다.")
    parser.add_argument("--prune", action="store_true", help="CSV에서 빠진 서비스와 청크를 삭제합니다.")
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args(argv)
    if not 1 <= args.batch_size <= 128:
        parser.error("--batch-size는 1~128이어야 합니다.")
    if args.prune and (args.dry_run or args.check_embeddings):
        parser.error("--prune은 실제 적재에서만 사용할 수 있습니다.")

    try:
        records = load_csv(args.csv, encoding=args.encoding)
    except (CsvFormatError, OSError, UnicodeError) as exc:
        print(f"CSV 검증 실패: {exc}", file=sys.stderr)
        return 1
    texts = {record.service_id: chunk_text(record) for record in records}
    print(f"CSV 검증 완료: {len(records)}건", flush=True)
    if args.dry_run and not args.check_embeddings:
        print("dry-run: 모델과 DB를 호출하지 않았습니다.")
        return 0

    settings = get_settings()
    repo = PgServiceRepository(
        lambda: connect(settings), embed_model=settings.ollama_embed, embed_dim=settings.embed_dim
    )
    try:
        existing = {}
        if not args.check_embeddings:
            repo.init_schema()
            existing = repo.indexed_chunks()
        changed = [
            sid for sid, text in texts.items()
            if existing.get(sid) != (text, settings.ollama_embed)
        ]
        print(f"재임베딩 {len(changed)}건, 재사용 {len(records) - len(changed)}건", flush=True)
        ollama = OllamaClient(
            settings.ollama_base_url, settings.ollama_embed, settings.ollama_llm,
            settings.ollama_timeout, embed_dim=settings.embed_dim,
        )
        started = time.monotonic()
        indexed = {}
        for start in range(0, len(changed), args.batch_size):
            batch = changed[start:start + args.batch_size]
            embeddings = ollama.embed([texts[sid] for sid in batch])
            indexed.update({sid: (texts[sid], vector) for sid, vector in zip(batch, embeddings, strict=True)})
            print(f"임베딩 {len(indexed)}/{len(changed)}", flush=True)
        print(f"임베딩 완료: {time.monotonic() - started:.1f}초, 차원 {settings.embed_dim}", flush=True)
        if args.check_embeddings:
            print("임베딩 검증 완료: DB를 호출하지 않았습니다.")
            return 0
        result = repo.sync_snapshot(records, indexed, prune=args.prune)
    except (DatabaseNotConfigured, psycopg2.Error, OllamaError, ValueError) as exc:
        print(f"적재 실패 ({type(exc).__name__}): DB·모델 설정과 가동 상태를 확인해 주세요.", file=sys.stderr)
        return 1
    print(
        f"DB 반영 완료: 갱신 {result['upserted']}건, 임베딩 {result['embedded']}건, "
        f"삭제 {result['removed']}건, 현재 {result['total']}건"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
