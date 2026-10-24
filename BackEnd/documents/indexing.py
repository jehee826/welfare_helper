from dataclasses import replace

from BackEnd.documents.contracts import DocumentError, stable_hash, validate_review
from BackEnd.rag.chunking import split_sections
from BackEnd.rag.evidence import EvidenceChunk, validate_version


def document_children(doc, review, analysis, service_name, digest, count, tokenizer_revision):
    validate_review(analysis, review["review"])
    by_id = {b["id"]: b for b in analysis["blocks"]}
    sections, positions = [], {}
    review_hash = stable_hash(review)
    for section, ids in review["review"]["sections"].items():
        values, ranges, cursor = [], [], 0
        for bid in ids:
            block = by_id[bid]
            page = ",".join(str(p) for p in block["pages"]) or "고정 쪽 없음"
            text = block["text"]
            if block["label"] in {"title", "section_header"}:
                text = f"[제목{min(6, max(1, block['level']))}] {text}"
            value = f"[블록 {bid}; 쪽 {page}]\n{text}"
            values.append(value)
            ranges.append((cursor, cursor + len(value), bid, block["pages"]))
            cursor += len(value) + 1
        positions[section] = ranges
        sections.append(EvidenceChunk("pending", doc["service_id"], section, "\n".join(values), doc["source_url"],
            source_updated_at=doc["source_updated_at"].isoformat() if doc.get("source_updated_at") else "",
            basis_year=doc["basis_year"], collected_at=review["reviewed_at"], source_kind="reviewed_document",
            document_id=str(doc["id"]), document_name=doc["name"], analysis_hash=review["analysis_hash"],
            review_hash=review_hash, reviewed_by=review["reviewed_by"], reviewed_at=review["reviewed_at"],
            source_blocks=tuple(ids), page_refs=tuple(sorted({p for bid in ids for p in by_id[bid]["pages"]})),
            test_only=doc["test_only"]))
    children = split_sections(sections, service_name, digest, count,
                              tokenizer_revision + ":" + doc["parser_version"] + ":" + review_hash)
    result = []
    for child in children:
        touched = [r for r in positions[child.section] if child.ordinal == 0 or r[0] < child.end and r[1] > child.start]
        if not touched:
            raise DocumentError("document_block_range_missing")
        result.append(replace(child, source_blocks=tuple(r[2] for r in touched),
                              page_refs=tuple(sorted({p for r in touched for p in r[3]}))))
    validate_version(result)
    return result
