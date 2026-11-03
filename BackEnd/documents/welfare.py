"""복지 답변의 원문 범위와 인용 형식을 확인한다. 의미적 자격 판정을 대신하지 않는다."""

import json
import re
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.context import safe_context_text


class Citation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=500)
    quote: str = Field(min_length=1, max_length=1600)


class WelfareAnswer(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['answer', 'clarify', 'no_evidence', 'out_of_scope']
    text: str = Field(min_length=1, max_length=3000)
    citations: list[Citation] = Field(max_length=6)


def complete_sources(snapshot, selected, query=''):
    """관련 부모와 조건·예외를 보완한다. 이전 버전·다른 문서를 섞지 않는다."""
    result, seen = [], set()
    # 메타데이터 조각이 높은 순위를 차지해도 질문이 요청한 급여·신청 절은 빠뜨리지 않는다.
    topics = []
    if re.search(r'혜택|급여|지원\s*(?:금|액|한도|내용)|금액|한도|얼마|수강료|바우처|이용권', query):
        topics.append(r'급여|혜택|지원\s*(?:내용|금|액|한도)|수강료|이용권|바우처')
    if re.search(r'신청|접수|절차|서류|준비물|온라인|방문|어디|방법', query):
        topics.append(r'신청|접수|절차|제출|구비|필요\s*서류')
    required_heading = '|'.join([r'대상|자격|조건|선정|예외|기준|기한|기간|시행|현행|제외|지역|시도|시군구|거주|수정|연도', *topics])
    for anchor in selected:
        identity = lambda c: (c.document_id, c.service_id, c.version, c.source_hash, c.source_url,
                              c.basis_year, c.source_updated_at, c.analysis_hash, c.processing_hash, c.embed_digest)
        chunks = [anchor]
        if anchor.document_id and anchor.version:
            chunks = [c for c in snapshot.chunks if c.document_id == anchor.document_id]
            if any(identity(c) != identity(anchor) for c in chunks):
                raise DocumentError('document_evidence_version_mismatch')
            parents = {parent for c in selected if identity(c) == identity(anchor)
                       for parent in (*c.required_parents, c.parent_id or c.chunk_id)}
            available_parents = {c.parent_id or c.chunk_id for c in chunks}
            if not parents.issubset(available_parents):
                raise DocumentError('document_evidence_incomplete')
            parents.update(c.parent_id or c.chunk_id for c in chunks if re.search(required_heading, c.heading_context))
            chunks = [c for c in chunks if (c.parent_id or c.chunk_id) in parents]
            if any(not c.complete for c in chunks):
                raise DocumentError('document_evidence_incomplete')
            chunks.sort(key=lambda c: (c.parent_index, c.ordinal, c.start))
        for chunk in chunks:
            if chunk.chunk_id not in seen:
                result.append(chunk)
                seen.add(chunk.chunk_id)
    return result


def quantities(text):
    values = set()
    for number, unit in re.findall(r'(\d[\d,]*(?:\.\d+)?)\s*(만\s*원|천\s*원|원|%|세|일|개월|년)', text):
        unit = re.sub(r'\s+', '', unit)
        value = Decimal(number.replace(',', ''))
        if unit in {'만원', '천원'}:
            value *= 10000 if unit == '만원' else 1000
            unit = '원'
        values.add((value, unit))
    return values


def _document_claims(text, user_sources):
    if not re.search(r'말씀하신\s*[“"]', text):
        return text
    header, separator, claims = text.partition('\n\n')
    if not separator or not claims.strip() or re.search(r'말씀하신\s*[“"]', claims):
        raise ValueError('unsupported_user_quote')
    for line in header.split('\n'):
        match = re.fullmatch(r'말씀하신 “([^“”\r\n]+)”', line)
        if not match or match[1] not in user_sources:
            raise ValueError('unsupported_user_quote')
        try:
            safe_context_text(match[1])
        except ValueError:
            raise ValueError('unsupported_user_quote') from None
    return claims


def validate_answer(raw, documents, *, user_sources=()):
    answer = WelfareAnswer.model_validate_json(raw) if isinstance(raw,str) else WelfareAnswer.model_validate(raw)
    if not answer.text.strip():
        raise ValueError('empty_answer')
    if answer.status != 'answer':
        if answer.citations:
            raise ValueError('unsupported_citations')
        if answer.status == 'clarify' and not quantities(answer.text).issubset(quantities(json.dumps(documents, ensure_ascii=False))):
            raise ValueError('unsupported_clarification_quantity')
        return answer
    by_id = {doc.get('reference_id',doc['id']): doc for doc in documents}
    if len(by_id) != len(documents) or len({d['id'] for d in documents}) != len(documents):
        raise ValueError('invalid_source_references')
    if not answer.citations or len({c.id for c in answer.citations}) != len(answer.citations):
        raise ValueError('missing_or_duplicate_citation')
    for citation in answer.citations:
        if citation.id not in by_id or not citation.quote.strip() or citation.quote not in by_id[citation.id]['text']:
            raise ValueError('citation_not_in_source')
    sources = json.dumps([by_id[c.id] for c in answer.citations], ensure_ascii=False)
    # 정확한 발췌와 숫자·연락처 대응만 확인한다. 인용이 모든 주장의 의미를 증명하지는 않는다.
    # 검증한 독립 사용자 인용행만 제외한다. 문서 주장이나 연락처에 수치를 재사용할 권한은 주지 않는다.
    if not quantities(_document_claims(answer.text, user_sources)).issubset(quantities(sources)):
        raise ValueError('unsupported_quantity')
    for value in re.findall(r'https?://[^\s<>"\)]+|0\d{1,2}-\d{3,4}-\d{4}', answer.text):
        if value.rstrip('.,') not in sources:
            raise ValueError('unsupported_contact')
    return answer
