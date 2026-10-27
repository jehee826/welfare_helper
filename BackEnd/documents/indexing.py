"""검토한 Docling Markdown 범위와 실제 임베딩 입력을 함께 만든다."""

from dataclasses import replace

from BackEnd.documents.contracts import DocumentError, stable_hash, validate_review
from BackEnd.rag.chunking import split_sections
from BackEnd.rag.evidence import EvidenceChunk, validate_version


def document_children(doc, review, analysis, service_name, digest, count, tokenizer_revision):
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
