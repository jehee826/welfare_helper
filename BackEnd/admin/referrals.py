"""인증된 관리자의 연락처 안내 이력·서버 생성 건수만 제공한다."""

from datetime import date, datetime, time, timedelta, timezone
import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from BackEnd.admin.referral_store import ReferralStore, failure_count
from BackEnd.core.settings import get_settings
from BackEnd.documents.auth import require_document_admin

router = APIRouter(prefix='/api/v1/admin/referrals', tags=['연락처 안내 기록'],
                   dependencies=[Depends(require_document_admin)])
logger = logging.getLogger('welfare_helper')
KST = timezone(timedelta(hours=9))


def get_referral_store():
    if not get_settings().referral_records_enabled:
        raise HTTPException(503, 'referral_recording_disabled')
    return ReferralStore()


def period(date_from: date, date_to: date):
    if not date(2000, 1, 1) <= date_from <= date_to < date(9999, 12, 31) or (date_to - date_from).days >= 90:
        raise HTTPException(422, 'invalid_referral_period')
    return (datetime.combine(date_from, time.min, KST).astimezone(timezone.utc),
            datetime.combine(date_to + timedelta(days=1), time.min, KST).astimezone(timezone.utc))


def unavailable(exc):
    logger.warning('admin referral request failed (%s)', type(exc).__name__)
    raise HTTPException(503, 'referral_store_unavailable') from None


@router.get('')
def list_referrals(date_from: date, date_to: date, department_id: int | None = Query(default=None, ge=1),
                   offset: int = Query(default=0, ge=0, le=100000), limit: int = Query(default=50, ge=1, le=100),
                   store=Depends(get_referral_store)):
    start, end = period(date_from, date_to)
    try:
        return {**store.search(start, end, department_id, offset=offset, limit=limit),
                'failed_writes_since_restart': failure_count(), 'metric': 'server_generated_contact_referrals'}
    except Exception as exc:
        unavailable(exc)


@router.delete('')
def delete_referrals(date_from: date, date_to: date, department_id: int | None = Query(default=None, ge=1),
                     store=Depends(get_referral_store)):
    start, end = period(date_from, date_to)
    try:
        return {'deleted_contacts': store.delete(start, end, department_id)}
    except Exception as exc:
        unavailable(exc)
