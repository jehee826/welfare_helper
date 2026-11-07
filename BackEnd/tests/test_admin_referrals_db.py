"""빈 전용 임시 PostgreSQL에서만 실행한다. 운영 DB·기존 스키마는 사용하지 않는다."""

from contextlib import closing
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import psycopg2
import pytest

from BackEnd.admin.referral_store import ReferralStore, record_public, failure_count
from BackEnd.admin.referrals import period
from BackEnd.tests.test_admin_referrals import contact, DOC_ID

URL = os.environ.get('WELFARE_REFERRAL_TEST_DATABASE_URL', '')
pytestmark = pytest.mark.skipif(not URL, reason='전용 임시 연락처 검사 DB가 없음')
JOB_ID = '00000000-0000-0000-0000-000000000002'


def connect():
    target = urlsplit(URL)
    assert target.hostname in {'localhost', '127.0.0.1'} and target.path == '/welfare_referral_checks'
    return psycopg2.connect(URL, connect_timeout=1, options='-c statement_timeout=2000')


@pytest.fixture(scope='module', autouse=True)
def schema():
    if not URL:
        return
    with closing(connect()) as conn, conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
        assert cur.fetchone()[0] == 0, '기존 테이블이 있는 DB에서는 검사 준비를 중단한다.'
        cur.execute('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;')
        cur.execute('CREATE TABLE public.departments(department_id bigint PRIMARY KEY,department_name text,ministry_name text);'
                    'CREATE TABLE public.welfare_programs(program_id bigint PRIMARY KEY,department_id bigint,external_service_id text,test_only boolean);'
                    'CREATE TABLE public.rag_documents(document_id uuid PRIMARY KEY,program_id bigint,source_url text,active_job_id uuid,test_only boolean);'
                    'CREATE TABLE public.rag_document_jobs(job_id uuid PRIMARY KEY,document_id uuid,state text);'
                    'CREATE TABLE public.welfare_document_vectors(document_id uuid,job_id uuid,evidence_metadata jsonb);')
        cur.execute(Path('BackEnd/db/migrations/0006_contact_referrals.sql').read_text(encoding='utf-8'))


@pytest.fixture
def store():
    with closing(connect()) as conn, conn, conn.cursor() as cur:
        cur.execute('TRUNCATE public.contact_referrals,public.welfare_document_vectors,public.rag_document_jobs,'
                    'public.rag_documents,public.welfare_programs,public.departments')
        cur.execute("INSERT INTO public.departments VALUES (1,'합성 부서','합성 기관'),(2,'다른 부서','다른 기관')")
        cur.execute("INSERT INTO public.welfare_programs VALUES (1,1,'PROGRAM_1',false),(2,2,'PROGRAM_2',false)")
        cur.execute("INSERT INTO public.rag_documents VALUES (%s,1,'https://example.go.kr/service',%s,false)", (DOC_ID, JOB_ID))
        cur.execute("INSERT INTO public.rag_document_jobs VALUES (%s,%s,'succeeded')", (JOB_ID, DOC_ID))
        cur.execute("INSERT INTO public.welfare_document_vectors VALUES (%s,%s,%s::jsonb)", (DOC_ID, JOB_ID, '{"chunk":{"version":"v1"}}'))
    return ReferralStore(connect)


def bounds():
    now = datetime.now(timezone.utc)
    return now - timedelta(days=89), now + timedelta(days=1)


def test_schema_has_only_contact_provenance_and_anon_has_no_access(store):
    store.record(str(uuid4()), [contact()])
    with closing(connect()) as conn, conn.cursor() as cur:
        cur.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='contact_referrals'")
        assert {row[0] for row in cur.fetchall()} == {'response_id','department_id','label','phone','contact_version',
                                                   'source_url','document_id','document_version','created_at'}
        cur.execute('SET ROLE anon')
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            cur.execute('SELECT * FROM public.contact_referrals')


def test_idempotency_and_two_contacts_in_one_department_count_one_response(store):
    response_id = str(uuid4())
    records = [contact(), contact(label='두 번째 업무 부서', phone='02-987-6543')]
    store.record(response_id, records); store.record(response_id, records)
    result = store.search(*bounds(), limit=1)
    assert result['response_count'] == 1 and result['contact_count'] == 2
    assert result['departments'][0]['response_count'] == 1
    assert len(result['items']) == 1 and result['next_offset'] == 1
    assert store.search(*bounds(), offset=1, limit=1)['next_offset'] is None


def test_two_departments_count_one_each_but_one_total_response(store):
    document, job = str(uuid4()), str(uuid4())
    with closing(connect()) as conn, conn, conn.cursor() as cur:
        cur.execute("INSERT INTO public.rag_documents VALUES (%s,2,'https://other.go.kr/service',%s,false)", (document, job))
        cur.execute("INSERT INTO public.rag_document_jobs VALUES (%s,%s,'succeeded')", (job, document))
        cur.execute("INSERT INTO public.welfare_document_vectors VALUES (%s,%s,%s::jsonb)", (document, job, '{"chunk":{"version":"v2"}}'))
    store.record(str(uuid4()), [contact(), contact(label='다른 담당 부서', phone='02-987-6543', source_url='https://other.go.kr/service',
                                                 document_id=document, document_version='v2')])
    result = store.search(*bounds())
    assert result['response_count'] == 1 and result['contact_count'] == 2
    assert [item['response_count'] for item in result['departments']] == [1, 1]
    assert store.search(*bounds(), department_id=2)['contact_count'] == 1


@pytest.mark.parametrize('change', ["UPDATE public.rag_documents SET test_only=true", "UPDATE public.welfare_programs SET test_only=true",
                                  "UPDATE public.welfare_programs SET external_service_id='TEST_PRIVATE'",
                                  "UPDATE public.rag_document_jobs SET state='failed'", "UPDATE public.rag_documents SET active_job_id=NULL",
                                  "UPDATE public.welfare_document_vectors SET evidence_metadata='{}'::jsonb"])
def test_nonpublic_or_changed_publication_cannot_record(store, change):
    with closing(connect()) as conn, conn, conn.cursor() as cur:
        cur.execute(change)
    with pytest.raises(ValueError, match='referral_source_changed'):
        store.record(str(uuid4()), [contact()])
    assert store.search(*bounds())['contact_count'] == 0


def test_invalid_contact_or_one_changed_version_rolls_back_whole_response(store):
    with pytest.raises(ValueError):
        store.record(str(uuid4()), [contact(phone='129')])
    with pytest.raises(ValueError):
        store.record(str(uuid4()), [contact(), contact(document_version='old')])
    assert store.search(*bounds())['contact_count'] == 0


def test_retention_exclusion_purge_and_period_delete_reduce_same_raw_statistics(store):
    expired, current = str(uuid4()), str(uuid4())
    store.record(expired, [contact()]); store.record(current, [contact()])
    with closing(connect()) as conn, conn, conn.cursor() as cur:
        cur.execute("UPDATE public.contact_referrals SET created_at=now()-interval '91 days' WHERE response_id=%s", (expired,))
    assert store.search(*bounds())['response_count'] == 1
    assert store.prune() == 1
    assert store.delete(*bounds()) == 1
    result = store.search(*bounds())
    assert result['response_count'] == result['contact_count'] == 0 and result['departments'] == []


def test_korean_date_boundaries_are_start_inclusive_end_exclusive(store):
    today = (datetime.now(timezone.utc) + timedelta(hours=9)).date()
    start, end = period(today, today)
    for at in (start-timedelta(microseconds=1), start, end-timedelta(microseconds=1), end):
        identifier = str(uuid4()); store.record(identifier, [contact()])
        with closing(connect()) as conn, conn, conn.cursor() as cur:
            cur.execute('UPDATE public.contact_referrals SET created_at=%s WHERE response_id=%s', (at, identifier))
    assert store.search(start, end)['response_count'] == 2
    assert store.delete(start, end) == 2
    assert store.search(start, end)['contact_count'] == 0


def test_managed_child_commits_only_contacts_to_the_disposable_database(store, monkeypatch):
    monkeypatch.delenv('DATABASE_URL', raising=False)
    for name, value in {'DATABASE_MODE': 'local', 'DB_HOST': '127.0.0.1', 'DB_PORT': '5432',
                        'DB_USER': 'postgres', 'DB_PASSWORD': 'synthetic-check-only',
                        'DB_NAME': 'welfare_referral_checks', 'REFERRAL_RECORDS_ENABLED': 'true'}.items():
        monkeypatch.setenv(name, value)
    before = failure_count()
    identifier = str(uuid4())
    record_public(identifier, [contact()]); record_public(identifier, [contact()])
    assert failure_count() == before
    assert store.search(*bounds())['contact_count'] == 1
