import unittest
import subprocess
from unittest.mock import Mock, patch, call
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


@pytest.mark.parametrize('already_analyzed,digest_changed', [(False, False), (True, False), (True, True)])
def test_worker_runs_analysis_to_embedding_without_review(monkeypatch, tmp_path, already_analyzed, digest_changed):
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
                               embed_cpu_only=True,
                               rerank_model='tokenizer', rerank_revision='revision', rerank_cache_dir='unused',
                               documents_max_file_mb=20, documents_max_characters=500000, documents_max_chunks=2000)
    monkeypatch.setattr(worker, 'get_document_store', lambda: store)
    monkeypatch.setattr(worker, 'get_settings', lambda: settings)
    def analyze(*_):
        assert not already_analyzed
        calls.append('analysis')
        return analysis
    monkeypatch.setattr(worker, 'analyze_file', analyze)
    clients = []
    def client(*_args, **kwargs):
        clients.append(kwargs)
        return SimpleNamespace(model_digest=Mock(side_effect=['digest', 'changed' if digest_changed else 'digest']),
                               embed=lambda texts: [[0.0] * 1024 for _ in texts])
    monkeypatch.setattr(ollama, 'OllamaClient', client)
    monkeypatch.setattr(reranker, 'LocalReranker', lambda *_: SimpleNamespace(count_tokens=len))
    if digest_changed:
        with pytest.raises(DocumentError, match='embedding_digest_changed'):
            worker.process_job(str(uuid4()), 'lease', tmp_path)
    else:
        worker.process_job(str(uuid4()), 'lease', tmp_path)
    assert clients[0]['embed_cpu_only'] is True
    assert calls == ([] if already_analyzed else ['analysis', 'analysis_saved']) + ['embedding', 'vectors'] + ([] if digest_changed else ['published'])
    assert job['reviewed_by'] is None and job['reviewed_at'] is None


def test_embedding_batches_reuse_hashes_and_keep_save_progress_order():
    texts = ['cached', 'first', 'first'] + [f'unique-{index}' for index in range(13)]
    texts += ['first', 'second', 'second'] + ['cached'] * 13 + ['second', 'first']
    records = [{'chunk': SimpleNamespace(chunk_id=f'chunk-{index}', embedding_text=lambda text=text: text)}
               for index, text in enumerate(texts)]
    vectors = {text: [float(index)] * 1024 for index, text in enumerate(dict.fromkeys(texts))}
    events = []
    store = SimpleNamespace(
        reused_vectors=Mock(return_value={stable_hash(b'cached'): vectors['cached']}),
        save_vectors=Mock(side_effect=lambda *args: events.append(('save', args))),
    )
    llm = SimpleNamespace(embed=Mock(side_effect=lambda missing: [vectors[text] for text in missing]))
    stage = lambda name, **values: events.append((name, values))

    worker.embed_and_save_batches(records, store=store, llm=llm, model='embed', digest='digest',
                                 job_id='job', token='lease', document_id='document', stage=stage)

    store.reused_vectors.assert_called_once()
    model, digest, hashes = store.reused_vectors.call_args.args
    assert (model, digest) == ('embed', 'digest')
    assert set(hashes) == {stable_hash(text.encode()) for text in texts}
    assert llm.embed.call_args_list == [call(['first'] + [f'unique-{index}' for index in range(13)]), call(['second'])]
    saves = store.save_vectors.call_args_list
    assert [len(saved.args[3]) for saved in saves] == [16, 16, 2]
    for saved in saves:
        job_id, token, document_id, batch, saved_vectors, model, digest = saved.args
        assert (job_id, token, document_id, model, digest) == ('job', 'lease', 'document', 'embed', 'digest')
        assert saved_vectors == {record['chunk'].chunk_id: vectors[record['chunk'].embedding_text()] for record in batch}
    assert [event[0] for event in events] == ['embedding', 'save', 'embedding', 'save', 'embedding', 'save', 'embedding']
    assert [values for name, values in events if name == 'embedding'] == [
        {'chunks': 34, 'embedded': 0}, {'chunks': 34, 'embedded': 14, 'stored': 16},
        {'chunks': 34, 'embedded': 15, 'stored': 32}, {'chunks': 34, 'embedded': 15, 'stored': 34},
    ]


@pytest.mark.parametrize('vectors', [[], [[0.0] * 1024, [1.0] * 1024]])
def test_embedding_cardinality_mismatch_never_saves_a_batch(vectors):
    records = [{'chunk': SimpleNamespace(chunk_id='chunk', embedding_text=lambda: 'input')}]
    store = SimpleNamespace(reused_vectors=Mock(return_value={}), save_vectors=Mock())
    llm = SimpleNamespace(embed=Mock(return_value=vectors))
    stage = Mock()
    with pytest.raises(ValueError):
        worker.embed_and_save_batches(records, store=store, llm=llm, model='embed', digest='digest',
                                     job_id='job', token='lease', document_id='document', stage=stage)
    store.save_vectors.assert_not_called()
    stage.assert_called_once_with('embedding', chunks=1, embedded=0)


class StopChildTests(unittest.TestCase):
    def setUp(self):
        self.os = SimpleNamespace(name='posix', killpg=Mock())
        self.signal = SimpleNamespace(SIGTERM=15, SIGKILL=9)
        self.child = Mock(pid='synthetic-process')
        self.child.poll.return_value = None

    def stop(self):
        with patch.object(worker, 'os', self.os), patch.object(worker, 'signal', self.signal):
            worker.stop_child(self.child)

    def test_already_finished_needs_no_signal_or_wait(self):
        self.child.poll.return_value = 0
        self.stop()
        self.os.killpg.assert_not_called()
        self.child.wait.assert_not_called()

    def test_exit_before_term_still_waits(self):
        self.os.killpg.side_effect = ProcessLookupError('synthetic exit')
        self.stop()
        self.child.wait.assert_called_once_with(timeout=10)

    def test_exit_before_kill_still_reaps(self):
        self.os.killpg.side_effect = [None, ProcessLookupError('synthetic exit')]
        self.child.wait.side_effect = [subprocess.TimeoutExpired('synthetic', 10), 0]
        self.stop()
        self.assertEqual(self.child.wait.call_args_list, [call(timeout=10), call()])

    def test_term_waits_for_exit(self):
        self.stop()
        self.os.killpg.assert_called_once_with(self.child.pid, 15)
        self.child.wait.assert_called_once_with(timeout=10)

    def test_timeout_kills_and_reaps(self):
        self.child.wait.side_effect = [subprocess.TimeoutExpired('synthetic', 10), 0]
        self.stop()
        self.assertEqual(self.os.killpg.call_args_list, [call(self.child.pid, 15), call(self.child.pid, 9)])
        self.assertEqual(self.child.wait.call_args_list, [call(timeout=10), call()])

    def test_unrelated_signal_errors_propagate(self):
        for after_timeout in (False, True):
            with self.subTest(after_timeout=after_timeout):
                self.os.killpg.side_effect = [None, PermissionError('synthetic')] if after_timeout else PermissionError('synthetic')
                self.child.wait.side_effect = [subprocess.TimeoutExpired('synthetic', 10)] if after_timeout else None
                with self.assertRaises(PermissionError):
                    self.stop()
