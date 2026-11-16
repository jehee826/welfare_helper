import json
import io
import logging
import re
from dataclasses import replace

import pytest

from BackEnd.core.qa_diagnostics import CODES, current_diagnostic, diagnose_qa, logger
from BackEnd.core.execution import ExecutionCancelledError
from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.qa import answer_document
from BackEnd.tests.test_document_qa import components


@pytest.fixture
def stream():
    handler=next(h for h in logger.handlers if type(h) is logging.StreamHandler)
    capture=io.StringIO()
    old=handler.setStream(capture)
    try:
        yield capture
    finally:
        handler.setStream(old)


def records(stream):
    output=stream.getvalue()
    rows=[json.loads(line) for line in output.splitlines() if line.startswith('{')]
    return output,rows


def test_success_logs_six_stages_to_default_handler_and_clears_scope(stream):
    assert logger.level==20 and logger.propagate is False
    repo,service,calls=components()
    result,trace=answer_document(repo,service,'MAE 평균 오차는 얼마인가요?')
    output,rows=records(stream)
    assert result['kind']=='answer' and trace['reason']=='answer'
    assert calls['embeddings']==1 and len(calls['prompts'])==1
    assert len([r for r in rows if r['event'] in {'qa_start','qa_end','stage_start','stage_end'}])==14
    assert rows[0]['event']=='qa_start' and rows[-1]['event']=='qa_end'
    assert [r['stage'] for r in rows if r['event']=='stage_start']==['snapshot','context','retrieval','rerank','generation','validation']
    assert [r['stage'] for r in rows if r['event']=='stage_end']==['snapshot','context','retrieval','rerank','generation','validation']
    assert len({r['request_id'] for r in rows})==1 and re.fullmatch(r'[0-9a-f]{32}',rows[0]['request_id'])
    assert all(r['code'] in CODES and isinstance(r['elapsed_ms'],(int,float)) and r['elapsed_ms']>=0 for r in rows)
    assert all(set(r)<= {'request_id','event','elapsed_ms','request_elapsed_ms','code','stage',
        'answer_validation','done_reason','prompt_eval_count','eval_count','native_timing',
        'purpose','preparation','reason','early_stop'} for r in rows)
    assert next(r for r in rows if r['event']=='context_preparation')['preparation']=='skipped'
    assert 'MAE' not in output and current_diagnostic() is None


@pytest.mark.parametrize('token_count', [128, 129])
def test_reranker_query_budget_failure_records_only_token_counts(stream, monkeypatch, token_count):
    from unittest.mock import Mock
    from BackEnd.rag.reranker import LocalReranker, RerankerError
    repo, service, _ = components()
    reranker = LocalReranker('unused', 'revision', 'unused-cache')
    monkeypatch.setattr(reranker, 'count_tokens', lambda _text: token_count)
    files = Mock(side_effect=RerankerError('SYNTHETIC_PRIVATE_CACHE'))
    monkeypatch.setattr(reranker, 'model_files', files)
    service.reranker = reranker
    with pytest.raises(DocumentError, match='document_reranker_failed'):
        answer_document(repo, service, 'SYNTHETIC_PRIVATE_QUERY')
    output, rows = records(stream)
    budget = [row for row in rows if row['event'] == 'rerank_input_budget']
    assert len(budget) == int(token_count > 128)
    if budget:
        assert budget[0]['query_tokens'] == token_count and budget[0]['query_limit'] == 128
        assert set(budget[0]) == {'request_id', 'event', 'elapsed_ms', 'request_elapsed_ms', 'code', 'stage', 'query_tokens', 'query_limit'}
        files.assert_not_called()
    else:
        files.assert_called_once()
    assert 'SYNTHETIC_PRIVATE' not in output and current_diagnostic() is None


def test_failure_logs_only_safe_code_without_private_markers_and_clears_scope(stream):
    marker='SYNTHETIC_PRIVATE_MARKER'
    repo,service,calls=components()
    snapshot=repo.snapshot()
    snapshot.chunks[0]=replace(snapshot.chunks[0],text=marker,document_name=marker)
    def fail(*_args,**_kwargs):
        raise RuntimeError(marker+' https://private.invalid/token')
    service.llm.embed=fail
    with pytest.raises(DocumentError,match='document_embedding_failed'):
        answer_document(repo,service,marker,profile={'region':marker},history=[{'role':'user','content':marker}])
    output,rows=records(stream)
    assert rows[-1]['event']=='qa_end' and rows[-1]['code']=='document_embedding_failed'
    assert all(row['code'] in CODES for row in rows)
    assert marker not in output and 'private.invalid' not in output and 'RuntimeError' not in output
    assert len(calls['prompts'])==1 and current_diagnostic() is None


@pytest.mark.parametrize('validation', ['accepted','invalid_schema','empty_answer','invalid_answer'])
@pytest.mark.parametrize('done_reason',['stop','length'])
def test_end_logs_only_allowed_validation_and_generation_metadata(stream,validation,done_reason):
    result=({'kind':'fallback'}, {'reason':'invalid_evidence_answer','answer_validation':validation,
        'generation_metadata':{'done_reason':done_reason,'prompt_eval_count':0,'eval_count':27,'private':'SYNTHETIC_PRIVATE'}})
    assert diagnose_qa(lambda:result)() is result
    output,rows=records(stream)
    assert rows[-1]['answer_validation']==validation and rows[-1]['done_reason']==done_reason
    assert rows[-1]['prompt_eval_count']==0 and rows[-1]['eval_count']==27
    assert 'SYNTHETIC_PRIVATE' not in output and current_diagnostic() is None


@pytest.mark.parametrize('bad',[-1,True,1.5,'42','SYNTHETIC_PRIVATE',None])
def test_end_omits_invalid_metadata_and_never_logs_raw_trace(stream,bad):
    result=({'question':'SYNTHETIC_PRIVATE'}, {'reason':'answer','answer_validation':'SYNTHETIC_PRIVATE',
        'generation_metadata':{'done_reason':'SYNTHETIC_PRIVATE','prompt_eval_count':bad,'eval_count':bad},
        'question':'SYNTHETIC_PRIVATE'})
    assert diagnose_qa(lambda:result)() is result
    output,rows=records(stream)
    assert not ({'answer_validation','done_reason','prompt_eval_count','eval_count'} & rows[-1].keys())
    assert 'SYNTHETIC_PRIVATE' not in output and current_diagnostic() is None


def test_cancelled_scope_is_cleared_without_logging_exception_text(stream):
    @diagnose_qa
    def cancelled():
        raise ExecutionCancelledError('SYNTHETIC_PRIVATE')
    with pytest.raises(ExecutionCancelledError):cancelled()
    output,rows=records(stream)
    assert rows[-1]['code']=='cancelled' and 'SYNTHETIC_PRIVATE' not in output
    assert current_diagnostic() is None


def test_purpose_native_timings_and_first_content_are_per_call(stream, monkeypatch):
    import time
    import httpx
    from BackEnd.rag import ollama
    from BackEnd.core.qa_diagnostics import model_purpose
    lines = [{'message': {'content': '{"text":"SYNTHETIC_PRIVATE"}'}},
             {'message': {'content': ''}, 'done': True, 'done_reason': 'stop',
              'total_duration': 9_000_000, 'load_duration': 0,
              'prompt_eval_duration': 2_000_000, 'eval_duration': 6_000_000,
              'prompt_eval_count': 10, 'eval_count': 3}]
    original = httpx.AsyncClient
    def handler(request):
        return httpx.Response(200, content=''.join(json.dumps(x)+'\n' for x in lines).encode())
    monkeypatch.setattr(ollama.httpx, 'AsyncClient', lambda **kw: original(
        transport=httpx.MockTransport(handler), **kw))
    client = ollama.OllamaClient('http://private.invalid', 'embed', 'configured-model',
        llm_options={'num_ctx':8192,'num_predict':64}, request_deadline=time.monotonic()+10)
    client._effective_context = 8192
    @diagnose_qa
    def request():
        with model_purpose('context'):
            client.chat('SYNTHETIC_PRIVATE', 'SYNTHETIC_PRIVATE')
        client.chat('SYNTHETIC_PRIVATE', 'SYNTHETIC_PRIVATE')
        return {}, {'reason':'answer', 'generation_metadata':client.last_chat_diagnostics}
    request()
    output, rows = records(stream)
    ends = [r for r in rows if r['event']=='model_end']
    assert [(r['purpose'],r['call_index']) for r in ends] == [('context',1),('answer',2)]
    assert len([r for r in rows if r['event']=='first_model_content']) == 2
    assert all(r['total_ms']==9 and r['load_ms']==0 and r['eval_ms']==6 and r['native_timing']=='complete' for r in ends)
    assert len({r['request_id'] for r in rows}) == 1
    assert 'SYNTHETIC_PRIVATE' not in output and 'private.invalid' not in output


@pytest.mark.parametrize('error,code', [(None,'ok'), ('stop','early_stop'), ('timeout','timeout'), ('error','error')])
def test_missing_native_metadata_is_not_filled_with_zero(stream,error,code):
    from BackEnd.core.execution import GenerationStopped, ExecutionTimeoutError
    from BackEnd.core.qa_diagnostics import model_call
    @diagnose_qa
    def request():
        with model_call('configured-model'):
            if error=='stop': raise GenerationStopped()
            if error=='timeout': raise ExecutionTimeoutError('SYNTHETIC_PRIVATE')
            if error=='error': raise ValueError('SYNTHETIC_PRIVATE')
        return {}, {'reason':'answer'}
    if error:
        with pytest.raises(Exception):request()
    else:request()
    output, rows = records(stream)
    end = next(r for r in rows if r['event']=='model_end')
    assert end['code']==code and end['native_timing']=='missing'
    assert not {'total_ms','load_ms','prompt_eval_ms','eval_ms'} & end.keys()
    assert 'SYNTHETIC_PRIVATE' not in output
