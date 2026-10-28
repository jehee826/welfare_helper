"""제도 메타데이터와 현재 문서 벡터를 하나의 읽기 스냅샷으로 제공한다."""

from contextlib import closing
from dataclasses import asdict, dataclass, field, replace
import json
import math
from typing import Callable, Sequence

from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.embeddings import validate_embeddings
from BackEnd.rag.evidence import EvidenceChunk, EvidenceConsistencyError, fingerprint

MAX_CATALOG_ROWS = 50000


@dataclass(frozen=True)
class CatalogSnapshot:
    services: list[ServiceRecord]
    chunks: list[EvidenceChunk]
    stamp: str
    active_versions: dict[str, set[str]] = field(default_factory=dict)
    unavailable_services: dict[str, str] = field(default_factory=dict)
    service_stamps: dict[str, str] = field(default_factory=dict)
    embeddings: dict[str, Sequence[float]] | None = None


def vector_literal(values: list[float]) -> str:
    validate_embeddings([values], 1)
    return '[' + ','.join(str(v) for v in values) + ']'


class PgServiceRepository:
    def __init__(self, connect: Callable, embed_model: str = 'bge-m3', embed_dim: int = 1024,
                 *, documents_enabled: bool = False, document_scope: str | None = None,
                 include_local_documents: bool = False):
        self._connect = connect
        self.embed_model = embed_model
        self.embed_dim = embed_dim
        self.documents_enabled = documents_enabled
        self.document_scope = document_scope
        self.include_local_documents = include_local_documents

    @staticmethod
    def _unsupported_ingestion():
        raise ValueError('이전 CSV·직접 상세 벡터 적재와 자동 DDL은 지원하지 않습니다. 문서 API에서 분석·검토·게시하세요.')

    def init_schema(self):
        self._unsupported_ingestion()

    def indexed_chunks(self):
        self._unsupported_ingestion()

    def sync_snapshot(self, records, chunks, *, prune=False):
        self._unsupported_ingestion()

    def activate_details(self, chunks, vectors, expected, **options):
        self._unsupported_ingestion()

    def upsert_details(self, chunks, embeddings):
        self._unsupported_ingestion()

    def all_services(self) -> list[ServiceRecord]:
        return self.snapshot().services

    def snapshot(self) -> CatalogSnapshot:
        with closing(self._connect()) as conn:
            conn.set_session(isolation_level='REPEATABLE READ', readonly=True)
            with conn, conn.cursor() as cur:
                condition = 'EXISTS(SELECT 1 FROM public.rag_documents d WHERE d.program_id=p.program_id AND d.document_id=%s)' \
                    if self.document_scope else 'TRUE' if self.include_local_documents else "NOT p.test_only AND left(coalesce(p.external_service_id,''),5)<>'TEST_'"
                params = (self.document_scope,MAX_CATALOG_ROWS+1) if self.document_scope else (MAX_CATALOG_ROWS+1,)
                cur.execute("SELECT coalesce(p.external_service_id,'PROGRAM_'||p.program_id::text),p.program_name,"
                            "coalesce(p.summary,''),d.ministry_name,d.department_name,coalesce(p.source_url,''),"
                            'p.contacts,p.source_updated_at,p.updated_at '
                            'FROM public.welfare_programs p JOIN public.departments d USING(department_id) '
                            'WHERE ' + condition + ' ORDER BY p.program_id LIMIT %s',params)
                rows=cur.fetchall()
                if len(rows)>MAX_CATALOG_ROWS:
                    raise EvidenceConsistencyError('서비스 상한을 넘어 불완전한 검색을 중단합니다.')
                services=[ServiceRecord(r[0],r[1],r[2],r[3],r[4],r[5],r[6] or [],r[7].isoformat() if r[7] else '') for r in rows]
                if len({r.service_id for r in services}) != len(services):
                    raise EvidenceConsistencyError('외부 서비스 ID와 내부 대체 ID가 충돌합니다.')
                # 문서 API 접수 여부와 검색 자료의 사용 여부는 별개다. 벡터 저장소는 항상 하나다.
                from BackEnd.documents.retrieval import active_document_chunks

                chunks, vectors, unavailable, identities = active_document_chunks(
                    cur, self.embed_model, self.document_scope, include_local_documents=self.include_local_documents)
        versions={}
        for child in chunks:
            versions.setdefault(child.service_id,set()).add(child.version)
        service_stamps={r.service_id:fingerprint(json.dumps(asdict(r),ensure_ascii=False,sort_keys=True)) for r in services}
        # 현재 문서·작업 ID가 청크 버전에 포함된다. 교체·삭제는 BM25와 요청 간 캐시를 무효화한다.
        stamp=fingerprint(json.dumps([asdict(r) for r in services],ensure_ascii=False,sort_keys=True)
                          + '\n'.join(str(r[8]) for r in rows)
                          + '\n'.join(c.storage() for c in chunks)
                          + json.dumps(unavailable,sort_keys=True)
                          + json.dumps(identities))
        return CatalogSnapshot(services,chunks,stamp,versions,unavailable,service_stamps,vectors)

    def chunks_for_services(self, ids):
        return [c for c in self.snapshot().chunks if c.service_id in ids]

    def detail_vectors(self, ids):
        snapshot=self.snapshot()
        return {(c.embedding_text(),c.embed_digest):snapshot.embeddings[c.chunk_id]
                for c in snapshot.chunks if c.service_id in ids}

    def dense_search(self, embedding, k, allowed_ids=None, *, snapshot=None):
        validate_embeddings([embedding],1,self.embed_dim)
        if k<1:
            raise ValueError('검색 개수는 1 이상이어야 합니다.')
        snapshot=snapshot or self.snapshot()
        allowed=set(allowed_ids) if allowed_ids is not None else {c.chunk_id for c in snapshot.chunks}
        chosen=[c for c in snapshot.chunks if c.chunk_id in allowed]
        # 모델 digest는 호출자가 허용 ID를 정할 때 고정한다. 다른 digest를 한 번에 비교하지 않는다.
        if len({c.embed_digest for c in chosen})>1:
            raise EvidenceConsistencyError('단일 embedding digest 범위가 필요합니다.')
        norm=math.sqrt(math.fsum(float(v)*float(v) for v in embedding))
        if not norm:
            return []
        ranked=[]
        for child in chosen:
            vector=(snapshot.embeddings or {}).get(child.chunk_id)
            if vector is None:
                raise EvidenceConsistencyError('같은 스냅샷의 벡터가 없습니다.')
            other_norm=math.sqrt(math.fsum(float(v)*float(v) for v in vector))
            if not other_norm:
                raise EvidenceConsistencyError('0 벡터는 비교하지 않습니다.')
            score=math.fsum(float(a)*float(b) for a,b in zip(embedding,vector,strict=True))/(norm*other_norm)
            ranked.append(replace(child,score=max(-1.0,min(1.0,score))))
        return sorted(ranked,key=lambda c:(-c.score,c.chunk_id))[:k]
