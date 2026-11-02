import pytest

from BackEnd.documents.contracts import DocumentError, stable_hash
from BackEnd.documents.store import DocumentStore
from BackEnd.tests.test_document_automatic_store import Cursor, IsolatedStore


def test_register_replacement_keeps_active_document_and_scope_before_publish():
    class RecordingCursor(Cursor):
        def fetchall(self):
            return [{'program_id':1, 'test_only':False}]
    class Store(IsolatedStore):
        def automatic_ready(self): return True
        def _document(self, *args, **kwargs):
            return {'document_id':'doc','program_id':1,'active_job_id':'published-a','test_only':True,'local_ingestion':True}
        def _pending(self, *args): return None
    cursor=RecordingCursor([{'job_id':'candidate-b','state':'queued'}])
    metadata={'service_id':'WLF1','name':'후보','test_only':False}
    doc, job=Store(cursor).register(metadata,stable_hash(b'new'),3,'md',None,{},b'new',document_id='doc')
    assert doc['active_job_id']=='published-a' and doc['test_only'] is True and job['job_id']=='candidate-b'
    assert "state IN ('failed','cancelled')" in cursor.calls[1][0]
    assert cursor.calls[1][1] == ('doc',)
    assert 'expected_active_job_id,candidate_metadata' in cursor.calls[2][0]
    assert cursor.calls[2][1][1] == 'published-a'
    assert cursor.calls[2][1][2].adapted['test_only'] is False
    assert all('UPDATE public.rag_documents' not in sql and 'DELETE FROM public.welfare_document_vectors' not in sql for sql,_ in cursor.calls)


def test_cancel_discards_only_candidate_job_and_its_vectors():
    class Store(IsolatedStore):
        def _pending(self, *args):
            return {'job_id': 'candidate-b', 'local_ingestion': True}
    cursor = Cursor()
    assert Store(cursor).cancel('document', None) == 'candidate-b'
    assert len(cursor.calls) == 2
    assert 'UPDATE public.rag_document_jobs' in cursor.calls[0][0]
    assert cursor.calls[0][1][-1] == 'candidate-b'
    assert 'DELETE FROM public.welfare_document_vectors WHERE job_id=%s' in cursor.calls[1][0]
    assert cursor.calls[1][1] == ('candidate-b',)
    assert all('UPDATE public.rag_documents' not in sql for sql, _ in cursor.calls)


def test_failure_discards_only_candidate_job_and_its_vectors():
    cursor=Cursor()
    store=IsolatedStore(cursor, {'job_id':'candidate-b'})
    store.fail('candidate-b','lease','synthetic_failure')
    assert len(cursor.calls)==2
    assert 'UPDATE public.rag_document_jobs' in cursor.calls[0][0]
    assert cursor.calls[0][1]==('failed','synthetic_failure','candidate-b')
    assert 'DELETE FROM public.welfare_document_vectors WHERE job_id=%s' in cursor.calls[1][0]
    assert cursor.calls[1][1]==('candidate-b',)
    assert all('UPDATE public.rag_documents' not in sql for sql,_ in cursor.calls)


def test_lost_lease_stops_before_publish():
    class Store(IsolatedStore):
        _lease = staticmethod(DocumentStore._lease)
    cursor = Cursor([{'document_id':'doc'}, None])
    with pytest.raises(DocumentError, match='job_lease_lost'):
        Store(cursor).activate('candidate-b', 'expired-token')
    assert len(cursor.calls) == 3
    assert all('welfare_publish_document' not in sql for sql, _ in cursor.calls)


def test_changed_active_job_stops_before_publish():
    class Store(IsolatedStore):
        def _document(self, *args, **kwargs):
            return {'document_id':'doc', 'program_id':1, 'active_job_id':'newer-a', 'basis_year':2026}
    job = {'created_by':None, 'local_ingestion':True, 'document_id':'doc',
           'parse_config':{'processing_mode':'automatic'}, 'chunk_config':{'payload':{'service_name':'공개 제도'}},
           'candidate_metadata':{'service_id':'WLF1'}, 'expected_active_job_id':'old-a'}
    cursor = Cursor([{'program_name':'공개 제도', 'service_id':'WLF1', 'test_only':False}])
    with pytest.raises(DocumentError, match='active_document_changed_create_new_job'):
        Store(cursor, job).activate('candidate-b', 'lease')
    assert len(cursor.calls) == 1 and 'FOR SHARE' in cursor.calls[0][0]
    assert all('welfare_publish_document' not in sql for sql, _ in cursor.calls)


def test_put_and_cancel_routes_forward_the_same_document_id(monkeypatch):
    import json
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from BackEnd.core.settings import Settings
    from BackEnd.documents import api
    from BackEnd.documents.auth import require_document_admin
    from BackEnd.documents.store import get_document_store

    document_id='00000000-0000-0000-0000-000000000001'
    calls=[]
    class Store:
        def register(self, metadata, file_hash, size, suffix, actor, config, original, *, document_id):
            calls.append(('register', str(document_id), metadata['test_only'], original))
            return {'document_id':document_id, 'program_id':1, 'active_job_id':'published-a'}, {'job_id':'candidate-b','state':'queued'}
        def cancel(self, doc_id, actor):
            calls.append(('cancel',doc_id))
            return 'candidate-b'
    monkeypatch.setattr(api, 'get_settings', lambda: Settings(_env_file=None))
    app=FastAPI();app.include_router(api.router)
    app.dependency_overrides[require_document_admin]=lambda:'synthetic-admin'
    app.dependency_overrides[get_document_store]=lambda:Store()
    metadata={'service_id':'WLF1','name':'합성 문서','source_url':'https://example.invalid','source_organization':'공개 기관','test_only':False}
    with TestClient(app) as client:
        response=client.put('/api/v1/admin/documents/'+document_id, data={'metadata':json.dumps(metadata)},files={'file':('source.md',b'plain source','text/markdown')})
        assert response.status_code==202 and response.json()['current_search_preserved'] is True
        response=client.post('/api/v1/admin/documents/'+document_id+'/cancel')
        assert response.status_code==200 and response.json()['state']=='cancelled'
    assert calls==[('register',document_id,False,b'plain source'),('cancel',document_id)]
