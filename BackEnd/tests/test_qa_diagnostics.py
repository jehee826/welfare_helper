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
    assert len(rows)==14 and rows[0]['event']=='qa_start' and rows[-1]['event']=='qa_end'
    assert [r['stage'] for r in rows if r['event']=='stage_start']==['snapshot','context','retrieval','rerank','generation','validation']
    assert [r['stage'] for r in rows if r['event']=='stage_end']==['snapshot','context','retrieval','rerank','generation','validation']
    assert len({r['request_id'] for r in rows})==1 and re.fullmatch(r'[0-9a-f]{32}',rows[0]['request_id'])
    assert all(r['code'] in CODES and isinstance(r['elapsed_ms'],(int,float)) and r['elapsed_ms']>=0 for r in rows)
    assert all(set(r)<= {'request_id','event','elapsed_ms','code','stage'} | ({'answer_validation','done_reason','prompt_eval_count','eval_count'} if r['event']=='qa_end' else set()) for r in rows)
    assert 'MAE' not in output and current_diagnostic() is None


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
