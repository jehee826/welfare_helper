from contextlib import contextmanager

import pytest

from BackEnd.documents.contracts import stable_hash
from BackEnd.documents.store import DocumentStore
from BackEnd.rag.repository import PgServiceRepository


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.statements = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, sql, params=None):
        if self.connection.readonly:
            raise RuntimeError('read-only transaction')
        self.statements.append(sql)
        if self.connection.fail and sql.startswith('INSERT INTO public.rag_documents'):
            raise ValueError('test failure')

    def fetchall(self):
        return [{'program_id': 1, 'test_only': True}]

    def fetchone(self):
        return {'document_id': 'doc'}


class Connection:
    def __init__(self, fail=False):
        self.readonly = True
        self.fail = fail
        self.committed = False
        self.rolled_back = False
        self.closed = False
        self.settings = None
        self.cur = Cursor(self)

    def set_session(self, **kwargs):
        self.settings = kwargs
        self.readonly = kwargs['readonly']

    def cursor(self, **_):
        return self.cur

    def __enter__(self):
        return self

    def __exit__(self, kind, *_):
        self.rolled_back = kind is not None
        self.committed = kind is None

    def close(self):
        self.closed = True


@pytest.mark.parametrize('fail', [False, True])
def test_registration_uses_readwrite_transaction_and_closes(monkeypatch, fail):
    conn = Connection(fail)
    store = DocumentStore(lambda: conn)
    monkeypatch.setattr(store, 'automatic_ready', lambda: True)
    monkeypatch.setattr(store, '_document', lambda *a, **kw: {'document_id': 'doc', 'program_id': 1, 'local_ingestion': True})
    monkeypatch.setattr(store, '_pending', lambda *a: None)
    monkeypatch.setattr(store, '_new_job', lambda *a: {'job_id': 'job'})
    metadata = {'service_id': 'TEST_MOCK', 'name': '원문', 'source_url': 'https://example.invalid', 'source_organization': '기관', 'test_only': True}
    def register():
        return store.register(metadata, stable_hash(b'content'), 7, 'md', None, {}, b'content', shared_password=True)
    if fail:
        with pytest.raises(ValueError):
            register()
    else:
        assert register()[1]['job_id'] == 'job'
    assert conn.settings == {'readonly': False}
    assert any(sql.startswith('INSERT INTO public.rag_documents') for sql in conn.cur.statements)
    assert conn.rolled_back is fail
    assert conn.committed is not fail
    assert conn.closed


def test_search_snapshot_keeps_readonly_repeatable_read(monkeypatch):
    conn = Connection()
    conn.cur.execute = lambda *a, **kw: None
    conn.cur.fetchall = lambda: []
    monkeypatch.setattr('BackEnd.documents.retrieval.active_document_chunks', lambda *a, **kw: ([], {}, {}, []))
    PgServiceRepository(lambda: conn).snapshot()
    assert conn.settings == {'isolation_level': 'REPEATABLE READ', 'readonly': True}
    assert conn.closed
