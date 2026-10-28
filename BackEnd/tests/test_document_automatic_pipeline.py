from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from BackEnd.documents.contracts import DocumentError, PARSER_VERSION, automatic_source_fingerprint, stable_hash
from BackEnd.documents.indexing import document_children
from BackEnd.documents import worker


def source_fixture(long=False):
    parts = ['# 원문 안내', '신청 대상은 지역 주민입니다. 예외 조건은 반드시 확인합니다. ' * (80 if long else 1),
             '## 신청 절차', '| 항목 | 내용 |\n| --- | --- |\n| 접수 | 방문 접수 |']
    markdown = '\n'.join(parts)
    blocks, offset = [], 0
    for index, text in enumerate(parts):
        blocks.append({'id': f'b{index}', 'text': text, 'pages': [1 if index < 2 else 2],
                       'char_start': offset, 'char_end': offset + len(text),
                       'label': 'section_header' if index in (0, 2) else 'table' if index == 3 else 'text',
                       'level': 1 if index == 0 else 2})
        offset += len(text) + 1
    analysis = {'markdown': markdown, 'blocks': blocks, 'blockers': [], 'warnings': [], 'pages': [1, 2]}
    doc = {'document_id': str(uuid4()), 'service_id': 'PROGRAM_1', 'service_name': '제도',
           'document_name': '문서', 'source_url': '', 'source_organization': '', 'basis_year': None,
           'source_updated_at': None, 'test_only': False, 'parser_version': PARSER_VERSION,
           'file_sha256': stable_hash(markdown.encode()), 'file_format': 'md'}
    payload = {'processing_mode': 'automatic', 'analysis_hash': stable_hash(analysis),
               'source_fingerprint': automatic_source_fingerprint(doc), 'source_file_sha256': doc['file_sha256'],
               'service_name': doc['service_name'], 'processed_at': datetime.now(timezone.utc).isoformat()}
    return doc, analysis, payload


def test_automatic_chunks_keep_bounded_parents_and_exact_source_without_review():
    doc, analysis, payload = source_fixture(long=True)
    records = document_children(doc, payload, analysis, doc['service_name'], 'digest', len, 'tokenizer@revision')
    parents = [r['chunk'] for r in records if r['chunk'].parent_text]
    assert len(parents) > 2
    assert all(len(c.parent_text) <= 1600 for c in parents)
    assert set().union(*(set(r['chunk'].source_blocks) for r in records)) == {b['id'] for b in analysis['blocks']}
    for record in records:
        chunk = record['chunk']
        assert chunk.section == 'content'
        assert chunk.source_kind == 'automatic_document'
        assert chunk.processing_hash == stable_hash(payload)
        assert not (chunk.review_hash or chunk.reviewed_by or chunk.reviewed_at)
        assert chunk.required_parents == (chunk.parent_id,)
        assert record['token_count'] == len(chunk.embedding_text()) <= 400
        for span in record['source_spans']:
            assert chunk.text[span['text_start']:span['text_end']] == analysis['markdown'][span['start']:span['end']]


def test_quality_blockers_stop_before_chunking():
    doc, analysis, payload = source_fixture()
    analysis['blockers'] = ['empty_or_unparsed_pdf_pages']
    with pytest.raises(DocumentError, match='analysis_quality_blocked'):
        document_children(doc, payload, analysis, doc['service_name'], 'digest', lambda _: pytest.fail('tokenizer called'), 'revision')


def test_source_changes_and_fake_review_are_rejected():
    doc, analysis, payload = source_fixture()
    with pytest.raises(DocumentError, match='automatic_source_changed'):
        document_children({**doc, 'document_name': '변경'}, payload, analysis, doc['service_name'], 'digest', len, 'revision')
    with pytest.raises(DocumentError, match='automatic_review_metadata_forbidden'):
        document_children(doc, {**payload, 'reviewed_by': 'local'}, analysis, doc['service_name'], 'digest', len, 'revision')


def test_legacy_review_wait_is_not_automatically_processed(monkeypatch, tmp_path):
    store = SimpleNamespace(claimed_job=lambda *_: {'document': {}, 'state': 'awaiting_review', 'parse_config': {}})
    monkeypatch.setattr(worker, 'get_document_store', lambda: store)
    monkeypatch.setattr(worker, 'get_settings', lambda: SimpleNamespace())
    monkeypatch.setattr(worker, 'analyze_file', lambda *_: pytest.fail('legacy analysis called'))
    with pytest.raises(DocumentError, match='legacy_document_requires_manual_resume'):
        worker.process_job(str(uuid4()), 'lease', tmp_path)


@pytest.mark.parametrize('already_analyzed', [False, True])
def test_worker_runs_analysis_to_embedding_without_review(monkeypatch, tmp_path, already_analyzed):
    from BackEnd.rag import ollama, reranker

    doc, analysis, payload = source_fixture()
    config = {'processing_mode': 'automatic', 'payload': payload, 'embedding_model': 'embed', 'tokenizer_revision': 'tokenizer@revision'}
    job = {'document': doc, 'state': 'parsing', 'parser_version': PARSER_VERSION,
           'parse_config': {'processing_mode': 'automatic'}, 'candidate_original': analysis['markdown'].encode(),
           'candidate_analysis': analysis if already_analyzed else None,
           'candidate_markdown': analysis['markdown'] if already_analyzed else None,
           'chunk_config': config if already_analyzed else {}, 'reviewed_by': None, 'reviewed_at': None}
    calls = []

    def finish(*_):
        calls.append('analysis_saved')
        job.update(candidate_analysis=analysis, candidate_markdown=analysis['markdown'], chunk_config=config)

    store = SimpleNamespace(claimed_job=lambda *_: job, finish_analysis=finish,
                            begin_embedding=lambda *_: calls.append('embedding'), reused_vectors=lambda *_: {},
                            save_vectors=lambda *_: calls.append('vectors'), activate=lambda *_: calls.append('published'))
    settings = SimpleNamespace(ollama_embed='embed', ollama_llm='llm', ollama_base_url='http://unused', ollama_timeout=1,
                               rerank_model='tokenizer', rerank_revision='revision', rerank_cache_dir='unused',
                               documents_max_file_mb=20, documents_max_characters=500000, documents_max_chunks=2000)
    monkeypatch.setattr(worker, 'get_document_store', lambda: store)
    monkeypatch.setattr(worker, 'get_settings', lambda: settings)
    def analyze(*_):
        assert not already_analyzed
        calls.append('analysis')
        return analysis
    monkeypatch.setattr(worker, 'analyze_file', analyze)
    monkeypatch.setattr(ollama, 'OllamaClient', lambda *_a, **_k: SimpleNamespace(model_digest=lambda: 'digest', embed=lambda texts: [[0.0] * 1024 for _ in texts]))
    monkeypatch.setattr(reranker, 'LocalReranker', lambda *_: SimpleNamespace(count_tokens=len))
    worker.process_job(str(uuid4()), 'lease', tmp_path)
    assert calls == ([] if already_analyzed else ['analysis', 'analysis_saved']) + ['embedding', 'vectors', 'published']
    assert job['reviewed_by'] is None and job['reviewed_at'] is None
