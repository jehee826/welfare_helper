from contextlib import closing
from pathlib import Path
from typing import Callable

from psycopg2.extras import Json, execute_values

from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.embeddings import validate_embeddings
from BackEnd.rag.evidence import EvidenceChunk, read_chunk

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "db" / "schema.sql"


def vector_literal(values: list[float]) -> str:
    validate_embeddings([values], 1)
    return "[" + ",".join(str(v) for v in values) + "]"


class PgServiceRepository:
    """welfare_services / welfare_chunks 테이블을 다룬다. 호출마다 연결을 열고 닫아 서버리스에 연결을 남기지 않는다."""

    def __init__(self, connect: Callable, embed_model: str = "bge-m3", embed_dim: int = 1024):
        self._connect = connect
        self.embed_model = embed_model
        self.embed_dim = embed_dim

    def init_schema(self) -> None:
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(SCHEMA_PATH.read_text(encoding="utf-8"))

    def indexed_chunks(self) -> dict[str, tuple[str, str]]:
        """기존 overview의 내용과 모델만 읽어 재임베딩이 필요한 서비스를 찾는다."""
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(
                "SELECT service_id, content, embed_model FROM welfare_chunks "
                "WHERE chunk_id = service_id || ':overview'"
            )
            return {sid: (content, model) for sid, content, model in cur.fetchall()}

    def sync_snapshot(
        self,
        records: list[ServiceRecord],
        chunks: dict[str, tuple[str, list[float]]],
        *,
        prune: bool = False,
    ) -> dict:
        """서비스 메타데이터와 바뀐 임베딩을 한 트랜잭션에 반영한다. 기본 동작은 기존 데이터를 보존한다."""
        if not records:
            raise ValueError("빈 스냅샷은 반영할 수 없습니다.")
        ids = [r.service_id for r in records]
        if len(set(ids)) != len(ids) or not set(chunks).issubset(ids):
            raise ValueError("서비스 ID가 중복되거나 청크와 일치하지 않습니다.")
        validate_embeddings([vec for _, vec in chunks.values()], len(chunks), self.embed_dim)
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO welfare_services (service_id, name, summary, ministry, department, url, contacts, source_updated_at)
                VALUES %s
                ON CONFLICT (service_id) DO UPDATE SET
                    name = EXCLUDED.name, summary = EXCLUDED.summary, ministry = EXCLUDED.ministry,
                    department = EXCLUDED.department, url = EXCLUDED.url, contacts = EXCLUDED.contacts,
                    source_updated_at = EXCLUDED.source_updated_at, synced_at = now()
                """,
                [
                    (r.service_id, r.name, r.summary, r.ministry, r.department, r.url, Json(r.contacts), r.updated_at or None)
                    for r in records
                ],
            )
            if chunks:
                execute_values(
                    cur,
                    """
                    INSERT INTO welfare_chunks (chunk_id, service_id, content, embedding, embed_model)
                    VALUES %s
                    ON CONFLICT (chunk_id) DO UPDATE SET
                        content = EXCLUDED.content, embedding = EXCLUDED.embedding, embed_model = EXCLUDED.embed_model
                    """,
                    [
                        (f"{sid}:overview", sid, text, vector_literal(vec), self.embed_model)
                        for sid, (text, vec) in chunks.items()
                    ],
                    template="(%s, %s, %s, %s::vector, %s)",
                )
            removed = 0
            if prune:
                cur.execute("DELETE FROM welfare_services WHERE NOT (service_id = ANY(%s))", (ids,))
                removed = cur.rowcount
            cur.execute("SELECT count(*) FROM welfare_services")
            total = cur.fetchone()[0]
        return {"upserted": len(records), "embedded": len(chunks), "removed": removed, "total": total}

    def all_services(self) -> list[ServiceRecord]:
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(
                "SELECT service_id, name, summary, ministry, department, url, contacts, source_updated_at "
                "FROM welfare_services ORDER BY service_id"
            )
            return [
                ServiceRecord(
                    service_id=row[0], name=row[1], summary=row[2], ministry=row[3], department=row[4],
                    url=row[5], contacts=row[6] or [], updated_at=row[7].isoformat() if row[7] else "",
                )
                for row in cur.fetchall()
            ]

    def chunks_for_services(self, ids: list[str]) -> list[EvidenceChunk]:
        if not ids:
            return []
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(
                "SELECT c.chunk_id,c.service_id,c.content,s.url,s.source_updated_at "
                "FROM welfare_chunks c JOIN welfare_services s USING(service_id) "
                "WHERE c.service_id = ANY(%s) AND c.embed_model = %s ORDER BY c.chunk_id LIMIT 500",
                (ids[:50], self.embed_model),
            )
            return [read_chunk(row[0], row[1], row[2], row[3], row[4].isoformat() if row[4] else "")
                    for row in cur.fetchall()]

    def sync_details(self, chunks: list[EvidenceChunk], embeddings: dict[str, list[float]]) -> int:
        """명시적으로 수집한 상세 청크만 갱신한다. 기존 서비스·CSV·누락 청크는 삭제하지 않는다."""
        if not chunks or any(chunk.source_kind != "official_detail" for chunk in chunks):
            raise ValueError("공식 상세 청크가 필요합니다.")
        ids = {chunk.chunk_id for chunk in chunks}
        if len(ids) != len(chunks) or not set(embeddings).issubset(ids):
            raise ValueError("청크와 임베딩 ID가 일치하지 않습니다.")
        if any(chunk.chunk_id != f"{chunk.service_id}:official:{chunk.section}" for chunk in chunks):
            raise ValueError("공식 상세 청크 ID와 서비스가 일치하지 않습니다.")
        validate_embeddings(list(embeddings.values()), len(embeddings), self.embed_dim)
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            changed = [chunk for chunk in chunks if chunk.chunk_id in embeddings]
            if changed:
                execute_values(cur,
                    "INSERT INTO welfare_chunks(chunk_id,service_id,content,embedding,embed_model) VALUES %s "
                    "ON CONFLICT(chunk_id) DO UPDATE SET content=EXCLUDED.content, "
                    "embedding=EXCLUDED.embedding,embed_model=EXCLUDED.embed_model",
                    [(chunk.chunk_id, chunk.service_id, chunk.storage(), vector_literal(embeddings[chunk.chunk_id]),
                      self.embed_model) for chunk in changed], template="(%s,%s,%s,%s::vector,%s)")
            for chunk in chunks:
                if chunk.chunk_id not in embeddings:
                    cur.execute("UPDATE welfare_chunks SET content=%s WHERE chunk_id=%s AND embed_model=%s",
                                (chunk.storage(), chunk.chunk_id, self.embed_model))
                    if cur.rowcount != 1:
                        raise ValueError("새로운 상세 청크에는 임베딩이 필요합니다.")
        return len(chunks)

    def dense_search(self, embedding: list[float], k: int) -> list[EvidenceChunk]:
        validate_embeddings([embedding], 1, self.embed_dim)
        if k < 1:
            raise ValueError("검색 개수는 1 이상이어야 합니다.")
        literal = vector_literal(embedding)
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(
                "SELECT c.chunk_id,c.service_id,c.content,s.url,s.source_updated_at, "
                "1 - (c.embedding <=> %s::vector) AS similarity "
                "FROM welfare_chunks c JOIN welfare_services s USING(service_id) WHERE c.embed_model=%s "
                "ORDER BY c.embedding <=> %s::vector,c.chunk_id LIMIT %s",
                (literal, self.embed_model, literal, k),
            )
            return [read_chunk(row[0], row[1], row[2], row[3], row[4].isoformat() if row[4] else "", float(row[5]))
                    for row in cur.fetchall()]
