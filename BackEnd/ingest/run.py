"""복지로 CSV를 정제·임베딩해 DB(pgvector)에 적재하는 백그라운드 CLI.

사용법 (저장소 루트에서):
    python -m BackEnd.ingest.run                # 기본 CSV 적재
    python -m BackEnd.ingest.run --csv 경로.csv
    python -m BackEnd.ingest.run --dry-run      # DB에 쓰지 않고 검증·임베딩 차원만 확인
"""

import argparse
import sys
import time

from BackEnd.core.db import connect
from BackEnd.core.settings import get_settings
from BackEnd.ingest.csv_loader import DEFAULT_CSV, chunk_text, load_csv
from BackEnd.rag.ollama import OllamaClient
from BackEnd.rag.repository import PgServiceRepository

BATCH_SIZE = 32


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="복지서비스 CSV를 벡터 DB에 적재합니다.")
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    settings = get_settings()
    records = load_csv(args.csv)
    chunks = [chunk_text(r) for r in records]
    print(f"CSV 검증 완료: {len(records)}건")

    ollama = OllamaClient(settings.ollama_base_url, settings.ollama_embed, settings.ollama_llm, settings.ollama_timeout)
    started = time.monotonic()
    embeddings: list[list[float]] = []
    for start in range(0, len(chunks), BATCH_SIZE):
        embeddings += ollama.embed(chunks[start:start + BATCH_SIZE])
        print(f"임베딩 {len(embeddings)}/{len(chunks)}", flush=True)
    dims = {len(e) for e in embeddings}
    if dims != {settings.embed_dim}:
        print(f"임베딩 차원 불일치: {dims} (기대값 {settings.embed_dim})", file=sys.stderr)
        return 1
    print(f"임베딩 완료: {time.monotonic() - started:.1f}초, 차원 {settings.embed_dim}")

    if args.dry_run:
        print("dry-run: DB에 쓰지 않았습니다.")
        return 0

    repo = PgServiceRepository(lambda: connect(settings))
    repo.init_schema()
    result = repo.replace_all(records, chunks, embeddings, settings.ollama_embed)
    print(f"DB 반영 완료: 갱신 {result['upserted']}건, 삭제 {result['removed']}건, 현재 {result['total']}건")
    return 0


if __name__ == "__main__":
    sys.exit(main())
