"""연락처 안내 기록만 저장한다. 질문·본문·프로필·사용자 식별자는 받지 않는다."""

from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import logging
import subprocess
import sys
from threading import Lock
import time
from uuid import UUID

import psycopg2
from psycopg2.extras import RealDictCursor
from pydantic import BaseModel, ConfigDict, Field, field_validator

from BackEnd.core.db import connection_options
from BackEnd.core.execution import current_budget
from BackEnd.core.settings import get_settings
from BackEnd.documents.contacts import _contact

RETENTION_DAYS = 90
WRITE_SECONDS = 2.0
logger = logging.getLogger('welfare_helper')
_maintenance_lock = Lock()
_next_prune = 0.0
_failed_writes = 0
_failures_lock = Lock()


class ReferralContact(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    label: str = Field(min_length=1, max_length=160)
    phone: str = Field(min_length=3, max_length=20)
    source_url: str = Field(min_length=1, max_length=2048)
    document_id: str
    document_version: str = Field(min_length=1, max_length=200)
    contact_version: str = Field(pattern=r'^[0-9a-f]{64}$')

    @field_validator('document_id')
    @classmethod
    def document_uuid(cls, value):
        return str(UUID(value))

    def verified(self):
        identity = self.model_dump(exclude={'contact_version'})
        version = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return (_contact(self.label, self.phone, self.source_url, 'service', '2000-01-01') is not None
                and hmac.compare_digest(version, self.contact_version))


def open_connection():
    options = connection_options(get_settings())
    options.update(connect_timeout=1, options='-c statement_timeout=1000 -c lock_timeout=250')
    return psycopg2.connect(**options)


class ReferralStore:
    def __init__(self, connection_factory=open_connection):
        self.connect = connection_factory

    @contextmanager
    def cursor(self, *, readonly=False):
        with closing(self.connect()) as conn:
            conn.set_session(isolation_level='REPEATABLE READ', readonly=readonly)
            with conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
                yield cur

    def record(self, response_id, contacts):
        response_id = str(UUID(response_id))
        if not 1 <= len(contacts) <= 3:
            raise ValueError('invalid_referral_count')
        contacts = [ReferralContact.model_validate(item) for item in contacts]
        if any(not item.verified() for item in contacts):
            raise ValueError('invalid_referral_contact')
        with self.cursor() as cur:
            for item in contacts:
                # 현재 게시 버전·공개 제도와 기존 부서 키를 같은 트랜잭션에서 고정한다.
                cur.execute("SELECT p.department_id FROM public.rag_documents d "
                            "JOIN public.welfare_programs p USING(program_id) "
                            "JOIN public.rag_document_jobs j ON j.job_id=d.active_job_id AND j.document_id=d.document_id "
                            "WHERE d.document_id=%s AND d.source_url=%s AND j.state='succeeded' "
                            "AND NOT d.test_only AND NOT p.test_only "
                            "AND left(coalesce(p.external_service_id,''),5)<>'TEST_' "
                            "AND EXISTS(SELECT 1 FROM public.welfare_document_vectors v "
                            "WHERE v.document_id=d.document_id AND v.job_id=d.active_job_id "
                            "AND v.evidence_metadata->'chunk'->>'version'=%s) FOR SHARE OF d,p",
                            (item.document_id, item.source_url, item.document_version))
                row = cur.fetchone()
                if row is None:
                    raise ValueError('referral_source_changed')
                cur.execute("INSERT INTO public.contact_referrals "
                            "(response_id,department_id,label,phone,contact_version,source_url,document_id,document_version) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            (response_id, row['department_id'], item.label, item.phone, item.contact_version,
                             item.source_url, item.document_id, item.document_version))

    @staticmethod
    def filters(start, end, department_id):
        return {'start': start, 'end': end, 'department': department_id,
                'cutoff': datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)}

    def search(self, start, end, department_id=None, *, offset=0, limit=50):
        params = self.filters(start, end, department_id)
        params.update(offset=offset, limit=limit + 1)
        where = (" WHERE r.created_at >= %(cutoff)s AND r.created_at >= %(start)s AND r.created_at < %(end)s "
                 "AND (%(department)s::bigint IS NULL OR r.department_id=%(department)s)")
        join = " FROM public.contact_referrals r JOIN public.departments d USING(department_id)"
        with self.cursor(readonly=True) as cur:
            cur.execute("SELECT r.*,d.department_name,d.ministry_name" + join + where +
                        " ORDER BY r.created_at DESC,r.response_id,r.contact_version LIMIT %(limit)s OFFSET %(offset)s", params)
            rows = [dict(row) for row in cur.fetchall()]
            cur.execute("SELECT r.department_id,d.department_name,d.ministry_name,"
                        "count(DISTINCT r.response_id) AS response_count" + join + where +
                        " GROUP BY r.department_id,d.department_name,d.ministry_name ORDER BY r.department_id", params)
            counts = [dict(row) for row in cur.fetchall()]
            cur.execute("SELECT count(DISTINCT r.response_id) AS response_count,count(*) AS contact_count "
                        "FROM public.contact_referrals r" + where, params)
            totals = dict(cur.fetchone())
        return {'items': rows[:limit], 'departments': counts, **totals,
                'next_offset': offset + limit if len(rows) > limit else None, 'retention_days': RETENTION_DAYS}

    def delete(self, start, end, department_id=None):
        with self.cursor() as cur:
            cur.execute("DELETE FROM public.contact_referrals WHERE created_at >= %s AND created_at < %s "
                        "AND (%s::bigint IS NULL OR department_id=%s)", (start, end, department_id, department_id))
            return cur.rowcount

    def prune(self):
        with self.cursor() as cur:
            cur.execute("DELETE FROM public.contact_referrals WHERE created_at < %s",
                        (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS),))
            return cur.rowcount


def failure_count():
    with _failures_lock:
        return _failed_writes


def record_public(response_id, contacts):
    """쓰기의 DNS·접속·SQL 지연도 답변을 붙잡지 않도록 관리되는 자식을 기다린다."""
    global _failed_writes
    try:
        if not contacts:
            return
        # 허용 필드만 직렬화한다. 원래 QA 응답이나 진단 객체를 자식에 넘기지 않는다.
        payload = {'response_id': str(UUID(response_id)),
                   'contacts': [ReferralContact.model_validate(item).model_dump() for item in contacts]}
        budget = current_budget()
        seconds = min(WRITE_SECONDS, budget.remaining() - .2) if budget else WRITE_SECONDS
        if seconds < .1:
            raise TimeoutError
        result = subprocess.run([sys.executable, '-m', 'BackEnd.admin.referral_store', 'record'],
                                input=json.dumps(payload, ensure_ascii=False).encode(), stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=seconds, check=False)
        if result.returncode:
            raise RuntimeError('referral_write_failed')
    except Exception as exc:
        with _failures_lock:
            _failed_writes += 1
        logger.warning('contact referral write omitted (%s)', type(exc).__name__)


def prune_due():
    """기존 worker의 유휴/작업 heartbeat에서 최대 10분마다 같은 원시 기록을 삭제한다."""
    global _next_prune
    if not get_settings().referral_records_enabled or not _maintenance_lock.acquire(blocking=False):
        return
    try:
        if time.monotonic() < _next_prune:
            return
        _next_prune = time.monotonic() + 600
        result = subprocess.run([sys.executable, '-m', 'BackEnd.admin.referral_store', 'prune'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=WRITE_SECONDS, check=False)
        if result.returncode:
            raise RuntimeError('referral_prune_failed')
    except Exception as exc:
        logger.warning('contact referral retention cleanup failed (%s)', type(exc).__name__)
    finally:
        _maintenance_lock.release()


if __name__ == '__main__':
    try:
        if not get_settings().referral_records_enabled:
            raise ValueError('recording_disabled')
        if sys.argv[1:] == ['record']:
            raw = sys.stdin.buffer.read(65537)
            if len(raw) > 65536:
                raise ValueError('invalid_referral_size')
            data = json.loads(raw)
            if set(data) != {'response_id', 'contacts'}:
                raise ValueError('invalid_referral_payload')
            ReferralStore().record(data['response_id'], data['contacts'])
        elif sys.argv[1:] == ['prune']:
            ReferralStore().prune()
        else:
            raise ValueError('invalid_referral_operation')
    except Exception:
        raise SystemExit(1) from None
