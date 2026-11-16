import json
import io
import logging
import re
from dataclasses import replace

import pytest

from BackEnd.core.qa_diagnostics import CODES, COUNT_FIELDS, current_diagnostic, diagnose_qa, logger
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
        'purpose','preparation','reason','early_stop','step'} | COUNT_FIELDS for r in rows)
    steps = {r['step']:r for r in rows if r['event']=='step_end'}
    assert set(steps)=={'dense','bm25_index','bm25_search','rrf','prompt_prepare'}
    assert steps['rrf']['candidate_count'] <= service.top_n
    assert steps['prompt_prepare']['included_evidence_count'] <= steps['prompt_prepare']['evidence_count']
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


def test_rerank_lock_wait_and_processing_are_measured_separately_and_summed(stream,monkeypatch):
    from BackEnd.core import qa_diagnostics as diagnostic
    clock=[0.0]
    monkeypatch.setattr(diagnostic,'monotonic',lambda:clock[0])
    class Lock:
        def __enter__(self):clock[0]+=.002
        def __exit__(self,*args):pass
    @diagnose_qa
    def request():
        diagnostic.qa_stage('rerank')
        for site in ('count_tokens','score'):
            with diagnostic.timed_rerank_lock(Lock(),site,threads=4) as counts:
                clock[0]+=.003
                counts['pair_count']=2
                counts['SYNTHETIC_PRIVATE']='SYNTHETIC_PRIVATE'
        return {},{'reason':'answer'}
    request()
    output,rows=records(stream)
    locks=[r for r in rows if r['event']=='rerank_lock']
    assert [r['site'] for r in locks]==['count_tokens','score']
    assert all(r['wait_ms']==2 and r['process_ms']==3 and r['threads']==4 for r in locks)
    end=next(r for r in rows if r['event']=='stage_end')
    assert end['lock_wait_ms']==4 and end['lock_process_ms']==6
    assert 'SYNTHETIC_PRIVATE' not in output


def test_failed_step_and_lock_preserve_error_and_release(stream):
    from threading import Lock
    from BackEnd.core.qa_diagnostics import qa_step,timed_rerank_lock
    lock=Lock()
    @diagnose_qa
    def request():
        with qa_step('dense'):
            with timed_rerank_lock(lock,'score',threads=4):
                raise ExecutionCancelledError('SYNTHETIC_PRIVATE')
    with pytest.raises(ExecutionCancelledError):request()
    assert lock.acquire(blocking=False)
    lock.release()
    output,rows=records(stream)
    assert [r['code'] for r in rows if r['event'] in {'step_end','rerank_lock'}]==['cancelled','cancelled']
    assert 'SYNTHETIC_PRIVATE' not in output


def test_local_reranker_connects_both_lock_sites_to_one_stage(stream):
    from BackEnd.tests.test_reranker import _fake,_Session
    from BackEnd.core.qa_diagnostics import qa_stage
    @diagnose_qa
    def request():
        qa_stage('rerank')
        scores,_=_fake(4,_Session()).score_with_diagnostics('SYNTHETIC_PRIVATE',['자료 하나','자료 둘'])
        assert len(scores)==2
        return {},{'reason':'answer'}
    request()
    output,rows=records(stream)
    locks=[r for r in rows if r['event']=='rerank_lock']
    assert [r['site'] for r in locks]==['count_tokens','score']
    assert locks[1]['candidate_count']==2 and locks[1]['pair_count']==2
    end=next(r for r in rows if r['event']=='stage_end')
    assert abs(end['lock_wait_ms']-sum(r['wait_ms'] for r in locks))<=.02
    assert 'SYNTHETIC_PRIVATE' not in output


@pytest.mark.parametrize('native_complete',[False,True])
def test_context_early_stop_has_separate_answer_call_and_native_metadata(stream,monkeypatch,native_complete):
    import time,httpx
    from BackEnd.rag import ollama
    from BackEnd.documents.context import prepare_context
    from BackEnd.core.qa_diagnostics import context_preparation
    calls=[]
    native={'done':True,'total_duration':9_000_000,'load_duration':0,
            'prompt_eval_duration':2_000_000,'eval_duration':6_000_000}
    def handler(request):
        calls.append(1)
        lines=([{'message':{'content':'{"relation":"independent",'},**(native if native_complete else {})}] if len(calls)==1 else [
            {'message':{'content':'{"text":"SYNTHETIC_PRIVATE"}'}},
            {'message':{'content':''},'done':True,'done_reason':'stop','total_duration':9_000_000,
             'load_duration':0,'prompt_eval_duration':2_000_000,'eval_duration':6_000_000,'eval_count':3}])
        return httpx.Response(200,content=''.join(json.dumps(x)+'\n' for x in lines).encode())
    original=httpx.AsyncClient
    monkeypatch.setattr(ollama.httpx,'AsyncClient',lambda **kw:original(transport=httpx.MockTransport(handler),**kw))
    client=ollama.OllamaClient('http://private.invalid','embed','configured-model',
        llm_options={'num_ctx':16384,'num_predict':1024},request_deadline=time.monotonic()+10)
    client._effective_context=16384
    @diagnose_qa
    def request():
        _,_,_,trace=prepare_context(client,'SYNTHETIC_PRIVATE',None,
            [{'role':'user','content':'이전 합성 질문'}],None,16384,1024)
        context_preparation(trace)
        assert trace['preparation_stopped_early'] is True and client.last_chat_diagnostics=={}
        client.chat('규칙','SYNTHETIC_PRIVATE')
        return {},{'reason':'answer','generation_metadata':client.last_chat_diagnostics}
    request()
    output,rows=records(stream)
    ends=[r for r in rows if r['event']=='model_end']
    assert len(calls)==2
    assert [(r['purpose'],r['call_index'],r['code']) for r in ends]==[('context',1,'early_stop'),('answer',2,'ok')]
    assert ends[0]['native_timing']==('complete' if native_complete else 'missing')
    assert ('total_ms' in ends[0]) is native_complete
    assert ends[1]['native_timing']=='complete' and ends[1]['total_ms']==9
    assert next(r for r in rows if r['event']=='context_preparation')['early_stop'] is True
    assert 'SYNTHETIC_PRIVATE' not in output and 'private.invalid' not in output


@pytest.mark.parametrize('exception', ['http_timeout','budget_timeout','task_cancel'])
def test_model_transport_failures_have_specific_status_without_private_text(stream,exception):
    import asyncio,httpx
    from BackEnd.core.qa_diagnostics import model_call
    errors={'http_timeout':httpx.ReadTimeout,'budget_timeout':TimeoutError,'task_cancel':asyncio.CancelledError}
    @diagnose_qa
    def request():
        with model_call('configured-model'):
            raise errors[exception]('SYNTHETIC_PRIVATE')
    with pytest.raises(errors[exception]):request()
    output,rows=records(stream)
    end=next(r for r in rows if r['event']=='model_end')
    assert end['code']==('cancelled' if exception=='task_cancel' else 'timeout')
    assert end['native_timing']=='missing' and 'SYNTHETIC_PRIVATE' not in output
