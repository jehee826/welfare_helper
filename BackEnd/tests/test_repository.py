"""새 스냅샷의 검색 경계와 폐기된 쓰기 경로를 확인한다. 통합 확인은 읽기 전용이다."""

import os
from contextlib import closing

import psycopg2
import pytest
from psycopg2.extensions import parse_dsn

from BackEnd.rag.evidence import EvidenceConsistencyError
from BackEnd.rag.repository import CatalogSnapshot, PgServiceRepository
from BackEnd.tests.test_chat import PENSION
from BackEnd.tests.test_rag_accuracy import children

VECTOR = [1.0] + [0.0] * 1023


def forbidden_connection():
    pytest.fail('이 경로는 DB에 접속하면 안 됩니다.')


@pytest.mark.parametrize('method,args,kwargs', [
    ('init_schema',(),{}), ('indexed_chunks',(),{}),
    ('sync_snapshot',([],{}),{'prune':True}), ('activate_details',([],{},{}),{}),
    ('upsert_details',([],{}),{}),
])
def test_legacy_schema_and_ingest_paths_cannot_modify_a_database(method,args,kwargs):
    with pytest.raises(ValueError,match='문서 API'):
        getattr(PgServiceRepository(forbidden_connection),method)(*args,**kwargs)


@pytest.mark.parametrize('vector', [[1.0,0.0], [float('nan')]*1024, [0.0]*1024])
def test_invalid_query_vector_is_rejected_before_database_access(vector):
    with pytest.raises(ValueError):
        PgServiceRepository(forbidden_connection).dense_search(vector,5)


def test_dense_search_uses_supplied_snapshot_and_allowed_ids():
    first, second = children()[:2]
    snapshot = CatalogSnapshot([PENSION],[first,second],'snapshot-1',
                               embeddings={first.chunk_id:VECTOR,second.chunk_id:[0.0,1.0]+[0.0]*1022})
    repository = PgServiceRepository(forbidden_connection)
    result = repository.dense_search(VECTOR,30,[second.chunk_id],snapshot=snapshot)
    assert [r.chunk_id for r in result] == [second.chunk_id]
    assert result[0].score == 0.0
    assert result[0].storage() == second.storage()


def test_missing_snapshot_vector_cannot_be_fetched_from_a_newer_database():
    child = children()[0]
    snapshot = CatalogSnapshot([PENSION],[child],'snapshot-1',embeddings={})
    with pytest.raises(EvidenceConsistencyError,match='같은 스냅샷'):
        PgServiceRepository(forbidden_connection).dense_search(VECTOR,5,snapshot=snapshot)


def test_multiple_embedding_digests_cannot_be_compared_together():
    first, second = children(digest='model-a')[0], children(digest='model-b')[0]
    snapshot = CatalogSnapshot([PENSION],[first,second],'snapshot-1',
                               embeddings={first.chunk_id:VECTOR,second.chunk_id:VECTOR})
    with pytest.raises(EvidenceConsistencyError,match='digest'):
        PgServiceRepository(forbidden_connection).dense_search(VECTOR,5,snapshot=snapshot)


def test_optional_local_database_has_only_new_schema_and_current_chunks():
    dsn = os.environ.get('RAG_TEST_DATABASE_URL','')
    if not dsn:
        pytest.skip('새 스키마를 별도로 준비한 로컬 rag_test DB에서만 읽기 확인합니다.')
    options = parse_dsn(dsn)
    if (options.get('host') not in ('127.0.0.1','localhost','::1') or options.get('dbname') != 'rag_test'
            or options.get('hostaddr') not in (None,'','127.0.0.1','::1') or options.get('service')):
        pytest.fail('대상은 로컬 rag_test여야 하며 원격 hostaddr/service 우회는 허용하지 않습니다.')

    def connection():
        conn = psycopg2.connect(**(options | {'connect_timeout':'5'}))
        conn.set_session(readonly=True)
        return conn

    with closing(connection()) as conn, conn, conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.welfare_programs'),to_regclass('public.rag_documents'),"
                    "to_regclass('public.welfare_document_vectors'),to_regclass('public.welfare_services'),"
                    "to_regclass('public.welfare_chunks'),to_regclass('public.rag_document_chunks')")
        tables = cur.fetchone()
        assert all(tables[:3]) and not any(tables[3:])
    snapshot = PgServiceRepository(connection).snapshot()
    assert not any(c.test_only for c in snapshot.chunks)
    assert not any(s.service_id.startswith('TEST_') for s in snapshot.services)
    assert set(snapshot.embeddings) == {c.chunk_id for c in snapshot.chunks}
