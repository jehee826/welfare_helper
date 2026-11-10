"""모델·운영 DB·환경파일 없이 연락처 선택/쓰기 경계와 관리자 권한을 확인한다."""

from copy import deepcopy
from dataclasses import replace
from datetime import date, timedelta, timezone
import hashlib
import json
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import pytest

import BackEnd.main as api
from BackEnd.admin import referral_store, referrals, session
from BackEnd.core import execution
from BackEnd.core.settings import Settings
from BackEnd.documents import auth
from BackEnd.documents.qa import answer_document
from BackEnd.tests.test_document_qa import components, DOC_ID


def contact(**changes):
    value = {'label': '합성 담당 부서', 'phone': '02-123-4567', 'source_url': 'https://example.go.kr/service',
             'document_id': DOC_ID, 'document_version': 'v1'}
    value.update(changes)
    value['contact_version'] = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return value


def qa_system():
    repo, service, calls = components()
    snapshot = repo.snapshot()
    chunk = replace(snapshot.chunks[0], version='v1', source_url='https://example.go.kr/service',
                    heading_context='문의처', text='합성 담당 부서 02-123-4567')
    repo.snapshot = lambda: replace(snapshot, chunks=[chunk])
    repo.dense_search = lambda *_args, **_kwargs: [replace(chunk, score=.8)]
    return repo, service, calls


@pytest.mark.parametrize('selection', ['chosen', 'none', 'unknown', 'duplicate', 'fallback'])
def test_llm_selects_only_admitted_contacts_in_the_same_generation(selection):
    repo, service, calls = qa_system()
    prompts = []
    def generate(system, prompt, *, schema):
        prompts.append((system, prompt))
        sources = json.loads(prompt.split('문서 근거(JSON):\n')[1].split('\n\n질문:')[0])
        candidates = [item for source in sources for item in source['contact_candidates']]
        assert len(candidates) == 1 and 'contact_ids' in schema['properties']
        identifier = candidates[0]['id']
        ids = {'chosen': [identifier], 'none': [], 'unknown': ['invented'],
               'duplicate': [identifier, identifier], 'fallback': [identifier]}[selection]
        return {'status': 'no_evidence' if selection == 'fallback' else 'answer',
                'text': '합성 담당 부서에 문의하세요.', 'contact_ids': ids}
    service.llm.chat = generate
    response, trace = answer_document(repo, service, '연락처를 알려 주세요.', select_contacts=True)
    assert len(prompts) == 1 and calls['embeddings'] == 1
    if selection == 'chosen':
        assert [item['phone'] for item in response['contacts']] == ['02-123-4567']
        assert trace['selected_contacts'] == [contact()]
        assert not any(key in response for key in ('contact_ids', 'selected_contacts', 'response_id'))
    else:
        assert response['contacts'] == [] and trace['selected_contacts'] == []
        if selection in {'unknown', 'duplicate', 'fallback'}:
            assert response['reason'] == 'invalid_evidence_answer'


def test_contact_candidate_metadata_counts_against_input_budget():
    repo, service, _ = qa_system()
    service.llm.input_cost = lambda system, prompt: 50000 if 'contact_candidates' in prompt else 0
    service.llm.chat = Mock()
    response, _ = answer_document(repo, service, '문의', select_contacts=True)
    assert response['reason'] == 'document_input_budget'
    service.llm.chat.assert_not_called()


def test_two_service_contacts_keep_their_own_document_provenance():
    repo, service, _ = qa_system()
    snapshot = repo.snapshot(); first = snapshot.chunks[0]
    second = replace(first, chunk_id='second', service_id='PROGRAM_2', document_id=str(uuid4()), version='v2',
                     source_url='https://other.go.kr/service', text='다른 담당 부서 02-987-6543')
    repo.document_scope = None
    repo.snapshot = lambda: replace(snapshot, chunks=[first, second])
    repo.dense_search = lambda *_a, **_kw: [replace(item, score=.8) for item in (first, second)]
    def generate(_system, prompt, **_kw):
        sources = json.loads(prompt.split('문서 근거(JSON):\n')[1].split('\n\n질문:')[0])
        ids = [item['id'] for source in sources for item in source['contact_candidates']]
        assert len(ids) == 2
        return {'status': 'answer', 'text': '두 업무 담당 부서에 각각 문의하세요.', 'contact_ids': ids}
    service.llm.chat = generate
    response, trace = answer_document(repo, service, '두 문의처', select_contacts=True)
    assert len(response['contacts']) == 2
    assert {(item['phone'], item['document_id']) for item in trace['selected_contacts']} == {
        ('02-123-4567', first.document_id), ('02-987-6543', second.document_id)}


@pytest.mark.parametrize('phone', ['129', '010-1234-5678'])
def test_general_and_private_phone_never_become_candidates(phone):
    repo, service, _ = qa_system()
    snapshot = repo.snapshot()
    repo.snapshot = lambda: replace(snapshot, chunks=[replace(snapshot.chunks[0], text='합성 담당 부서 ' + phone)])
    repo.dense_search = lambda *_a, **_kw: [replace(repo.snapshot().chunks[0], score=.8)]
    def generate(_system, prompt, **_kw):
        sources = json.loads(prompt.split('문서 근거(JSON):\n')[1].split('\n\n질문:')[0])
        assert all(source['contact_candidates'] == [] for source in sources)
        return {'status': 'answer', 'text': '자료를 확인하세요.', 'contact_ids': []}
    service.llm.chat = generate
    assert answer_document(repo, service, '문의', select_contacts=True)[0]['contacts'] == []


@pytest.fixture
def http(monkeypatch):
    settings = Settings(_env_file=None, documents_enabled=True, admin_password='synthetic-admin', referral_records_enabled=True)
    for module in (api, auth, session, referrals, referral_store):
        monkeypatch.setattr(module, 'get_settings', lambda: settings)
    monkeypatch.setattr(session, '_sessions', {})
    monkeypatch.setattr(session, '_failures', session.OrderedDict())
    base = SimpleNamespace(repo=SimpleNamespace(include_local_documents=False, document_scope=None))
    api.app.dependency_overrides[api.get_chat_service] = lambda: base
    monkeypatch.setattr(api, 'PgServiceRepository', lambda *_a, **kw: SimpleNamespace(**kw))
    monkeypatch.setattr(api, 'build_chat_service', lambda repo, settings: SimpleNamespace(repo=repo))
    item = contact()
    shown = {key: item[key] for key in ('label', 'phone', 'source_url')}
    shown.update(kind='service', checked_at='2026-11-07')
    response = {'kind': 'answer', 'text': '합성 담당 부서로 문의하세요.', 'contacts': [shown], 'services': [], 'suggestions': [], 'evidence': []}
    trace = {'selected_contacts': [item]}
    generation = Mock(side_effect=lambda *_a, **_kw: (deepcopy(response), deepcopy(trace)))
    written = Mock()
    store = SimpleNamespace(search=Mock(return_value={'items': [], 'departments': [], 'response_count': 0, 'contact_count': 0,
                                                     'next_offset': None, 'retention_days': 90}), delete=Mock(return_value=2))
    monkeypatch.setattr(api, 'answer_document', generation)
    monkeypatch.setattr(api, 'record_public', written)
    monkeypatch.setattr(referrals, 'ReferralStore', lambda: store)
    with TestClient(api.app) as client:
        yield SimpleNamespace(client=client, settings=settings, response=response, trace=trace, generation=generation,
                              written=written, store=store, base=base)
    api.app.dependency_overrides.clear()


def test_public_capabilities_report_actual_collection_flag_without_writing(http):
    for enabled in (True, False):
        http.settings.referral_records_enabled = enabled
        response = http.client.get('/api/v1/chat/capabilities')
        assert response.status_code == 200 and response.json()['referral_records_enabled'] is enabled
        assert response.headers['cache-control'] == 'no-store'
    http.written.assert_not_called();http.generation.assert_not_called()


def admin(http):
    response = http.client.post('/api/v1/admin/login', json={'password': 'synthetic-admin'})
    return {'Authorization': 'Bearer ' + response.json()['access_token']}


def test_only_public_normal_chat_can_record_allowlisted_contact_fields(http):
    response = http.client.post('/api/v1/chat', json={'query': '합성 문의 질문'})
    assert response.status_code == 200 and response.json()['contacts']
    assert response.headers['cache-control'] == 'no-store'
    http.written.assert_called_once()
    identifier, records = http.written.call_args.args
    assert UUID(identifier).version == 4 and records == [contact()]
    assert 'select_contacts' in http.generation.call_args.kwargs
    assert all(key not in json.dumps(records) for key in ('query', 'text', 'summary', 'profile', 'ip_address'))


@pytest.mark.parametrize('case', ['admin', 'disabled', 'fallback', 'empty', 'mismatch', 'private_scope', 'failed', 'cancelled'])
def test_nonpublic_or_unusable_outputs_never_record(http, case):
    headers = {}
    if case == 'admin': headers = admin(http)
    elif case == 'disabled': http.settings.referral_records_enabled = False
    elif case == 'fallback': http.response['kind'] = 'fallback'
    elif case == 'empty': http.response['contacts'] = []
    elif case == 'mismatch': http.trace['selected_contacts'][0]['phone'] = '02-999-9999'
    elif case == 'private_scope': http.base.repo.include_local_documents = True
    elif case == 'failed': http.generation.side_effect = RuntimeError('synthetic-private-failure')
    elif case == 'cancelled': http.generation.side_effect = execution.ExecutionCancelledError()
    response = http.client.post('/api/v1/chat', headers=headers, json={'query': '합성 문의 질문'})
    assert response.status_code in {200, 499, 503}
    http.written.assert_not_called()


def test_admin_filters_delete_and_session_expiry_share_the_auth_boundary(http):
    path = '/api/v1/admin/referrals?date_from=2026-11-01&date_to=2026-11-07&department_id=2'
    assert http.client.get(path).status_code == 401
    assert http.client.delete(path).status_code == 401
    headers = admin(http)
    assert http.client.get(path, headers=headers).json()['metric'] == 'server_generated_contact_referrals'
    start, end, department = http.store.search.call_args.args
    assert start.isoformat() == '2026-10-31T15:00:00+00:00'
    assert end.isoformat() == '2026-11-07T15:00:00+00:00' and department == 2
    assert http.client.delete(path, headers=headers).json() == {'deleted_contacts': 2}
    http.client.post('/api/v1/admin/logout', headers=headers)
    assert http.client.get(path, headers=headers).status_code == 401


@pytest.mark.parametrize('dates', ['date_from=2026-11-08&date_to=2026-11-07',
                                 'date_from=2026-01-01&date_to=2026-11-07', 'date_from=invalid&date_to=2026-11-07'])
def test_invalid_periods_cannot_delete(http, dates):
    assert http.client.delete('/api/v1/admin/referrals?' + dates, headers=admin(http)).status_code == 422
    http.store.delete.assert_not_called()


def test_disabled_or_failed_store_does_not_expose_private_error(http):
    headers = admin(http)
    path = '/api/v1/admin/referrals?date_from=2026-11-01&date_to=2026-11-07'
    http.settings.referral_records_enabled = False
    assert http.client.get(path, headers=headers).status_code == 503
    http.settings.referral_records_enabled = True
    http.store.search.side_effect = RuntimeError('synthetic-private-db-detail')
    response = http.client.get(path, headers=headers)
    assert response.status_code == 503 and 'synthetic-private' not in response.text


def test_write_child_is_bounded_and_receives_no_question_or_profile(monkeypatch, caplog):
    run = Mock(side_effect=subprocess.TimeoutExpired('synthetic', 2))
    monkeypatch.setattr(referral_store.subprocess, 'run', run)
    monkeypatch.setattr(referral_store, '_failed_writes', 0)
    referral_store.record_public(str(uuid4()), [contact()])
    options = run.call_args.kwargs
    assert 0 < options['timeout'] <= 2
    assert set(json.loads(options['input'])) == {'response_id', 'contacts'}
    assert referral_store.failure_count() == 1 and 'TimeoutExpired' in caplog.text
    assert '합성 담당' not in caplog.text


def test_failed_bounded_write_still_returns_the_normal_answer(http, monkeypatch):
    monkeypatch.setattr(api, 'record_public', referral_store.record_public)
    monkeypatch.setattr(referral_store.subprocess, 'run', Mock(side_effect=subprocess.TimeoutExpired('synthetic', 2)))
    monkeypatch.setattr(referral_store, '_failed_writes', 0)
    response = http.client.post('/api/v1/chat', json={'query': '합성 문의 질문'})
    assert response.status_code == 200 and response.json()['kind'] == 'answer'
    assert response.json()['contacts'] and referral_store.failure_count() == 1


def test_no_budget_or_private_extra_fields_cannot_start_a_write_child(monkeypatch):
    run = Mock(); monkeypatch.setattr(referral_store.subprocess, 'run', run)
    monkeypatch.setattr(referral_store, 'current_budget', lambda: SimpleNamespace(remaining=lambda: .2))
    referral_store.record_public(str(uuid4()), [contact()])
    referral_store.record_public(str(uuid4()), [{**contact(), 'question': 'synthetic-private-question'}])
    run.assert_not_called()


def test_retention_runs_only_when_enabled_and_at_most_every_ten_minutes(monkeypatch):
    settings = Settings(_env_file=None)
    monkeypatch.setattr(referral_store, 'get_settings', lambda: settings)
    monkeypatch.setattr(referral_store, '_next_prune', 0)
    run = Mock(return_value=SimpleNamespace(returncode=0)); monkeypatch.setattr(referral_store.subprocess, 'run', run)
    referral_store.prune_due(); run.assert_not_called()
    settings.referral_records_enabled = True
    referral_store.prune_due(); referral_store.prune_due()
    run.assert_called_once()
    assert run.call_args.args[0][-1] == 'prune' and run.call_args.kwargs['timeout'] == 2
