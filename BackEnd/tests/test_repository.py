"""새 스냅샷의 검색 경계와 폐기된 쓰기 경로를 확인한다. 통합 확인은 읽기 전용이다."""

import os
from contextlib import closing
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import psycopg2
import pytest
from psycopg2.extensions import parse_dsn

from BackEnd.rag.evidence import EvidenceConsistencyError
from BackEnd.rag.repository import CatalogSnapshot, PgServiceRepository
from BackEnd.tests.test_chat import PENSION
from BackEnd.tests.test_rag_accuracy import children


@pytest.fixture
def public_catalog(monkeypatch):
    from BackEnd.documents import retrieval
    from BackEnd.rag import repository as module
    from BackEnd.tests.test_document_qa import components
    chunk = components()[0].snapshot().chunks[0]
    state = SimpleNamespace(revision=[['program'], ['document'], ['vector']], chunks=[chunk], now=0)
    cursor = MagicMock()
    cursor.__enter__.return_value = cursor
    cursor.fetchone.side_effect = lambda: state.revision
    cursor.fetchall.return_value = [('PROGRAM_1', '공개 문서', '', '기관', '부서', '', [], None,
                                    datetime(2026, 11, 8, tzinfo=timezone.utc))]
    connection = MagicMock()
    connection.cursor.return_value = cursor
    def load(*_args, **_kwargs):
        return (state.chunks, {c.chunk_id: VECTOR.copy() for c in state.chunks}, {},
                [str(state.revision)], {})
    loader = Mock(side_effect=load)
    monkeypatch.setattr(retrieval, 'active_document_chunks', loader)
    monkeypatch.setattr(module, 'monotonic', lambda: state.now, raising=False)
    repo = PgServiceRepository(lambda: connection, documents_enabled=True)
    return SimpleNamespace(repo=repo, state=state, loader=loader, connection=connection, cursor=cursor)


def test_unchanged_public_snapshot_reuses_validated_vectors_but_reads_revision_each_time(public_catalog):
    api = public_catalog
    first = api.repo.snapshot()
    second = api.repo.snapshot()
    assert first is not second and second.chunks == api.state.chunks
    assert api.loader.call_count == 1
    assert api.cursor.fetchone.call_count == 2
    assert api.connection.set_session.call_count == 2
    api.connection.set_session.assert_called_with(isolation_level='REPEATABLE READ', readonly=True)


def test_request_mutation_does_not_change_other_requests_cached_public_snapshot(public_catalog):
    api = public_catalog
    first = api.repo.snapshot()
    identifier = first.chunks[0].chunk_id
    first.chunks.clear()
    first.services[0].contacts.append({'label':'요청 중 변경'})
    first.embeddings[identifier][0] = 0
    second = api.repo.snapshot()
    assert second.chunks and second.services[0].contacts == []
    assert second.embeddings[identifier][0] == 1
    second.chunks.clear()
    assert api.repo.snapshot().chunks and api.loader.call_count == 1


def test_three_concurrent_cached_reads_have_independent_mutable_results(public_catalog):
    api = public_catalog
    api.repo.snapshot()
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: api.repo.snapshot(), range(3)))
    results[0].chunks.clear()
    results[1].services[0].contacts.append({'label':'다른 요청'})
    assert results[1].chunks and results[2].chunks and results[2].services[0].contacts == []
    assert api.loader.call_count == 1 and api.cursor.fetchone.call_count == 4


def test_revision_and_source_validation_use_the_same_readonly_transaction(public_catalog):
    api = public_catalog
    api.repo._connect = Mock(return_value=api.connection)
    api.cursor.connection = api.connection
    original = api.loader.side_effect
    def same_transaction(cur, *args, **kwargs):
        assert cur.connection is api.connection
        api.connection.set_session.assert_called_with(isolation_level='REPEATABLE READ', readonly=True)
        return original(cur, *args, **kwargs)
    api.loader.side_effect = same_transaction
    api.repo.snapshot()
    api.repo._connect.assert_called_once()


@pytest.mark.parametrize('part', [0, 1, 2], ids=['program-or-department', 'document-or-job', 'vector'])
def test_changed_public_rows_never_return_previous_snapshot(public_catalog, part):
    api = public_catalog
    first = api.repo.snapshot()
    api.state.revision[part] = ['changed']
    api.state.chunks = []
    second = api.repo.snapshot()
    assert first.chunks and not second.chunks and first.stamp != second.stamp
    assert api.loader.call_count == 2


@pytest.mark.parametrize('options', [dict(document_scope='selected'), dict(include_local_documents=True),
                                   dict(documents_enabled=False)])
def test_scoped_private_or_legacy_reads_do_not_share_public_cache(public_catalog, options):
    api = public_catalog
    public = api.repo.snapshot()
    for key, value in options.items():
        setattr(api.repo, key, value)
    assert api.repo.snapshot() is not public
    assert api.repo.snapshot() is not public
    assert api.loader.call_count == 3


def test_expired_cache_or_model_change_requires_full_validation(public_catalog):
    api = public_catalog
    api.repo.snapshot()
    api.state.now = 121
    api.repo.snapshot()
    api.repo.embed_model = 'different-model'
    api.repo.snapshot()
    assert api.loader.call_count == 3


def test_changed_revision_load_failure_cannot_fall_back_to_cached_public_text(public_catalog):
    from BackEnd.documents.contracts import DocumentError
    api = public_catalog
    api.repo.snapshot()
    api.state.revision[1] = ['private-or-replaced']
    api.loader.side_effect = DocumentError('invalid_document_provenance')
    with pytest.raises(DocumentError):
        api.repo.snapshot()
    assert api.repo._document_snapshot is None


def test_revision_probe_failure_never_serves_cached_public_text(public_catalog):
    api = public_catalog
    api.repo.snapshot()
    api.cursor.fetchone.side_effect = RuntimeError('읽기 실패')
    with pytest.raises(RuntimeError):
        api.repo.snapshot()
    assert api.loader.call_count == 1


def test_large_catalog_is_validated_without_retaining_full_snapshot(public_catalog, monkeypatch):
    from BackEnd.rag import repository as module
    api = public_catalog
    monkeypatch.setattr(module, 'MAX_CACHED_CHUNKS', 0)
    assert api.repo.snapshot().chunks
    assert api.repo.snapshot().chunks
    assert api.loader.call_count == 2 and api.repo._document_snapshot is None

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
