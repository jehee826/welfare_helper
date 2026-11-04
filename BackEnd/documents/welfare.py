"""관련 원문 범위와 답변의 기술 형식을 확인한다. 답변의 사실 정확도를 인증하지 않는다."""

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from BackEnd.documents.contracts import DocumentError


class WelfareAnswer(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['answer', 'clarify', 'no_evidence', 'out_of_scope']
    text: str = Field(min_length=1, max_length=3000)


def complete_sources(snapshot, selected, query=''):
    """관련 부모와 조건·예외를 보완한다. 이전 버전·다른 문서를 섞지 않는다."""
    result, seen = [], set()
    # 짧거나 간접적인 질문에도 같은 문서의 기본 지원·신청 내용과 조건을 함께 전달한다.
    required_heading = (r'대상|자격|조건|선정|예외|기준|기한|기간|시행|현행|제외|지역|시도|시군구|거주|수정|연도|'
                        r'급여|혜택|지원\s*(?:내용|금|액|한도)|수강료|이용권|바우처|'
                        r'신청|접수|절차|제출|구비|필요\s*서류')
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


def validate_answer(raw):
    answer = WelfareAnswer.model_validate_json(raw) if isinstance(raw,str) else WelfareAnswer.model_validate(raw)
    if not answer.text.strip():
        raise ValueError('empty_answer')
    return answer
