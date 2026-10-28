"""같은 DB 스냅샷에서 현재 문서·작업·벡터와 근거의 연결을 확인한다."""

import json
from array import array
from datetime import datetime

from psycopg2.extras import RealDictCursor

from BackEnd.documents.contracts import DocumentError, automatic_source_fingerprint, stable_hash, validate_review
from BackEnd.rag.evidence import read_chunk, validate_version
from BackEnd.rag.embeddings import validate_embeddings


def validate_document_vectors(doc, job, rows):
    analysis = doc['analysis_json']
    payload = job['chunk_config'].get('payload', {})
    automatic = job['chunk_config'].get('processing_mode') == 'automatic'
    if (not analysis or analysis.get('markdown') != doc['markdown']
            or stable_hash(analysis) != payload.get('analysis_hash') or not rows):
        raise DocumentError('document_analysis_mismatch')
    if doc.get('program_test_only') and not doc['test_only']:
        raise DocumentError('test_program_requires_test_document')
    if automatic:
        if (payload.get('processing_mode') != 'automatic' or analysis.get('blockers')
                or not analysis.get('blocks') or doc['reviewed_by'] is not None or doc['reviewed_at'] is not None
                or automatic_source_fingerprint(doc) != payload.get('source_fingerprint')):
            raise DocumentError('document_automatic_processing_mismatch')
    else:
        validate_review(analysis, payload['review'])
    if doc['document_name'] != doc.get('name', doc['document_name']):
        raise DocumentError('document_name_mismatch')
    by_block = {b['id']:b for b in analysis['blocks']}
    chunks, vectors = [], {}
    for index, row in enumerate(rows):
        metadata = row['evidence_metadata'].get('chunk', {})
        chunk = read_chunk(metadata.get('chunk_id',''), doc['service_id'], json.dumps(metadata,ensure_ascii=False), doc['source_url'])
        if (row['chunk_index'] != index or str(row['document_id']) != str(doc['document_id'])
                or str(row['job_id']) != str(job['job_id'])
                or chunk.source_kind != ('automatic_document' if automatic else 'reviewed_document')
                or chunk.document_id != str(doc['document_id']) or chunk.document_name != doc['document_name']
                or chunk.service_name != doc['service_name'] or chunk.source_url != doc['source_url']
                or chunk.text != row['chunk_content'] or chunk.embedding_text() != row['embedding_text']
                or stable_hash(row['embedding_text'].encode()) != row['input_hash']
                or chunk.embed_digest != row['embedding_digest'] or row['embedding_model'] != job['embedding_model']
                or row['embedding_digest'] != job['embedding_digest']
                or chunk.analysis_hash != payload['analysis_hash']
                or automatic and (chunk.processing_mode != 'automatic' or chunk.processing_hash != stable_hash(payload)
                                  or chunk.review_hash or chunk.reviewed_by or chunk.reviewed_at
                                  or chunk.collected_at != payload.get('processed_at'))
                or not automatic and (chunk.review_hash != stable_hash(payload)
                                      or chunk.reviewed_by != payload['reviewed_by'] or chunk.reviewed_at != payload['reviewed_at'])
                or chunk.basis_year != str(doc.get('basis_year') or '')
                or chunk.source_updated_at != str(doc.get('source_updated_at') or '')
                or chunk.test_only != doc['test_only'] or not chunk.usable_detail):
            raise DocumentError('document_provenance_mismatch')
        if not automatic and (str(doc['reviewed_by'] or 'local') != chunk.reviewed_by
                or doc['reviewed_at'] != datetime.fromisoformat(chunk.reviewed_at)):
            raise DocumentError('document_review_mismatch')
        spans = row['source_spans']
        if not spans or min(s['start'] for s in spans) != row['char_start'] or max(s['end'] for s in spans) != row['char_end']:
            raise DocumentError('document_source_span_mismatch')
        covered = 0
        pages = set()
        for span in spans:
            block = by_block.get(span.get('block_id'))
            left, right = span.get('text_start'), span.get('text_end')
            if (not block or not automatic and span['block_id'] not in payload['review']['sections'][chunk.section]
                    or not isinstance(left,int) or not isinstance(right,int) or left < covered
                    or not 0 <= left < right <= len(chunk.text)
                    or not block['char_start'] <= span['start'] < span['end'] <= block['char_end']
                    or chunk.text[covered:left].strip()
                    or chunk.text[left:right] != doc['markdown'][span['start']:span['end']]):
                raise DocumentError('document_source_span_mismatch')
            covered = right
            pages.update(block['pages'])
        if chunk.text[covered:].strip() or row['char_count'] != len(chunk.text):
            raise DocumentError('document_source_span_mismatch')
        if (row['section_path'] != [chunk.section,*chunk.heading_context.splitlines()]
                or row['page_start'] != (min(pages) if pages else None)
                or row['page_end'] != (max(pages) if pages else None)):
            raise DocumentError('document_section_or_page_mismatch')
        if automatic and chunk.ordinal == 0:
            parent_blocks = {span['block_id'] for candidate in rows
                             if candidate['evidence_metadata'].get('chunk', {}).get('parent_index', 0) == chunk.parent_index
                             for span in candidate['source_spans']}
            referenced = [block['id'] for block in analysis['blocks'] if block['id'] in parent_blocks]
        else:
            referenced = payload['review']['sections'][chunk.section] if chunk.ordinal == 0 else [s['block_id'] for s in spans]
        expected_pages = tuple(sorted({p for bid in referenced for p in by_block[bid]['pages']}))
        if chunk.source_blocks != tuple(referenced) or chunk.page_refs != expected_pages:
            raise DocumentError('document_block_provenance_mismatch')
        chunks.append(chunk)
        if row.get('vector_text') is not None:
            values = json.loads(row['vector_text'])
            validate_embeddings([values], 1, 1024)
            vectors[chunk.chunk_id] = array('f', values)
    validate_version(chunks)
    if automatic:
        for block in analysis['blocks']:
            if not block.get('text', '').strip():
                continue
            spans = sorted((span for row in rows for span in row['source_spans'] if span['block_id'] == block['id']), key=lambda s:s['start'])
            covered = block['char_start']
            for span in spans:
                if doc['markdown'][covered:span['start']].strip():
                    raise DocumentError('automatic_document_source_incomplete')
                covered = max(covered, span['end'])
            if doc['markdown'][covered:block['char_end']].strip():
                raise DocumentError('automatic_document_source_incomplete')
    return chunks, vectors


def active_document_chunks(cur, model, scope=None, *, include_local_documents=False):
    condition = ('d.document_id=%s' if scope else 'TRUE' if include_local_documents else
                 "NOT d.test_only AND NOT p.test_only AND left(coalesce(p.external_service_id,''),5)<>'TEST_'")
    params = (scope,) if scope else ()
    with cur.connection.cursor(cursor_factory=RealDictCursor) as rows_cur:
        rows_cur.execute("SELECT d.document_id,d.document_name,d.source_url,d.source_organization,d.source_updated_at,d.basis_year,d.test_only,"
                         "d.valid_from,d.valid_until,d.region_scope,d.file_sha256,d.file_format,"
                         "d.markdown,d.analysis_json,d.reviewed_by,d.reviewed_at,d.local_ingestion,d.updated_at,"
                         "coalesce(p.external_service_id,'PROGRAM_'||p.program_id::text) AS service_id,"
                         'p.program_name AS service_name,p.test_only AS program_test_only,j.job_id,j.embedding_model,j.embedding_digest,j.chunk_config '
                         'FROM public.rag_documents d JOIN public.welfare_programs p USING(program_id) '
                         'JOIN public.rag_document_jobs j ON j.job_id=d.active_job_id AND j.document_id=d.document_id '
                         "WHERE j.state='succeeded' AND " + condition + ' ORDER BY d.document_id LIMIT 50001', params)
        documents = rows_cur.fetchall()
        if len(documents) > 50000:
            raise DocumentError('document_catalog_size_limit')
        if not documents:
            return [], {}, {}, []
        rows_cur.execute('SELECT v.*,v.embedding::text AS vector_text FROM public.welfare_document_vectors v '
                         'JOIN public.rag_documents d ON d.document_id=v.document_id AND d.active_job_id=v.job_id '
                         'JOIN public.rag_document_jobs j ON j.job_id=v.job_id AND j.document_id=v.document_id '
                         "WHERE v.job_id=ANY(%s::uuid[]) AND j.state='succeeded' AND v.embedding_model=%s "
                         'ORDER BY v.document_id,v.chunk_index LIMIT 50001', ([str(d['job_id']) for d in documents],model))
        rows = rows_cur.fetchall()
    if len(rows)>50000:
        raise DocumentError('document_catalog_size_limit')
    grouped={}
    for row in rows:
        grouped.setdefault(str(row['document_id']),[]).append(row)
    chunks, vectors, unavailable = [], {}, {}
    for doc in documents:
        if doc['embedding_model'] != model:
            unavailable[doc['service_id']]='embedding_model_mismatch'
            continue
        job={k:doc[k] for k in ('job_id','embedding_model','embedding_digest','chunk_config')}
        try:
            children, embeddings = validate_document_vectors(doc,job,grouped.get(str(doc['document_id']),[]))
        except (DocumentError,ValueError,KeyError,TypeError,IndexError):
            unavailable[doc['service_id']]='invalid_document_provenance'
            continue
        chunks.extend(children)
        vectors.update(embeddings)
    # 한 제도의 현재 문서 중 손상된 근거가 있으면 나머지만으로 완전한 조건이라고 답하지 않는다.
    rejected={c.chunk_id for c in chunks if c.service_id in unavailable}
    identities = [(str(d['document_id']),str(d['job_id']),str(d['updated_at'])) for d in documents]
    return ([c for c in chunks if c.chunk_id not in rejected],
            {k:v for k,v in vectors.items() if k not in rejected}, unavailable, identities)
