from contextlib import closing
from dataclasses import asdict, dataclass, field, replace
import json
from pathlib import Path
from typing import Callable

from psycopg2.extras import Json, execute_values

from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.embeddings import validate_embeddings
from BackEnd.rag.evidence import (EvidenceChunk, EvidenceConsistencyError, active_chunks,
                                  fingerprint, read_chunk, validate_version)

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "db" / "schema.sql"
MAX_CATALOG_ROWS = 50000


@dataclass(frozen=True)
class CatalogSnapshot:
    services: list[ServiceRecord]
    chunks: list[EvidenceChunk]
    stamp: str
    active_versions: dict[str, set[str]] = field(default_factory=dict)
    unavailable_services: dict[str, str] = field(default_factory=dict)
    service_stamps: dict[str, str] = field(default_factory=dict)


def vector_literal(values: list[float]) -> str:
    validate_embeddings([values], 1)
    return "[" + ",".join(str(v) for v in values) + "]"


class PgServiceRepository:
    """welfare_services / welfare_chunks 테이블을 다룬다. 호출마다 연결을 열고 닫아 서버리스에 연결을 남기지 않는다."""

    def __init__(self, connect: Callable, embed_model: str = "bge-m3", embed_dim: int = 1024,
                 *, documents_enabled: bool = False, document_scope: str | None = None):
        self._connect = connect
        self.embed_model = embed_model
        self.embed_dim = embed_dim
        self.documents_enabled = documents_enabled
        self.document_scope = document_scope

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

    def snapshot(self) -> CatalogSnapshot:
        """같은 MVCC 시점의 메타데이터를 읽고 활성 자식만 검색에 제공한다."""
        with closing(self._connect()) as conn:
            conn.set_session(isolation_level="REPEATABLE READ", readonly=True)
            with conn, conn.cursor() as cur:
                cur.execute("SELECT service_id,name,summary,ministry,department,url,contacts,source_updated_at "
                            "FROM welfare_services ORDER BY service_id LIMIT %s", (MAX_CATALOG_ROWS + 1,))
                rows = cur.fetchall()
                if len(rows) > MAX_CATALOG_ROWS:
                    raise EvidenceConsistencyError("서비스 상한을 넘어 불완전한 검색을 중단합니다.")
                services = [ServiceRecord(r[0], r[1], r[2], r[3], r[4], r[5], r[6] or [],
                                          r[7].isoformat() if r[7] else "") for r in rows]
                cur.execute("SELECT c.chunk_id,c.service_id,c.content,s.url,s.source_updated_at,c.embed_model "
                            "FROM welfare_chunks c JOIN welfare_services s USING(service_id) "
                            "ORDER BY c.chunk_id LIMIT %s", (MAX_CATALOG_ROWS + 1,))
                rows = cur.fetchall()
                documents, document_links = [], {}
                if self.documents_enabled:
                    from BackEnd.documents.retrieval import active_document_chunks

                    documents, document_links = active_document_chunks(cur, self.embed_model, self.document_scope)
        if len(rows) > MAX_CATALOG_ROWS:
            raise EvidenceConsistencyError("원문 상한을 넘어 불완전한 검색을 중단합니다.")
        if self.document_scope:
            wanted = {c.service_id for c in documents}
            services = [r for r in services if r.service_id in wanted]
            rows = []
        else:
            services = [r for r in services if not r.service_id.startswith("TEST_")]
            wanted = {r.service_id for r in services}
            rows = [r for r in rows if r[1] in wanted]
            documents = [c for c in documents if c.service_id in wanted and not c.test_only]
        grouped, raw_by_service = {}, {r.service_id: [] for r in services}
        for row in rows:
            grouped.setdefault(row[1], []).append(read_chunk(row[0], row[1], row[2], row[3], row[4].isoformat() if row[4] else ""))
            raw_by_service[row[1]].append(row[0] + row[2] + row[5])
        chunks, unavailable = [], {}
        for sid, group in grouped.items():
            try:
                chunks.extend(active_chunks(group))
            except EvidenceConsistencyError:
                unavailable[sid] = "invalid_or_conflicting_version"
        for sid in {c.service_id for c in documents}:
            detail = [c for c in chunks if c.service_id == sid and c.official]
            from BackEnd.documents.contracts import stable_hash

            policy = {"hash": stable_hash([c.storage() for c in detail]) if detail else "",
                      "years": sorted({c.basis_year for c in detail})}
            if not self.document_scope and (sid in unavailable or document_links[sid] != policy):
                unavailable[sid] = "document_api_source_conflict"
                chunks = [c for c in chunks if c.service_id != sid]
                continue
            chunks = [c for c in chunks if c.service_id != sid or c.source_kind == "csv_summary"]
            chunks.extend(c for c in documents if c.service_id == sid)
        models = {r[0]: r[5] for r in rows}
        # 다른 임베딩 모델의 활성본이 있더라도 이전 v1 상세로 되돌리지 않는다.
        searchable = [c for c in chunks if c.document_id or models[c.chunk_id] == self.embed_model]
        stamp = fingerprint(json.dumps([asdict(r) for r in services],
                                       ensure_ascii=False, sort_keys=True)
                            + "\n".join(str(r[0]) + r[2] + r[5] for r in rows)
                            + "\n".join(c.storage() for c in documents))
        versions = {}
        for chunk in chunks:
            if chunk.version:
                versions.setdefault(chunk.service_id, set()).add(chunk.version)
        service_stamps = {r.service_id: fingerprint(json.dumps(asdict(r), ensure_ascii=False, sort_keys=True)
                                                   + "\n".join(raw_by_service[r.service_id])) for r in services}
        return CatalogSnapshot(services, searchable, stamp, versions, unavailable, service_stamps)

    def chunks_for_services(self, ids: list[str]) -> list[EvidenceChunk]:
        if not ids:
            return []
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(
                "SELECT c.chunk_id,c.service_id,c.content,s.url,s.source_updated_at "
                "FROM welfare_chunks c JOIN welfare_services s USING(service_id) "
                "WHERE c.service_id = ANY(%s) AND c.embed_model = %s ORDER BY c.chunk_id LIMIT %s",
                (ids, self.embed_model, MAX_CATALOG_ROWS + 1),
            )
            rows = cur.fetchall()
            if len(rows) > MAX_CATALOG_ROWS:
                raise EvidenceConsistencyError("서비스 원문 상한을 초과했습니다.")
            return [read_chunk(row[0], row[1], row[2], row[3], row[4].isoformat() if row[4] else "") for row in rows]

    def detail_vectors(self, ids: list[str]) -> dict[tuple[str, str], list[float]]:
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute("SELECT chunk_id,service_id,content,embedding::text FROM welfare_chunks "
                        "WHERE service_id=ANY(%s) AND embed_model=%s LIMIT %s",
                        (ids, self.embed_model, MAX_CATALOG_ROWS + 1))
            rows = cur.fetchall()
        if len(rows) > MAX_CATALOG_ROWS:
            raise EvidenceConsistencyError("기존 임베딩 상한을 초과했습니다.")
        result = {}
        for cid, sid, content, vector in rows:
            chunk = read_chunk(cid, sid, content, "")
            if chunk.version:
                result[(chunk.embedding_text(), chunk.embed_digest)] = json.loads(vector)
        return result

    def activate_details(self, chunks: list[EvidenceChunk], vectors: dict[str, list[float]],
                         expected: dict[str, set[str]], *, replace_same_basis: bool = False,
                         expected_sources: dict[str, str] | None = None) -> int:
        groups = {sid: [c for c in chunks if c.service_id == sid] for sid in {c.service_id for c in chunks}}
        if not groups or set(vectors) != {c.chunk_id for c in chunks} or set(expected) != set(groups):
            raise ValueError("전체 새 버전·임베딩·기존 버전 정보가 필요합니다.")
        if expected_sources is not None and set(expected_sources) != set(groups):
            raise ValueError("수집 전 서비스 원문 스냅샷이 필요합니다.")
        for group in groups.values():
            validate_version(group)
        validate_embeddings(list(vectors.values()), len(vectors), self.embed_dim)
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            for sid, group in sorted(groups.items()):
                cur.execute("SELECT service_id,name,summary,ministry,department,url,contacts,source_updated_at "
                            "FROM welfare_services WHERE service_id=%s FOR UPDATE", (sid,))
                row = cur.fetchone()
                if not row:
                    raise EvidenceConsistencyError("서비스가 삭제되었습니다.")
                record = ServiceRecord(row[0], row[1], row[2], row[3], row[4], row[5], row[6] or [],
                                       row[7].isoformat() if row[7] else "")
                if any(c.service_name != record.name or c.source_url != record.url for c in group):
                    raise EvidenceConsistencyError("서비스 이름·출처가 수집 대상과 다릅니다.")
                cur.execute("SELECT chunk_id,content,embed_model FROM welfare_chunks WHERE service_id=%s ORDER BY chunk_id FOR UPDATE", (sid,))
                previous_rows = cur.fetchall()
                source_stamp = fingerprint(json.dumps(asdict(record), ensure_ascii=False, sort_keys=True)
                                           + "\n".join(cid + content + model for cid, content, model in previous_rows))
                if expected_sources is not None and source_stamp != expected_sources[sid]:
                    raise EvidenceConsistencyError("수집 중 원문이 변경되었습니다. 검토 후 다시 수집해 주세요.")
                previous = [read_chunk(cid, sid, content, "") for cid, content, _ in previous_rows]
                current = [c for c in previous if c.version and c.active]
                if {c.version for c in current} != expected[sid]:
                    raise EvidenceConsistencyError("수집 중 활성 버전이 바뀌었습니다. 다시 검토해 주세요.")
                dated = [c for c in previous if c.official and (not c.version or c.active)]
                if any(c.basis_year > group[0].basis_year for c in dated):
                    raise EvidenceConsistencyError("이전 연도의 자료로 활성본을 교체하지 않습니다.")
                if any(c.version != group[0].version and c.basis_year == group[0].basis_year
                       and c.source_hash != group[0].source_hash for c in current) and not replace_same_basis:
                    raise EvidenceConsistencyError("같은 기준연도 원문 변경은 충돌 검토 후 명시적으로 허용해야 합니다.")
                new_parents = {c.section: c.parent_text for c in group if c.parent_text}
                if any(not c.version and c.basis_year == group[0].basis_year and c.section in new_parents
                       and c.text != new_parents[c.section] for c in dated) and not replace_same_basis:
                    raise EvidenceConsistencyError("기존 v1 원문과 같은 연도 자료가 달라 충돌 검토가 필요합니다.")
                for old in current:
                    if old.version != group[0].version:
                        cur.execute("UPDATE welfare_chunks SET content=%s WHERE chunk_id=%s",
                                    (replace(old, active=False).storage(), old.chunk_id))
            execute_values(cur,
                "INSERT INTO welfare_chunks(chunk_id,service_id,content,embedding,embed_model) VALUES %s "
                "ON CONFLICT(chunk_id) DO UPDATE SET content=EXCLUDED.content,embedding=EXCLUDED.embedding,embed_model=EXCLUDED.embed_model",
                [(c.chunk_id, c.service_id, c.storage(), vector_literal(vectors[c.chunk_id]), self.embed_model) for c in chunks],
                template="(%s,%s,%s,%s::vector,%s)")
            for sid, group in groups.items():
                cur.execute("SELECT chunk_id,content FROM welfare_chunks WHERE service_id=%s", (sid,))
                restored = active_chunks([read_chunk(cid, sid, content, "") for cid, content in cur.fetchall()])
                if {c.chunk_id for c in restored if c.version} != {c.chunk_id for c in group}:
                    raise EvidenceConsistencyError("반영 후 활성 자식 집합이 달라 트랜잭션을 취소합니다.")
        return len(chunks)

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

    def dense_search(self, embedding: list[float], k: int, allowed_ids: list[str] | None = None) -> list[EvidenceChunk]:
        validate_embeddings([embedding], 1, self.embed_dim)
        if k < 1:
            raise ValueError("검색 개수는 1 이상이어야 합니다.")
        literal = vector_literal(embedding)
        if allowed_ids is None:
            allowed_ids = [c.chunk_id for c in self.snapshot().chunks]
        if allowed_ids == []:
            return []
        params = (literal, self.embed_model, allowed_ids, literal, k)
        if self.documents_enabled:
            condition = "d.id=%s" if self.document_scope else "d.active AND NOT d.test_only"
            parameters = (self.embed_model, allowed_ids, self.embed_model, allowed_ids)
            if self.document_scope:
                parameters += (self.document_scope,)
            parameters += (literal, literal, k)
            with closing(self._connect()) as conn, conn, conn.cursor() as cur:
                cur.execute("WITH corpus AS (SELECT c.chunk_id,c.service_id,c.content,c.embedding,s.url,s.source_updated_at "
                            "FROM welfare_chunks c JOIN welfare_services s USING(service_id) "
                            "WHERE c.embed_model=%s AND c.chunk_id=ANY(%s) UNION ALL "
                            "SELECT c.chunk_id,c.service_id,c.content,c.embedding,d.source_url,d.source_updated_at "
                            "FROM rag_document_chunks c JOIN rag_documents d ON d.id=c.document_id "
                            "JOIN rag_document_jobs j ON j.id=d.active_job_id AND j.id=c.job_id "
                            "WHERE c.embed_model=%s AND c.chunk_id=ANY(%s) AND j.state='succeeded' "
                            "AND c.index_key=j.result->>'index_key' AND " + condition + ") "
                            "SELECT chunk_id,service_id,content,url,source_updated_at,1-(embedding<=>%s::vector) "
                            "FROM corpus ORDER BY embedding<=>%s::vector,chunk_id LIMIT %s", parameters)
                return [read_chunk(r[0], r[1], r[2], r[3], r[4].isoformat() if r[4] else "", float(r[5])) for r in cur.fetchall()]
        with closing(self._connect()) as conn, conn, conn.cursor() as cur:
            cur.execute(
                "SELECT c.chunk_id,c.service_id,c.content,s.url,s.source_updated_at, "
                "1 - (c.embedding <=> %s::vector) AS similarity "
                "FROM welfare_chunks c JOIN welfare_services s USING(service_id) WHERE c.embed_model=%s "
                "AND c.chunk_id=ANY(%s) ORDER BY c.embedding <=> %s::vector,c.chunk_id LIMIT %s",
                params,
            )
            return [read_chunk(row[0], row[1], row[2], row[3], row[4].isoformat() if row[4] else "", float(row[5]))
                    for row in cur.fetchall()]
