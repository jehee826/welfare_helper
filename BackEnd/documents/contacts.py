"""검색 근거와 별도로 출처를 확인할 수 있는 문의처만 구성한다."""

import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, unquote, urlparse

from BackEnd.documents.context import safe_context_text
from BackEnd.rag.text import name_key, parse_contacts


PHONE = re.compile(r"(?:1\d{2,3}|1\d{3}-\d{4}|0[2-9]\d{0,2}-\d{3,4}-\d{4})")
CONTACT_LINE = re.compile(r"^\s*(?:[-*+]\s*)?(?:문의(?:처)?|연락처|전화(?:번호)?)\s*[:：]\s*(.+)$")


def _contact(label, phone, source_url, kind, checked_at, hours=None):
    if not all(isinstance(value, str) for value in (label, phone, source_url)):
        return None
    label, phone, source_url = label.strip(), phone.strip(), source_url.strip()
    if not label or len(label) > 160 or not PHONE.fullmatch(phone) or phone == '129' or len(source_url) > 2048:
        return None
    try:
        safe_context_text(label)
        safe_context_text(unquote(source_url))
        url = urlparse(source_url)
        if (url.scheme != 'https' or not url.hostname or not url.hostname.endswith('.go.kr')
                or url.username or url.password or url.port not in (None, 443)
                or any(re.search(r'token|password|secret|key|auth', key, re.I) for key, _ in parse_qsl(url.query))
                or re.search(r'(?:token|password|secret|key|auth)\s*[:=]', unquote(url.fragment), re.I)
                or re.search(r'(?:token|secret)\s*[:=]', label, re.I)
                or re.search(r'[\x00-\x1f]', label + source_url)):
            return None
    except (ValueError, TypeError):
        return None
    return {'label': label, 'phone': phone, 'kind': kind, 'source_url': source_url,
            'checked_at': checked_at, **({'hours': hours} if hours else {})}


def fallback_contacts(snapshot, documents=(), *, query='', confirmed_document_ids=()):
    """탈락 문서를 보지 않고 확정된 서비스 원문·메타데이터를 우선한다."""
    included_ids = {d['document_id'] for d in documents}
    admitted = [c for c in snapshot.chunks if c.document_id in included_ids]
    records = {record.service_id: record for record in snapshot.services}
    query_key = name_key(query)
    confirmed = set(confirmed_document_ids)
    service_ids = {c.service_id for c in admitted if c.document_id in confirmed
                   or c.service_id in records and len(name_key(records[c.service_id].name)) >= 3
                   and name_key(records[c.service_id].name) in query_key}
    contacts, seen = [], set()
    # 자료 대조일이며 기관의 최신 연락처를 외부 조회한 검증일이 아니다.
    checked_at = datetime.now(timezone(timedelta(hours=9))).date().isoformat()
    if len(service_ids) == 1:
        service_id = next(iter(service_ids))
        chunks = [c for c in admitted if c.service_id == service_id]
        for chunk in chunks:
            candidates = []
            body = chunk.text.partition('\n')[2] if chunk.text.startswith('#') else chunk.text
            sections = []
            if re.search(r'문의|연락처|전화', chunk.heading_context):
                sections.append(body)
            else:
                sections.extend(match.group(1) for line in body.splitlines() if (match := CONTACT_LINE.match(line)))
            for section in sections:
                if not re.search(r'<[^>]*>|\bBearer\s+|(?:password|비밀번호|api[_ -]?key|access[_ -]?token)\s*[:=：]', section, re.I):
                    candidates.extend(parse_contacts(section))
            record = records.get(service_id)
            if record and isinstance(record.contacts, list):
                candidates.extend(item for item in record.contacts if isinstance(item, dict)
                                  and isinstance(item.get('phone'), str)
                                  and re.search(r'(?<![\d-])' + re.escape(item['phone']) + r'(?![\d-])', chunk.text))
            for item in candidates:
                label = item.get('label')
                if label in (None, '', '문의처', '연락처', '전화번호'):
                    label = snapshot.document_metadata.get(chunk.document_id, {}).get('source_organization')
                contact = _contact(label, item.get('phone'), chunk.source_url, 'service', checked_at)
                if contact and contact['phone'].replace('-', '') not in seen:
                    seen.add(contact['phone'].replace('-', ''))
                    contacts.append(contact)
                    if len(contacts) == 3:
                        return contacts
    return contacts
