"""합성 문서·요청별 LLM 대역으로 맥락 사용과 요약 범위를 검증한다."""

from dataclasses import replace
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from BackEnd.core.execution import ExecutionCancelledError, ExecutionTimeoutError
from BackEnd.documents.context import PREPARE_SYSTEM, ANSWER_SYSTEM, ConversationContext, answer_prompt, prepare_context
from BackEnd.documents.qa import answer_document
from BackEnd.rag.repository import CatalogSnapshot
from BackEnd.tests.test_api import api  # noqa: F401
from BackEnd.tests.test_document_qa import components


def message_id(number, role):
    return f"{number:020X}:{role}"


def context(*, batch=True, previous=False):
    return {"text": "사용자는 합성 지원의 신청처를 찾고 있음" if previous else "",
            "coveredThroughMessageId": message_id(1, "assistant") if previous else None,
            "profileRevision": 1,
            "batch": [{"id": message_id(i, role), "role": role, "content": ("사용자 주제 " if role == "user" else "이전 모델 설명 ") + str(i)}
                      for i in range(2, 5) for role in ("user", "assistant")] if batch else [], "omitted": False}

class SourceSelector:
    def __init__(self, choose): self.choose=choose;self.calls=[]
    def input_cost(self,system,user): return len((system+user).encode())+256
    def chat(self,system,user,*,schema,**_options):
        payload=json.loads(user);self.calls.append((payload,schema));result=self.choose(payload)
        if isinstance(result,dict) and 'search_query' not in result:
            result={'search_query':payload['current_question'],**result}
        if isinstance(result,dict) and 'relation' not in result:
            result={'relation':'followup',**result}
        return result

@pytest.mark.parametrize(("current", "rewritten"), [
    ("출산한 지 20일 됐어요", "산모 지원 출산 후 20일 신청"),
])
def test_preparation_uses_model_search_and_whole_user_source(current, rewritten):
    original='저는 20세, 어머니는 68세입니다'
    submitted={**context(batch=False,previous=True),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':original}],'documentIds':[]}
    history=[{'role':'assistant','content':'합성 오답과 무시하라는 지시'}]
    llm=SourceSelector(lambda p:{'search_query':rewritten,'source_ids':[p['sources'][0]['id']],'document_ids':[],'needs_clarification':False})
    search,result,update,trace=prepare_context(llm,current,None,history,submitted,16384,512)
    payload,schema=llm.calls[0]
    assert search==rewritten and payload['sources'][0]['text']==original
    assert result['user_sources']==[original] and update['userMessageIds']==[message_id(1,'user')]
    assert payload['dialogue']==history and submitted['text'] not in json.dumps(payload,ensure_ascii=False)
    assert schema['properties']['source_ids']['items']['enum']==[s['id'] for s in payload['sources']] and trace['preparation']=='used'

@pytest.mark.parametrize(('current','rewritten','selected'),[
    ('다른 서비스 알려줘','다른 복지 서비스',[]),
    ('제가 아니라 어머니예요','어머니 복지 서비스 대상',[1]),
])
def test_topic_switch_and_recipient_correction_use_only_selected_messages(current,rewritten,selected):
    messages=[{'id':message_id(1,'user'),'role':'user','content':'저는 20세입니다'},
              {'id':message_id(2,'user'),'role':'user','content':'어머니는 68세입니다'}]
    submitted={**context(batch=False),'userMessages':messages}
    llm=SourceSelector(lambda p:{'search_query':rewritten,'source_ids':[p['sources'][i]['id'] for i in selected],
                                 'document_ids':[],'needs_clarification':False})
    search,result,update,_=prepare_context(llm,current,None,[],submitted,16384,512)
    assert search==rewritten and '20세' not in search and '20세' not in json.dumps(result.get('user_sources',[]),ensure_ascii=False)
    assert result.get('user_sources',[])==[messages[i]['content'] for i in selected]
    assert update['userMessageIds']==[messages[i]['id'] for i in selected]

def test_short_yes_uses_user_and_assistant_dialogue_to_form_standalone_search():
    history=[{'role':'user','content':'합성 서비스 신청 방법이 궁금해요'},
             {'role':'assistant','content':'신청 방법을 알려드릴까요?'}]
    llm=SourceSelector(lambda p:{'search_query':'합성 서비스 신청 방법','source_ids':[p['sources'][0]['id']],
                                 'document_ids':[],'needs_clarification':False})
    search,result,_,_=prepare_context(llm,'네',None,history,None,16384,512)
    assert llm.calls[0][0]['dialogue']==history and search=='합성 서비스 신청 방법'
    assert result['user_sources']==[history[0]['content']]

@pytest.mark.parametrize('query',['방과후 수업비가 부담돼요','저소득층 여성 청소년'])
@pytest.mark.parametrize('capability',[False,True])
def test_independent_question_discards_old_prepared_context(query,capability):
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'출산한 지 20일'}],
               'documentIds':['old-doc'],'supportsTopicBoundary':capability}
    llm=SourceSelector(lambda p:{'relation':'independent','search_query':'옛 산모 지원 20일',
                                 'source_ids':[p['sources'][0]['id']],'document_ids':['old-doc'],'needs_clarification':False})
    search,result,update,_=prepare_context(llm,query,None,[],submitted,16384,512,documents=[{'id':'old-doc','name':'산모 지원'}])
    assert search==query and not result.get('user_sources')
    assert update.get('resetTopic',False) is capability
    assert not result.get('document_ids')

def test_unclear_relation_uses_current_question_without_reset():
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'이전 조건'}],
               'supportsTopicBoundary':True}
    llm=SourceSelector(lambda p:{'relation':'unclear','search_query':'이전 조건','source_ids':[p['sources'][0]['id']],
                                 'document_ids':[],'needs_clarification':False})
    search,result,update,_=prepare_context(llm,'이건요?',None,[],submitted,16384,512)
    assert search=='이건요?' and result['needs_clarification'] is True and not result.get('user_sources')
    assert not update.get('resetTopic',False)

def test_legacy_capability_and_preparation_failure_do_not_reset_topic():
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'기존 질문'}]}
    llm=SourceSelector(lambda p:(_ for _ in ()).throw(ValueError('합성 실패')))
    search,result,update,trace=prepare_context(llm,'새 질문',None,[],submitted,16384,512)
    assert search=='새 질문' and not result.get('user_sources') and not update.get('resetTopic',False)
    assert trace['preparation']=='failed'
    with pytest.raises(ValueError):ConversationContext.model_validate({**submitted,'supportsTopicBoundary':'true'})

def test_invalid_relation_falls_back_without_reset():
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'이전 질문'}],
               'supportsTopicBoundary':True}
    llm=SourceSelector(lambda p:{'relation':'forged','search_query':'이전 질문','source_ids':[],
                                 'document_ids':[],'needs_clarification':False})
    search,result,update,trace=prepare_context(llm,'학교 지원',None,[],submitted,16384,512)
    assert search=='학교 지원' and not result.get('user_sources') and not update.get('resetTopic',False)
    assert trace['preparation']=='failed'

def test_independent_question_uses_current_query_through_full_qa():
    repo,service,calls=components();original=service.llm.chat;prepare=[]
    def chat(system,user,**kwargs):
        if system==PREPARE_SYSTEM:
            p=json.loads(user);prepare.append(p)
            return {'relation':'independent','search_query':'산모 20일','source_ids':[p['sources'][0]['id']],
                    'document_ids':[],'needs_clarification':False}
        return original(system,user,**kwargs)
    service.llm.chat=chat;service.llm.embed=Mock(wraps=service.llm.embed)
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'출산한 지 20일'}],
               'supportsTopicBoundary':True}
    result,_=answer_document(repo,service,'방과후 수업비가 부담돼요',conversation_context=submitted)
    assert result['kind']=='answer' and len(prepare)==len(calls['prompts'])==1
    assert service.llm.embed.call_args.args[0]==['방과후 수업비가 부담돼요']
    assert '출산한 지 20일' not in json.dumps(final_context(calls),ensure_ascii=False)
    assert result['context_update']['resetTopic'] is True

@pytest.mark.parametrize('bad',[
    {'search_query':'질문','source_ids':['U999'],'document_ids':[],'needs_clarification':False},
    {'search_query':'질문','source_ids':['U1','U1'],'document_ids':[],'needs_clarification':False},
    {'search_query':'질문','source_ids':[],'document_ids':['forged'],'needs_clarification':False},
    {'search_query':' ','source_ids':[],'document_ids':[],'needs_clarification':False},
    {'search_query':'전화 010-1234-5678','source_ids':[],'document_ids':[],'needs_clarification':False},
    {'search_query':'질문','source_ids':[],'document_ids':[],'needs_clarification':1},
])
def test_invalid_preparation_falls_back_to_current_query_only(bad):
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'어머니는 68세'}]}
    search,result,_,trace=prepare_context(SourceSelector(lambda _:bad),'신청 방법은?',None,[],submitted,16384,512)
    assert search=='신청 방법은?' and not result.get('user_sources')
    assert trace['preparation']=='failed' and trace['context_omitted'] is True

def test_selected_user_messages_over_budget_drop_whole_old_message():
    messages=[{'id':message_id(1,'user'),'role':'user','content':'가'*400},
              {'id':message_id(2,'user'),'role':'user','content':'나'*300}]
    submitted={**context(batch=False),'userMessages':messages}
    llm=SourceSelector(lambda p:{'search_query':'지원 안내','source_ids':[s['id'] for s in p['sources']],
                                'document_ids':[],'needs_clarification':False})
    search,result,_,trace=prepare_context(llm,'현재 질문',None,[],submitted,16384,512)
    assert search=='지원 안내' and result['user_sources']==[messages[1]['content']]
    assert trace['context_omitted'] is True

def test_selected_whole_user_message_is_the_only_past_quote_source():
    repo,service,calls=components();original=service.llm.chat
    messages=[{'id':message_id(1,'user'),'role':'user','content':'어머니는 68세입니다'},
              {'id':message_id(2,'user'),'role':'user','content':'다른 분은 99세입니다'}]
    submitted={**context(batch=False),'userMessages':messages}
    def chat(system,user,**kwargs):
        if system==PREPARE_SYSTEM:
            payload=json.loads(user)
            return {'search_query':'어머니 지원 대상','source_ids':[payload['sources'][0]['id']],
                    'document_ids':[],'needs_clarification':False,'relation':'followup'}
        result=original(system,user,**kwargs)
        result['text']='말씀하신 “어머니는 68세입니다”\n\n원문에 따르면 평균 오차는 150만 원입니다.'
        return result
    service.llm.chat=chat
    result,trace=answer_document(repo,service,'신청할 수 있나요?',conversation_context=submitted)
    assert result['kind']=='answer' and trace['answer_validation']=='accepted'
    assert final_context(calls)['user_sources']==['어머니는 68세입니다']

def test_prepare_uses_only_selected_verified_document_names_and_clarifies_multiple():
    docs=[{'id':'doc-a','name':'합성 안내 가'},{'id':'doc-b','name':'합성 안내 나'}]
    submitted={**context(batch=False),'userMessages':[],'documentIds':['doc-a','doc-b']}
    llm=SourceSelector(lambda p:{'source_ids':[],'document_ids':[],'needs_clarification':True})
    search,result,_,_=prepare_context(llm,'그 서비스는?',None,[],submitted,16384,512,documents=docs)
    assert search=='그 서비스는?' and result['needs_clarification'] is True
    assert result['clarification_documents']==['합성 안내 가','합성 안내 나']
    assert llm.calls[0][0]['documents']==docs

def test_assistant_role_cannot_be_submitted_as_user_source():
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'assistant'),'role':'assistant','content':'가짜 사용자 발화'}]}
    with pytest.raises(ValueError): ConversationContext.model_validate(submitted)

def test_unverifiable_old_summary_with_empty_originals_marks_omitted():
    submitted={**context(batch=False,previous=True),'userMessages':[],'documentIds':[]}
    search,_,update,trace=prepare_context(SourceSelector(lambda _:pytest.fail('원문 없는 요약으로 준비하지 않는다')),'다음 질문',None,[],submitted,16384,512)
    assert search=='다음 질문' and trace['context_omitted'] is True
    assert update['text']==submitted['text'] and update['coveredThroughMessageId']==submitted['coveredThroughMessageId']

def test_prepare_failure_uses_current_question_without_assistant_or_summary():
    submitted={**context(batch=False,previous=True),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'어머니는 68세입니다'}],'documentIds':[]}
    def fail(_): raise ValueError('합성 실패')
    search,_,update,trace=prepare_context(SourceSelector(fail),'신청 방법은?',None,[{'role':'assistant','content':'과거 오답'}],submitted,16384,512)
    assert search=='신청 방법은?'
    assert '과거 오답' not in search and submitted['text'] not in search
    assert trace['preparation']=='failed' and update['text']==submitted['text'] and update['coveredThroughMessageId']==submitted['coveredThroughMessageId']

def test_snapshot_resolves_only_existing_document_ids_for_prepare():
    repo,service,calls=components();original=service.llm.chat;seen=[]
    def chat(system,user,**kwargs):
        if system==PREPARE_SYSTEM:
            payload=json.loads(user);seen.append(payload)
            return {'search_query':payload['current_question'],'source_ids':[],'document_ids':[item['id'] for item in payload['documents']],'needs_clarification':False,'relation':'followup'}
        return original(system,user,**kwargs)
    service.llm.chat=chat
    valid=repo.snapshot().chunks[0].document_id
    submitted={**context(batch=False),'userMessages':[],'documentIds':[valid,'forged-document']}
    result,trace=answer_document(repo,service,'그 서비스는?',conversation_context=submitted)
    assert result['kind']=='answer' and result['context_usage']['omitted'] is True
    assert seen[0]['documents']==[{'id':valid,'name':repo.snapshot().chunks[0].document_name}]
    assert 'forged-document' not in json.dumps(seen,ensure_ascii=False)

def test_no_evidence_contact_uses_only_validated_selected_document_id():
    repo,service,_=components();chunk=repo.snapshot().chunks[0]
    chunk=replace(chunk,heading_context='문의처',text='합성 기관 02-123-4567',source_url='https://www.example.go.kr/help')
    record=SimpleNamespace(service_id=chunk.service_id,name='합성 복지 서비스',contacts=[{'label':'합성 기관','phone':'02-123-4567'}])
    repo.document_scope=None;repo.snapshot=lambda:CatalogSnapshot([record],[chunk],'fixed')
    repo.dense_search=lambda *a,**k:[replace(chunk,score=.65)]
    def chat(system,user,**kwargs):
        if system==PREPARE_SYSTEM:
            payload=json.loads(user)
            return {'search_query':'지원 문의','source_ids':[],'document_ids':[payload['documents'][0]['id']],'needs_clarification':False,'relation':'followup'}
        return {'status':'no_evidence','text':'이 자료에서 확인되지 않습니다.'}
    service.llm.chat=chat
    submitted={**context(batch=False),'userMessages':[],'documentIds':[chunk.document_id]}
    result,_=answer_document(repo,service,'배송비가 있나요?',conversation_context=submitted)
    assert result['reason']=='no_evidence' and result['contacts'][0]['phone']=='02-123-4567'

def test_ambiguous_verified_snapshot_documents_ask_names_without_generation():
    repo,service,calls=components();first=repo.snapshot().chunks[0]
    second=replace(first,chunk_id='source:2',document_id='doc-b',document_name='합성 안내 나')
    repo.document_scope=None
    repo.snapshot=lambda:CatalogSnapshot([], [first,second], 'fixed')
    seen=[]
    def select(system,user,**kwargs):
        assert system==PREPARE_SYSTEM
        seen.append(json.loads(user))
        return {'search_query':'그 서비스는?','source_ids':[],'document_ids':[],'needs_clarification':True,'relation':'followup'}
    service.llm.chat=Mock(side_effect=select);service.llm.embed=Mock(wraps=service.llm.embed)
    submitted={**context(batch=False),'userMessages':[],'documentIds':[first.document_id,second.document_id,'forged']}
    result,trace=answer_document(repo,service,'그 서비스는?',conversation_context=submitted)
    assert result['kind']=='fallback' and result['reason']=='clarify'
    assert first.document_name in result['text'] and second.document_name in result['text'] and 'forged' not in result['text']
    assert len(seen)==1 and len(seen[0]['documents'])==2 and trace['context']['context_omitted'] is True
    service.llm.embed.assert_not_called();assert calls['prompts']==[]

@pytest.mark.parametrize('error',[ExecutionTimeoutError(),ExecutionCancelledError()])
def test_source_selection_propagates_deadline_and_cancel(error):
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'어머니는 68세'}]}
    def fail(_):raise error
    llm=SourceSelector(fail)
    with pytest.raises(type(error)):prepare_context(llm,'신청 방법은?',None,[],submitted,16384,512)
    assert len(llm.calls)==1


def service_with_prepare(preparation=None):
    repo, service, calls = components()
    original = service.llm.chat_text
    calls["prepare"] = []
    def generate(system, user):
        if system == PREPARE_SYSTEM:
            calls["prepare"].append(json.loads(user))
            if isinstance(preparation, Exception):
                raise preparation
            payload=json.loads(user)
            return preparation if preparation is not None else json.dumps({'search_query':payload['current_question'], 'source_ids':[item['id'] for item in payload['sources']][:8], 'document_ids':[], 'needs_clarification':False,'relation':'followup'},ensure_ascii=False)
        return original(system, user)
    service.llm.chat_text = generate
    service.llm.chat = Mock(side_effect=lambda system,user,**kwargs: json.loads(generate(system,user)))
    service.llm.embed = Mock(wraps=service.llm.embed)
    service.reranker.score = Mock(wraps=service.reranker.score)
    return repo, service, calls


def final_context(calls):
    user = calls["prompts"][-1][1]
    return json.loads(user.split("비근거 상담 맥락(JSON):\n")[1].split("\n\n문서 근거(JSON):")[0])


def test_general_query_does_not_use_saved_profile_without_prepare():
    repo, service, calls = service_with_prepare()
    result, trace = answer_document(repo, service, "현재 질문", profile={"age": 70, "income": "unknown", "region": None})
    assert result["kind"] == "answer" and calls["prepare"] == [] and len(calls["prompts"]) == 1
    query = service.llm.embed.call_args.args[0][0]
    assert "70" not in query and "unknown" not in query and "None" not in query
    assert service.reranker.score.call_args.args[0] == query
    assert 'profile' not in final_context(calls) and 'profile_description' not in final_context(calls)
    assert trace["context"]["profile_used"] is False and trace["context"]["preparation"] == "skipped"

def test_identical_question_and_history_ignore_all_legacy_profiles():
    observed=[]
    for profile in (None,{'age':20,'region':'부산광역시'}, {'age':70,'region':'서울특별시'}):
        repo,service,calls=service_with_prepare()
        _,trace=answer_document(repo,service,'내 조건에 맞나요?',profile=profile,
                                 history=[{'role':'user','content':'합성 서비스가 궁금해요'}])
        assert 'current_profile' not in calls['prepare'][0]
        assert 'profile' not in final_context(calls) and 'profile_description' not in final_context(calls)
        observed.append((service.llm.embed.call_args.args[0][0], trace['retrieval'], calls['prompts'][-1][1]))
    assert observed[0]==observed[1]==observed[2]

def test_general_followup_excludes_profile_from_prepare_search_and_final():
    repo, service, calls = service_with_prepare()
    answer_document(repo, service, '그 서비스의 지원내용은?', profile={'age':70, 'household':'single'},
                    history=[{'role':'user','content':'합성 서비스가 궁금해요'}])
    assert 'current_profile' not in calls['prepare'][0]
    assert '70' not in service.llm.embed.call_args.args[0][0]
    assert '1인 가구' not in service.llm.embed.call_args.args[0][0]
    assert 'profile' not in final_context(calls) and 'profile_description' not in final_context(calls)

@pytest.mark.parametrize('question', ['안내 정보를 알려줘','내 정보로 대상인지 알려줘'])
def test_personal_wording_does_not_enable_saved_profile(question):
    repo,service,calls=service_with_prepare()
    _,trace=answer_document(repo,service,question,profile={'age':70})
    assert trace['context']['profile_used'] is False
    assert 'profile' not in final_context(calls)


def test_followup_uses_identical_dense_keyword_rerank_query_and_separate_untrusted_context(monkeypatch):
    from BackEnd.documents import qa
    repo, service, calls = service_with_prepare()
    original = qa.BM25Index.search
    queries = []
    def search(index, query, *args):
        queries.append(query)
        return original(index, query, *args)
    monkeypatch.setattr(qa.BM25Index, "search", search)
    history = [{"role": "user", "content": "혼자 살며 합성 지원이 필요해요"}, {"role": "assistant", "content": "이전 설명은 공식 근거가 아님"}]
    result, trace = answer_document(repo, service, "내 조건에서 신청처는?", profile={"household": "single"}, history=history)
    assert len(calls["prepare"]) == len(calls["prompts"]) == 1
    query = service.llm.embed.call_args.args[0][0]
    assert queries == [query] and service.reranker.score.call_args.args[0] == query and query=='내 조건에서 신청처는?'
    assert all(source['text']!='이전 설명은 공식 근거가 아님' for source in calls['prepare'][0]['sources'])
    assert "history" not in final_context(calls) and "summary" not in final_context(calls)
    assert final_context(calls)["search_intent"] == query
    assert 'source_ids' in service.llm.chat.call_args_list[0].kwargs['schema']['properties']
    assert '이전 설명은 공식 근거가 아님' not in calls['prompts'][0][1]
    assert result["evidence"][0]["context"] == repo.snapshot().chunks[0].text
    assert trace["context"]["history_used"] is True
    assert "혼자 살며" not in json.dumps(trace, ensure_ascii=False)


def test_old_summary_boundary_is_preserved_with_one_source_selection_call():
    repo, service, calls = service_with_prepare()
    submitted = context(previous=True)
    history = [{"role": "user", "content": "최근 질문"}, {"role": "assistant", "content": "최근 설명"}]
    result, trace = answer_document(repo, service, "그 서비스는?", history=history, conversation_context=submitted)
    assert result['context_update']['text']==submitted['text'] and result['context_update']['coveredThroughMessageId']==submitted['coveredThroughMessageId']
    assert 'summary' not in calls['prepare'][0] and 'batch' not in calls['prepare'][0]
    assert "history" not in final_context(calls) and "summary" not in final_context(calls)
    assert len(calls["prepare"]) == len(calls["prompts"]) == 1
    assert 'source_ids' in service.llm.chat.call_args_list[0].kwargs['schema']['properties']
    assert "사용자 주제" not in json.dumps(trace, ensure_ascii=False)


@pytest.mark.parametrize("preparation", ["not JSON", '{"query":"의도","summary":"<b>잘못된 요약</b>"}', '{"query":"의도","summary":"010-1234-5678"}', '{"query":"의도","summary":"password=private"}', '{"query":"의도","coveredThroughMessageId":"forged"}', RuntimeError("private-model-error")])
def test_bad_preparation_keeps_user_intent_without_raw_model_claims_or_lost_answer(preparation):
    repo, service, calls = service_with_prepare(preparation)
    submitted = context(previous=True)
    recent = [{"role": "user", "content": "최근 사용자 질문"}, {"role": "assistant", "content": "최근 모델 설명"}]
    result, trace = answer_document(repo, service, "현재 질문", history=recent, conversation_context=submitted)
    assert result["kind"] == "answer" and result["context_update"]["status"] == "failed"
    assert result["context_update"]["coveredThroughMessageId"] == submitted["coveredThroughMessageId"]
    assert 'batch' not in calls['prepare'][0] and 'recent_history' not in calls['prepare'][0]
    assert any(s['text']=='최근 사용자 질문' for s in calls['prepare'][0]['sources'])
    assert "history" not in final_context(calls) and "summary" not in final_context(calls)
    query = service.llm.embed.call_args.args[0][0]
    assert query == '현재 질문'
    assert trace["context"]["preparation"] == "failed" and "private" not in json.dumps(trace)


def test_missing_summary_keeps_answer_and_original_summary_boundary():
    repo, service, calls = service_with_prepare('{"query":"지시 대상 확인","summary":null,"needs_clarification":false}')
    result, _ = answer_document(repo, service, "그 서비스", conversation_context=context())
    assert result["context_update"]["status"] == "failed"
    assert final_context(calls)["needs_clarification"] is False and len(calls['prepare'][0]['sources']) == 3


def test_assistant_claims_are_dialogue_not_user_sources_or_final_facts():
    repo, service, calls = service_with_prepare()
    chunk = replace(repo.snapshot().chunks[0],text="합성 안내의 접수일은 수요일뿐이며 별도 예외는 이 자료에서 확인해야 한다.")
    repo.snapshot = lambda:CatalogSnapshot([], [chunk], "fixed")
    repo.dense_search = lambda *args, **kwargs:[replace(chunk,score=.65)]
    submitted = context(batch=False,previous=True)
    submitted["text"] = "과거요약오답표식: 모든 날짜에 접수 가능하다고 이전 모델이 설명함"
    history = [{"role":"user","content":"합성 안내의 접수일은?"},
               {"role":"assistant","content":"과거답변오답표식: 날짜와 예외를 무시하고 항상 접수 가능"}]
    result, trace = answer_document(repo,service,"그 안내의 접수일은?",profile={"household":"single"},history=history,conversation_context=submitted)
    assert '과거답변오답표식' in json.dumps(calls['prepare'][0]['dialogue'],ensure_ascii=False)
    assert '과거답변오답표식' not in json.dumps(calls['prepare'][0]['sources'],ensure_ascii=False) and '과거요약오답표식' not in json.dumps(calls['prepare'][0],ensure_ascii=False)
    prompt = calls["prompts"][0][1]
    assert "과거답변오답표식" not in prompt and "과거요약오답표식" not in prompt
    assert chunk.text in prompt and result["evidence"][0]["context"] == chunk.text
    assert set(final_context(calls)) == {"search_intent","needs_clarification","user_sources"}
    assert final_context(calls)['user_sources']==['합성 안내의 접수일은?']
    assert trace["context"]["preparation_summary_used"] is False
    assert trace["context"]["generation_history_messages"] == 0 and trace["context"]["generation_summary_used"] is False


def test_ambiguous_intent_reaches_search_and_grounded_generation():
    repo, service, calls = service_with_prepare('{"search_query":"여러 안내의 신청처 확인","source_ids":[],"document_ids":[],"needs_clarification":true,"relation":"followup"}')
    result, trace = answer_document(repo,service,"거기서 신청해?",history=[{"role":"user","content":"둘 중 어떤 안내인지 아직 정하지 못했어"}])
    assert result['kind'] == 'answer' and result['evidence']
    assert len(calls['prepare']) == len(calls['prompts']) == 1
    service.llm.embed.assert_called_once()
    service.reranker.score.assert_called_once()

@pytest.mark.parametrize('status',['clarify','no_evidence'])
def test_ambiguous_intent_preserves_final_model_withholding_after_search(status):
    repo, service, calls = service_with_prepare('{"search_query":"여러 안내의 신청처 확인","source_ids":[],"document_ids":[],"needs_clarification":true,"relation":"followup"}')
    previous=service.llm.chat.side_effect
    def structured(system,user,**kwargs):
        if system == PREPARE_SYSTEM:
            return previous(system,user,**kwargs)
        calls['prompts'].append((system,user))
        return {'status':status,'text':'대상과 거주지를 알려주세요.'}
    service.llm.chat.side_effect=structured
    result,trace=answer_document(repo,service,'거기서 신청해?',history=[{'role':'user','content':'둘 중 어느 안내인지 확인하고 싶어요'}])
    assert result['kind']=='fallback' and result['reason']==status and result['evidence']
    assert trace['reason']==status and len(calls['prepare'])==len(calls['prompts'])==1
    service.llm.embed.assert_called_once()
    service.reranker.score.assert_called_once()

def test_uncertain_prepare_preserves_current_named_service_in_search():
    repo,service,calls=service_with_prepare('{"search_query":"다른 서비스 신청처","source_ids":[],"document_ids":[],"needs_clarification":true,"relation":"followup"}')
    answer_document(repo,service,'한빛 지원의 신청처는?',history=[{'role':'user','content':'서비스 안내를 봤어요'}])
    query=service.llm.embed.call_args.args[0][0]
    assert '한빛 지원의 신청처는?' in query and '다른 서비스' not in query


@pytest.mark.parametrize("error", [ExecutionTimeoutError(), ExecutionCancelledError()])
def test_preparation_never_swallows_timeout_or_cancel(error):
    repo, service, calls = service_with_prepare(error)
    with pytest.raises(type(error)):
        answer_document(repo, service, "질문", conversation_context=context())
    service.llm.embed.assert_not_called()
    assert calls["prompts"] == []


def test_too_large_first_source_is_safe_budget_fallback_without_generation_or_partial_evidence():
    repo, service, calls = service_with_prepare()
    chunk = replace(repo.snapshot().chunks[0], text="큰 원문" * 10000)
    repo.snapshot = lambda: CatalogSnapshot([], [chunk], "fixed")
    repo.dense_search = lambda *args, **kwargs: [replace(chunk,score=.65)]
    service.llm.context_limit = lambda: 2500
    result, trace = answer_document(repo, service, "질문")
    assert result["kind"] == "fallback" and result["reason"] == "document_input_budget" and result["evidence"] == []
    assert result["context_usage"] == {"omitted":False}
    assert calls["prompts"] == calls["prepare"] == [] and trace["budget"]["estimated_input"] is None


def test_budget_removes_whole_old_pairs_and_omits_whole_extra_sources():
    repo, service, calls = service_with_prepare()
    first = repo.snapshot().chunks[0]
    second = replace(first, chunk_id="source:2", text="추가 원문" * 10000)
    repo.snapshot = lambda: CatalogSnapshot([], [first, second], "fixed")
    repo.dense_search = lambda *args, **kwargs: [replace(first,score=.65), replace(second,score=.65)]
    service.core_k = 2
    service.llm.context_limit = lambda: 10000
    history = [{"role": role, "content": ("이전 사용자" if role == "user" else "이전 모델") * 150} for role in ("user", "assistant")]
    result, trace = answer_document(repo, service, "질문", history=history)
    assert result["kind"] == "answer" and len(result["evidence"]) == 1 and result["evidence"][0]["context"] == first.text
    assert "history" not in final_context(calls)
    assert trace["budget"]["estimated_input"] + trace["budget"]["reserved_output"] <= trace["budget"]["context_limit"]
    assert trace["budget"]["evidence_omitted"] == 1 and "추가 원문" not in calls["prompts"][-1][1]
    assert result["context_usage"] == {"omitted": True}


def test_old_summary_boundary_and_preparation_omission_are_independent():
    repo, service, calls = service_with_prepare()
    service.llm.context_limit = lambda: 8000
    submitted = context()
    history = [{"role":"user","content":"최근 사용자 대화 "*150}, {"role":"assistant","content":"최근 모델 설명 "*150}]
    result, trace = answer_document(repo, service, "그 서비스는?", history=history, conversation_context=submitted)
    assert submitted["omitted"] is False and result["kind"] == "answer"
    assert result['context_update']['status'] in ('unchanged','omitted','failed') and result['context_update']['coveredThroughMessageId'] == submitted['coveredThroughMessageId']
    assert result["context_usage"] == {"omitted":True} and "history" not in final_context(calls)
    assert trace["context"]["context_omitted"] is True and len(calls["prepare"]) == len(calls["prompts"]) == 1

def test_chat_and_diagnostics_directly_forward_identical_dto_options(monkeypatch):
    from contextlib import nullcontext
    from BackEnd import main
    submitted={**context(batch=False),'userMessages':[{'id':message_id(1,'user'),'role':'user','content':'합성 질문'}],
               'documentIds':['doc-a']}
    dto=main.ChatRequest.model_validate({'query':'후속 질문','history':[{'role':'assistant','content':'합성 안내'}],
                                         'conversation_context':submitted,'profile':{'age':70}})
    options=dto.qa_options()
    assert 'profile' not in options and options['conversation_context']==submitted
    assert main.ChatRequest.model_validate({'query':'질문'}).qa_options()=={}
    service=SimpleNamespace(repo=object());seen=[]
    monkeypatch.setattr(main,'get_settings',lambda:SimpleNamespace(ollama_timeout=900))
    monkeypatch.setattr(main,'inference_request',lambda *a,**k:nullcontext())
    monkeypatch.setattr(main,'document_chat_service',lambda *a:service)
    monkeypatch.setattr(main,'redact_document',lambda value:value)
    def fake(repo,actual,query,**kwargs):
        seen.append((repo,actual,query,kwargs));return {'kind':'answer','text':'합성'}, {'reason':'answer'}
    monkeypatch.setattr(main,'answer_document',fake)
    monkeypatch.setattr(main,'get_chat_service',lambda:pytest.fail('외부 서비스 호출 금지'))
    assert main.chat(dto,object(),service,None)=={'kind':'answer','text':'합성'}
    assert main.rag_diagnostics(dto,object(),service,None)['response']['kind']=='answer'
    assert len(seen)==2 and all(item==(service.repo,service,'후속 질문',options) for item in seen)


def test_chat_dto_forwards_optional_context_but_query_only_remains_compatible(api):
    submitted = context()
    body = {"query": "신청처", "profile": {"household": "single"}, "history": [{"role": "user", "content": "생활비"}], "conversation_context": submitted}
    assert api.client.post("/api/v1/chat", json=body).status_code == 200
    options = api.rag.call_args.kwargs
    assert options["history"] == body["history"] and options["conversation_context"] == submitted and 'profile' not in options
    api.rag.reset_mock()
    assert api.client.post("/api/v1/chat", json={"query": "질문"}).status_code == 200
    api.rag.assert_called_once_with(api.service.repo, api.service, "질문")


@pytest.mark.parametrize("change", [{"text":"010-1234-5678"}, {"text":"<b>요약</b>"}, {"text":"password=private"}, {"profileRevision":True}, {"extra":"secret"}, {"text":"가"*1201}, {"coveredThroughMessageId":message_id(1,"user")}, {"batch":[{"id":message_id(1,"user"),"role":"user","content":"불완전 쌍"}]}])
def test_bad_context_is_rejected_before_qa_and_without_echo(api, change):
    body = {**context(batch=False), **change}
    response = api.client.post("/api/v1/chat", json={"query":"질문","conversation_context":body})
    assert response.status_code == 422 and response.json()["detail"] in {"invalid_document_request","sensitive_input"}
    api.rag.assert_not_called()
    assert "private" not in response.text and "010-1234" not in response.text


class StreamingPreparer:
    def __init__(self, pieces):
        self.pieces, self.calls, self.sent = pieces, [], []

    def input_cost(self, system, user):
        return len((system + user).encode()) + 256

    def chat(self, system, user, *, schema, on_content=None, num_predict=None):
        self.calls.append({"payload": json.loads(user), "num_predict": num_predict})
        for piece in self.pieces:
            self.sent.append(piece)
            on_content(piece)
        return json.loads("".join(self.pieces))


def test_independent_relation_stops_preparation_early():
    history = [{"role": "user", "content": "기초연금 신청처"}, {"role": "assistant", "content": "주민센터입니다."}]
    llm = StreamingPreparer(['{"relation":', '"independent"', ',"search_query":"옛 주제 재작성"', ',"source_ids":[]',
                             ',"document_ids":[],"needs_clarification":false}'])
    search, result, _, trace = prepare_context(llm, "아동수당 금액", None, history, None, 16384, 512)
    assert llm.sent == ['{"relation":', '"independent"']
    assert search == "아동수당 금액" and result["search_intent"] == "아동수당 금액"
    assert trace["preparation"] == "used" and trace["topic_relation"] == "independent"
    assert trace["preparation_stopped_early"] is True and llm.calls[0]["num_predict"] == 512


def test_followup_preparation_reads_whole_answer_and_trims_long_assistant_turns():
    long_answer = "가" * 1000
    history = [{"role": "user", "content": "기초연금 신청처"}, {"role": "assistant", "content": long_answer}]
    answer = {"relation": "followup", "search_query": "기초연금 신청 서류", "source_ids": [], "document_ids": [],
              "needs_clarification": False}
    text = json.dumps(answer, ensure_ascii=False)
    llm = StreamingPreparer([text[:15], text[15:]])
    search, _, _, trace = prepare_context(llm, "서류는요?", None, history, None, 16384, 512)
    assert search == "기초연금 신청 서류" and "preparation_stopped_early" not in trace
    assistant = [m["content"] for m in llm.calls[0]["payload"]["dialogue"] if m["role"] == "assistant"]
    assert assistant == ["가" * 400 + "…"]
