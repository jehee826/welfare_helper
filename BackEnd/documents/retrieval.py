from BackEnd.documents.contracts import DocumentError, stable_hash
from BackEnd.rag.evidence import read_chunk, validate_version


def active_document_chunks(cur, model, scope=None):
    condition = "d.id=%s" if scope else "d.active AND NOT d.test_only AND left(d.service_id,5)<>'TEST_'"
    params = (model, scope) if scope else (model,)
    cur.execute("SELECT c.chunk_id,c.service_id,c.content,d.id,d.name,d.source_url,j.payload,j.result,d.test_only,d.basis_year "
                "FROM rag_document_chunks c JOIN rag_documents d ON d.id=c.document_id "
                "JOIN rag_document_jobs j ON j.id=d.active_job_id AND j.id=c.job_id "
                "JOIN rag_document_jobs a ON a.id=(j.payload->>'analysis_job_id')::uuid "
                "WHERE j.state='succeeded' AND a.state='succeeded' AND c.index_key=j.result->>'index_key' "
                "AND a.result->>'analysis_hash'=j.payload->>'analysis_hash' AND c.embed_model=%s AND "
                + condition + " ORDER BY c.chunk_id LIMIT 50001", params)
    rows = cur.fetchall()
    if len(rows) > 50000:
        raise DocumentError("document_catalog_size_limit")
    groups, links = {}, {}
    for cid, sid, content, did, name, url, payload, result, test_only, basis_year in rows:
        chunk = read_chunk(cid, sid, content, url)
        if (chunk.source_kind != "reviewed_document" or chunk.document_id != str(did)
                or chunk.document_name != name or chunk.source_url != url
                or chunk.review_hash != stable_hash(payload) or chunk.reviewed_by != payload["reviewed_by"]
                or chunk.reviewed_at != payload["reviewed_at"] or chunk.test_only != test_only
                or chunk.basis_year != basis_year or chunk.analysis_hash != payload["analysis_hash"]):
            raise DocumentError("document_provenance_mismatch")
        groups.setdefault(str(did), []).append(chunk)
        links[sid] = payload["api_policy"]
    for group in groups.values():
        validate_version(group)
    return [chunk for group in groups.values() for chunk in group], links
