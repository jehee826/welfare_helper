"""검토한 Docling Markdown 범위와 실제 임베딩 입력을 함께 만든다."""

from dataclasses import replace

from BackEnd.documents.contracts import DocumentError, automatic_source_fingerprint, stable_hash, validate_review
from BackEnd.rag.chunking import CLEAN_VERSION, split_ranges, split_sections
from BackEnd.rag.evidence import EvidenceChunk, fingerprint, validate_version


def document_children(doc, review, analysis, service_name, digest, count, tokenizer_revision):
    if review.get('processing_mode') == 'automatic':
        return automatic_document_children(doc, review, analysis, service_name, digest, count, tokenizer_revision)
    validate_review(analysis, review['review'])
    by_id = {b['id']: b for b in analysis['blocks']}
    markdown = analysis['markdown']
    sections, positions = [], {}
    review_hash = stable_hash(review)
    for section, ids in review['review']['sections'].items():
        values, ranges, cursor = [], [], 0
        for bid in ids:
            block = by_id[bid]
            start, end = block.get('char_start'), block.get('char_end')
            if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(markdown):
                raise DocumentError('markdown_block_range_missing')
            text = markdown[start:end]
            if not text.strip():
                raise DocumentError('empty_block_cannot_be_indexed')
            values.append(text)
            ranges.append((cursor, cursor + len(text), bid, block['pages'], start))
            cursor += len(text) + 1
        positions[section] = ranges
        sections.append(EvidenceChunk('pending', doc['service_id'], section, '\n'.join(values), doc['source_url'],
            source_updated_at=str(doc.get('source_updated_at') or ''),
            basis_year=str(doc.get('basis_year') or ''), collected_at=review['reviewed_at'], source_kind='reviewed_document',
            document_id=str(doc['document_id']), document_name=doc['document_name'], analysis_hash=review['analysis_hash'],
            review_hash=review_hash, reviewed_by=review['reviewed_by'], reviewed_at=review['reviewed_at'],
            source_blocks=tuple(ids), page_refs=tuple(sorted({p for bid in ids for p in by_id[bid]['pages']})),
            test_only=doc['test_only']))
    children = split_sections(sections, service_name, digest, count,
                              tokenizer_revision + ':' + doc['parser_version'] + ':' + review_hash)
    result, restored, previous, parents = [], [], {}, {c.parent_id:c.parent_text for c in children if c.ordinal == 0}
    for index, child in enumerate(children):
        touched = [r for r in positions[child.section] if r[0] < child.end and r[1] > child.start]
        if not touched:
            raise DocumentError('document_block_range_missing')
        references = positions[child.section] if child.ordinal == 0 else touched
        child = replace(child, source_blocks=tuple(r[2] for r in references),
                        page_refs=tuple(sorted({p for r in references for p in r[3]})))
        spans = []
        for start, end, bid, pages, source_start in touched:
            left, right = max(start, child.start), min(end, child.end)
            spans.append({'start':source_start+left-start, 'end':source_start+right-start,
                          'text_start':left-child.start, 'text_end':right-child.start, 'block_id':bid})
        before = previous.get(child.section)
        overlap = max(0, before.end-child.start) if before else 0
        overlap_text = parents[child.parent_id][child.start:child.start+overlap]
        pages = sorted({p for r in touched for p in r[3]})
        result.append({'chunk':child,'chunk_index':index,'char_start':min(r['start'] for r in spans),
                       'char_end':max(r['end'] for r in spans),'source_spans':spans,
                       'page_start':pages[0] if pages else None,'page_end':pages[-1] if pages else None,
                       'token_count':count(child.embedding_text()),'overlap_chars':overlap,
                       'overlap_tokens':count(overlap_text) if overlap_text else 0})
        previous[child.section] = child
        restored.append(child)
    validate_version(restored)
    return result


def automatic_document_children(doc, payload, analysis, service_name, digest, count, tokenizer_revision):
    """모든 텍스트 블록을 자동 분할하되 사람의 검토 기록을 만들지 않는다."""
    if analysis.get('blockers'):
        raise DocumentError('analysis_quality_blocked')
    if (not analysis or stable_hash(analysis) != payload.get('analysis_hash')
            or payload.get('source_fingerprint') != automatic_source_fingerprint(doc)
            or payload.get('source_file_sha256') != doc.get('file_sha256')
            or payload.get('service_name') != service_name):
        raise DocumentError('automatic_source_changed_create_new_job')
    if any(payload.get(key) for key in ('review', 'reviewed_by', 'reviewed_at')):
        raise DocumentError('automatic_review_metadata_forbidden')
    markdown = analysis['markdown']
    blocks = [b for b in analysis['blocks'] if b['text'].strip()]
    if not blocks or len({b['id'] for b in blocks}) != len(blocks):
        raise DocumentError('automatic_source_blocks_invalid')
    values, positions, sections, headings, cursor, section_start = [], [], [], {}, 0, 0
    heading_context = ''
    previous_end = 0
    for block in blocks:
        start, end = block.get('char_start'), block.get('char_end')
        if (type(start) is not int or type(end) is not int or not previous_end <= start < end <= len(markdown)
                or not markdown[start:end].strip()):
            raise DocumentError('markdown_block_range_missing')
        previous_end = end
        text = markdown[start:end]
        if block.get('label') in {'title', 'section_header'}:
            if cursor > section_start:
                sections.append((section_start, cursor - 1, heading_context))
            level = block.get('level', 1)
            level = min(6, max(1, level)) if type(level) is int else 1
            headings = {depth: value for depth, value in headings.items() if depth < level}
            headings[level] = text.strip()
            heading_context = '\n'.join(headings[depth] for depth in sorted(headings))
            section_start = cursor
        values.append(text)
        positions.append((cursor, cursor + len(text), block['id'], block['pages'], start))
        cursor += len(text) + 1
    source = '\n'.join(values)
    sections.append((section_start, len(source), heading_context))
    parents = []
    for start, end, heading in sections:
        if not source[start:end].strip():
            continue
        header = f'서비스명: {service_name}\n섹션: content\n' + (heading + '\n' if heading else '')
        for part in split_ranges(source[start:end], header, count, target=1200, max_chars=1600, max_tokens=700, overlap=False):
            parents.append((start + part.start, start + part.end, heading, part.complete))
    source_hash = fingerprint('\n'.join(source[start:end] for start, end, _, _ in parents))
    processing_hash = stable_hash(payload)
    split_version = 'auto-content-v1:' + tokenizer_revision + ':' + doc['parser_version'] + ':' + processing_hash
    version = fingerprint(source_hash + CLEAN_VERSION + split_version + service_name + digest + str(doc['document_id']))[:24]
    namespace = f"{doc['service_id']}:document:{doc['document_id']}:{version}:content"
    records = []
    for parent_index, (parent_start, parent_end, heading, parent_complete) in enumerate(parents):
        parent_text = source[parent_start:parent_end]
        parent_id = f'{namespace}:{parent_index}:0'
        parent_refs = [r for r in positions if r[0] < parent_end and r[1] > parent_start]
        header = f'서비스명: {service_name}\n섹션: content\n' + (heading + '\n' if heading else '')
        previous = None
        for ordinal, part in enumerate(split_ranges(parent_text, header, count)):
            left, right = parent_start + part.start, parent_start + part.end
            touched = [r for r in positions if r[0] < right and r[1] > left]
            refs = parent_refs if ordinal == 0 else touched
            spans = []
            for block_start, block_end, bid, _, source_start in touched:
                a, b = max(left, block_start), min(right, block_end)
                spans.append({'start': source_start + a - block_start, 'end': source_start + b - block_start,
                              'text_start': a - left, 'text_end': b - left, 'block_id': bid})
            if not spans:
                raise DocumentError('document_block_range_missing')
            pages = sorted({page for r in touched for page in r[3]})
            child = EvidenceChunk(
                chunk_id=f'{namespace}:{parent_index}:{ordinal}', service_id=doc['service_id'], section='content',
                text=parent_text[part.start:part.end], source_url=doc['source_url'],
                source_updated_at=str(doc.get('source_updated_at') or ''), basis_year=str(doc.get('basis_year') or ''),
                collected_at=payload['processed_at'], source_kind='automatic_document', service_name=service_name,
                version=version, source_hash=source_hash, clean_version=CLEAN_VERSION, split_version=split_version,
                embed_digest=digest, parent_id=parent_id, parent_text=parent_text if ordinal == 0 else '',
                parent_index=parent_index, ordinal=ordinal, start=part.start, end=part.end,
                complete=part.complete and parent_complete, required_parents=(parent_id,), heading_context=heading,
                document_id=str(doc['document_id']), document_name=doc['document_name'],
                analysis_hash=payload['analysis_hash'], processing_mode='automatic', processing_hash=processing_hash,
                source_blocks=tuple(r[2] for r in refs), page_refs=tuple(sorted({page for r in refs for page in r[3]})),
                test_only=doc['test_only'])
            overlap = max(0, previous.end - child.start) if previous else 0
            overlap_text = parent_text[child.start:child.start + overlap]
            records.append({'chunk': child, 'chunk_index': len(records),
                            'char_start': min(s['start'] for s in spans), 'char_end': max(s['end'] for s in spans),
                            'source_spans': spans, 'page_start': pages[0] if pages else None,
                            'page_end': pages[-1] if pages else None, 'token_count': count(child.embedding_text()),
                            'overlap_chars': overlap, 'overlap_tokens': count(overlap_text) if overlap_text else 0})
            previous = child
    validate_version([record['chunk'] for record in records])
    return records
