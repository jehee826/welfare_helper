"""지정한 소수 서비스의 공식 상세정보를 명시적으로 보강한다."""

import argparse
import sys

import psycopg2

from BackEnd.core.db import DatabaseNotConfigured, connect
from BackEnd.core.settings import get_settings
from BackEnd.ingest.official import OfficialDataError, fetch_detail
from BackEnd.rag.chunking import ChunkingError, split_official
from BackEnd.rag.evidence import EvidenceConsistencyError
from BackEnd.rag.ollama import OllamaClient, OllamaError
from BackEnd.rag.repository import PgServiceRepository
from BackEnd.rag.reranker import LocalReranker, RerankerError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="공식 상세조회 API로 지정 서비스만 보강합니다. 기본은 쓰지 않습니다.")
    parser.add_argument("--service-id", action="append", required=True)
    parser.add_argument("--write", action="store_true", help="확인한 대상 DB의 상세 청크만 갱신합니다.")
    parser.add_argument("--replace-same-basis", action="store_true", help="같은 기준연도 원문 변경을 검토한 경우에만 교체합니다.")
    args = parser.parse_args(argv)
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
        if not args.write:
            print(f"공식 상세 {len(chunks)}개 섹션 확인. DB·모델은 변경하지 않았습니다.")
            return 0
        expected = {sid: snapshot.active_versions.get(sid, set()) for sid in ids}
        llm = OllamaClient(settings.ollama_base_url, settings.ollama_embed, settings.ollama_llm,
                           settings.ollama_timeout, embed_dim=settings.embed_dim)
        digest = llm.model_digest()
        tokenizer = LocalReranker(settings.rerank_model, settings.rerank_revision, settings.rerank_cache_dir)
        children = [child for sid in ids for child in split_official(
            [c for c in chunks if c.service_id == sid], services[sid].name, digest, tokenizer.count_tokens,
            settings.rerank_model + "@" + settings.rerank_revision)]
        existing = repo.detail_vectors(ids)
        reusable = {(c.embedding_text(), c.embed_digest): existing[(c.embedding_text(), c.embed_digest)]
                    for c in children if (c.embedding_text(), c.embed_digest) in existing}
        changed_texts = list(dict.fromkeys(c.embedding_text() for c in children
                                          if (c.embedding_text(), c.embed_digest) not in reusable))
        prepared = {}
        # 전체 서비스 버전을 준비하되 모델 요청의 입력 개수는 제한한다.
        for start in range(0, len(changed_texts), 16):
            batch = changed_texts[start:start + 16]
            prepared.update(zip(batch, llm.embed(batch), strict=True))
        if llm.model_digest() != digest:
            raise OllamaError("임베딩 도중 모델 digest가 바뀌었습니다.")
        vectors = {c.chunk_id: reusable[(c.embedding_text(), digest)] if (c.embedding_text(), digest) in reusable
                   else prepared[c.embedding_text()] for c in children}
        count = repo.activate_details(children, vectors, expected, replace_same_basis=args.replace_same_basis,
                                      expected_sources={sid: snapshot.service_stamps.get(sid, "") for sid in ids})
        print(f"공식 상세 자식 {count}개 활성화, 변경 입력 재임베딩 {len(changed_texts)}개. 이전 원문은 비활성 상태로 보존했습니다.")
        return 0
    except (OfficialDataError, DatabaseNotConfigured, psycopg2.Error, OllamaError, RerankerError, ValueError, OSError, ImportError) as exc:
        reason = (str(exc) if isinstance(exc, (OfficialDataError, DatabaseNotConfigured, OllamaError,
                                               RerankerError, EvidenceConsistencyError, ChunkingError))
                  else "설정·권한·대상 ID·캐시를 확인해 주세요.")
        print(f"공식 상세 보강 실패 ({type(exc).__name__}): {reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
