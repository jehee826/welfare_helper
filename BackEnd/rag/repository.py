from contextlib import closing
from pathlib import Path
from typing import Callable

from psycopg2.extras import Json, execute_values

from BackEnd.ingest.csv_loader import ServiceRecord

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "db" / "schema.sql"


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{v:.7g}" for v in values) + "]"


class PgServiceRepository:
    """welfare_services / welfare_chunks 테이블을 다룬다. 호출마다 연결을 열고 닫아 서버리스에 연결을 남기지 않는다."""

    def __init__(self, connect: Callable):
        self._connect = connect

    def init_schema(self) -> None:
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(SCHEMA_PATH.read_text(encoding="utf-8"))

    def replace_all(self, records: list[ServiceRecord], chunks: list[str], embeddings: list[list[float]], embed_model: str) -> dict:
        """CSV 스냅샷 전체로 테이블을 맞춘다. 스냅샷에 없는 서비스는 삭제한다. 한 트랜잭션으로 처리한다."""
        ids = [r.service_id for r in records]
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
            execute_values(
                cur,
                """
                INSERT INTO welfare_chunks (chunk_id, service_id, content, embedding, embed_model)
                VALUES %s
                ON CONFLICT (chunk_id) DO UPDATE SET
                    content = EXCLUDED.content, embedding = EXCLUDED.embedding, embed_model = EXCLUDED.embed_model
                """,
                [
                    (f"{r.service_id}:overview", r.service_id, text, vector_literal(vec), embed_model)
                    for r, text, vec in zip(records, chunks, embeddings)
                ],
                template="(%s, %s, %s, %s::vector, %s)",
            )
            cur.execute("DELETE FROM welfare_services WHERE NOT (service_id = ANY(%s))", (ids,))
            removed = cur.rowcount
            cur.execute("SELECT count(*) FROM welfare_services")
            total = cur.fetchone()[0]
        return {"upserted": len(records), "removed": removed, "total": total}

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

    def dense_search(self, embedding: list[float], k: int) -> list[tuple[str, float]]:
        literal = vector_literal(embedding)
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(
                "SELECT service_id, 1 - (embedding <=> %s::vector) AS similarity "
                "FROM welfare_chunks ORDER BY embedding <=> %s::vector LIMIT %s",
                (literal, literal, k),
            )
            return [(row[0], float(row[1])) for row in cur.fetchall()]
