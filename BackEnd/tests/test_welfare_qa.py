"""검사 대역으로 보류·메타데이터·버전 격리와 정확한 원문 인용을 검증한다."""

from dataclasses import replace
import json
from types import SimpleNamespace

import pytest

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.qa import answer_document
from BackEnd.documents.context import ANSWER_SYSTEM,answer_prompt,fit_answer
from BackEnd.documents.welfare import complete_sources, WelfareAnswer, validate_answer
from BackEnd.documents import contacts as contact_policy
from BackEnd.rag.repository import CatalogSnapshot
from BackEnd.tests.test_document_qa import components


def packet(**values):
    return json.dumps({'status':'answer','text':'연 168,000원 지원', **values}, ensure_ascii=False)


SOURCE = {'id':'a','text':'연 168,000원 지원. 단, 조건 확인 필요.', 'source_url':'https://example.invalid'}

def test_confirmed_official_contact_requires_included_matching_source_and_deduplicates():
    repo,_,_=components();original=repo.snapshot().chunks[0]
    chunk=replace(original,heading_context='문의처',text='합성 기관 02-123-4567',source_url='https://www.example.go.kr/help')
    record=SimpleNamespace(service_id=chunk.service_id,name='합성 복지 서비스',contacts=[{'label':'합성 기관','phone':'02-123-4567'}])
    snapshot=CatalogSnapshot([record],[chunk],'fixed');docs=[{'document_id':chunk.document_id}]
    found=contact_policy.fallback_contacts(snapshot,docs,query='합성 복지 서비스 문의')
    assert len(found)==1 and found[0]['kind']=='service' and found[0]['phone']=='02-123-4567'
    assert found[0]['source_url']==chunk.source_url and found[0]['checked_at']
    assert contact_policy.fallback_contacts(snapshot,[],query='합성 복지 서비스 문의')==[]
    assert contact_policy.fallback_contacts(snapshot,docs,query='다른 서비스')==[]

@pytest.mark.parametrize('heading,text', [
    ('문의처', '합성 기관 1355, 보건복지상담센터 129'),
    ('지원 안내', '지원 조건을 확인하세요.\n- 문의: 합성 기관 1355, 보건복지상담센터 129'),
])
def test_normal_answer_includes_selected_service_contact_without_name_in_question(heading,text):
    repo,service,calls=components();snapshot=repo.snapshot()
    chunk=replace(snapshot.chunks[0],heading_context=heading,text=text,source_url='https://www.example.go.kr/help')
    record=SimpleNamespace(service_id=chunk.service_id,name='합성 복지 서비스',contacts=[])
    repo.document_scope=None;repo.snapshot=lambda:replace(snapshot,services=[record],chunks=[chunk])
    repo.dense_search=lambda *_args,**_kwargs:[replace(chunk,score=.8)]
    result,_=answer_document(repo,service,'지원 내용을 알려주세요')
    assert result['kind']=='answer' and len(calls['prompts'])==1
    assert [contact['phone'] for contact in result['contacts']]==['1355']
    assert result['contacts'][0]['kind']=='service'
    assert result['contacts'][0]['source_url']==chunk.source_url


def test_general_contact_in_source_is_not_a_new_service_referral():
    repo,_,_=components();base=repo.snapshot().chunks[0]
    chunk=replace(base,heading_context='문의처',text='보건복지상담센터 129',source_url='https://www.example.go.kr/help')
    snapshot=CatalogSnapshot([], [chunk], 'fixed')
    assert contact_policy.fallback_contacts(snapshot,[{'document_id':chunk.document_id}],confirmed_document_ids=[chunk.document_id])==[]


@pytest.mark.parametrize('selected', ['first', 'both'])
def test_same_named_regional_services_require_one_selected_service(selected):
    repo,_,_=components();base=repo.snapshot().chunks[0]
    first=replace(base,service_id='REGION_A',heading_context='문의처',text='가 지역 부서 1355',source_url='https://a.example.go.kr/help')
    second=replace(first,chunk_id='source:2',service_id='REGION_B',document_id='other-document',text='나 지역 부서 1339',source_url='https://b.example.go.kr/help')
    records=[SimpleNamespace(service_id=chunk.service_id,name='같은 이름의 지원',contacts=[]) for chunk in (first,second)]
    snapshot=CatalogSnapshot(records,[first,second],'fixed')
    ids=[first.document_id] if selected=='first' else [first.document_id,second.document_id]
    found=contact_policy.fallback_contacts(snapshot,[{'document_id':identifier} for identifier in ids],confirmed_document_ids=ids)
    assert [item['phone'] for item in found]==(['1355'] if selected=='first' else [])


def test_csv_contacts_reuse_source_match_deduplication_and_three_contact_limit():
    from BackEnd.ingest.csv_loader import _row_to_record
    record=_row_to_record({'서비스아이디':'SAMPLE','서비스명':'합성 지원','서비스요약':'합성 안내',
        '서비스URL':'https://www.bokjiro.go.kr/detail?wlfareInfoId=SAMPLE','소관부처명':'합성 기관',
        '대표문의':'첫 부서1355보건복지상담센터129중복 부서1355둘째 부서1339셋째 부서1600-1004넷째 부서1899-9988'},2)
    repo,_,_=components();base=repo.snapshot().chunks[0]
    chunk=replace(base,service_id=record.service_id,heading_context='본문',
        text='1355, 129, 1339, 1600-1004, 1899-9988',source_url=record.url)
    def contacts(candidate):
        return contact_policy.fallback_contacts(CatalogSnapshot([record],[candidate],'fixed'),
            [{'document_id':candidate.document_id}],confirmed_document_ids=[candidate.document_id])
    assert [item['phone'] for item in contacts(chunk)]==['1355','1339','1600-1004']
    assert contacts(replace(chunk,text='지원 금액 135500원'))==[]


def test_missing_contacts_safe_fallback_and_technical_failures_stay_distinct():
    repo,service,calls=components();repo.dense_search=lambda *args,**kwargs:[replace(repo.snapshot().chunks[0],score=.1)]
    response,trace=answer_document(repo,service,'질문')
    assert trace['reason']=='low_similarity' and calls['prompts']==[]
    assert response['contacts']==[] and '연락처를 제공하지 못했습니다' in response['text']
    repo.dense_search=lambda *_args,**_kwargs: (_ for _ in ()).throw(RuntimeError('합성 오류'))
    with pytest.raises(DocumentError,match='document_embedding_failed'):answer_document(repo,service,'질문')

def test_unselected_old_document_never_selects_service_contact():
    repo,service,_=components();snapshot=repo.snapshot();base=snapshot.chunks[0]
    chunk=replace(base,heading_context='문의처',text='합성 기관 02-123-4567',source_url='https://www.example.go.kr/help')
    record=SimpleNamespace(service_id=chunk.service_id,name='옛 합성 서비스',contacts=[{'label':'합성 기관','phone':'02-123-4567'}])
    repo.document_scope=None;repo.snapshot=lambda:replace(snapshot,services=[record],chunks=[chunk])
    repo.dense_search=lambda *_args,**_kwargs:[replace(chunk,score=.8)]
    from BackEnd.documents.context import PREPARE_SYSTEM
    def chat(system,user,**kwargs):
        if system==PREPARE_SYSTEM:return {'source_ids':[],'document_ids':[],'needs_clarification':False}
        return {'status':'no_evidence','text':'확인할 근거가 없습니다.'}
    service.llm.chat=chat
    submitted={'text':'','coveredThroughMessageId':None,'profileRevision':0,'batch':[],'omitted':False,'userMessages':[],'documentIds':[chunk.document_id]}
    result,_=answer_document(repo,service,'새 서비스 해외배송은?',conversation_context=submitted)
    assert result['reason']=='no_evidence' and result['contacts']==[]

def test_malformed_service_contacts_metadata_does_not_break_fallback():
    repo,_,_=components();chunk=replace(repo.snapshot().chunks[0],heading_context='본문',text='연락처 정보 없음',source_url='https://www.example.go.kr/help')
    record=SimpleNamespace(service_id=chunk.service_id,name='합성 복지 서비스',contacts=None)
    snapshot=CatalogSnapshot([record],[chunk],'fixed')
    assert contact_policy.fallback_contacts(snapshot,[{'document_id':chunk.document_id}],query='합성 복지 서비스')==[]

@pytest.mark.parametrize(('label','phone','url'),[
    (' ','129','https://www.example.go.kr/help'),
    ('합성 기관',' ','https://www.example.go.kr/help'),
    ('<script>기관</script>','129','https://www.example.go.kr/help'),
    ('token=secret','129','https://www.example.go.kr/help'),
    ('합성 기관','129','https://www.example.go.kr/help?token=secret'),
    ('합성 기관','129','https://www.example.invalid/help'),
    ('합성 기관','010-1234-5678','https://www.example.go.kr/help'),
])
def test_invalid_service_contact_fields_are_dropped(label,phone,url):
    assert contact_policy._contact(label,phone,url,'service','2026-11-03') is None


@pytest.mark.parametrize('status',['answer','clarify','no_evidence','out_of_scope'])
def test_status_and_plain_text_contract_preserves_model_text(status):
    text='출산한 지 20일인 조건을 말씀하셨습니다.'
    answer=WelfareAnswer.model_validate({'status':status,'text':text})
    assert answer.status==status and answer.text==text

@pytest.mark.parametrize('value',[
    {'status':'answer','text':' '}, {'status':'invalid','text':'안내'},
    {'status':'answer','text':'안내','citations':[{'id':'forged','quote':'가짜'}]},
    {'status':'answer'}, {'status':'answer','text':'가'*3001},
])
def test_invalid_structured_answer_is_rejected(value):
    with pytest.raises(ValueError): validate_answer(value)

@pytest.mark.parametrize('status',['answer','clarify','no_evidence','out_of_scope'])
def test_normal_generation_preserves_text_and_returns_server_references(status):
    repo,service,_=components()
    text='출산한 지 20일입니다. 합성 안내입니다.'
    seen=[]
    def generate(system,user,**kwargs):
        seen.append(kwargs['schema']);return {'status':status,'text':text}
    service.llm.chat=generate
    result,trace=answer_document(repo,service,'질문')
    assert result['text']==text and len(seen)==1
    assert result['kind']==('answer' if status=='answer' else 'fallback')
    assert result['evidence'][0]['chunk_id']==repo.snapshot().chunks[0].chunk_id
    assert result['evidence'][0]['role']=='retrieved' and result['evidence'][0]['quote']==''
    assert trace['answer_validation']=='accepted'
    schema=seen[0]
    assert set(schema['required'])=={'status','text'} and schema['additionalProperties'] is False
    assert set(schema['properties'])=={'status','text'}

def test_extra_forged_citation_is_technical_failure_not_a_source():
    repo,service,_=components()
    service.llm.chat=lambda *a,**k:{'status':'answer','text':'합성 답변','citations':[{'id':'forged','quote':'가짜'}]}
    result,trace=answer_document(repo,service,'질문')
    assert result['kind']=='fallback' and result['evidence']==[]
    assert trace['answer_validation'] in ('invalid_schema','invalid_answer')

@pytest.mark.parametrize('status',['answer','no_evidence'])
def test_model_contact_text_does_not_become_structured_official_contact(status):
    repo,service,_=components()
    service.llm.chat=lambda *a,**k:{'status':status,'text':'문의 02-999-9999, https://invented.invalid'}
    result,_=answer_document(repo,service,'질문')
    assert result['text']=='문의 02-999-9999, https://invented.invalid'
    assert all(c['phone']!='02-999-9999' and c['source_url']!='https://invented.invalid' for c in result['contacts'])
    assert all(e['document_id']==repo.snapshot().chunks[0].document_id for e in result['evidence'])

@pytest.mark.parametrize('identity_change',[{'version':'v2'},{'service_id':'other-service'}])
def test_whole_document_expansion_preserves_exception_and_ignores_other_document(identity_change):
    repo, _, _ = components()
    first = replace(repo.snapshot().chunks[0],version='v1',text='지원 대상',parent_id='p1')
    exception = replace(first,chunk_id='source:2',ordinal=1,text='단, 재학 조건이 필요하다.')
    other = replace(first,chunk_id='foreign',document_id='other',text='다른 지역 서비스')
    snapshot = CatalogSnapshot([], [first, exception, other], 'fixed')
    assert complete_sources(snapshot,[first]) == [first, exception]
    with pytest.raises(DocumentError, match='version_mismatch'):
        complete_sources(CatalogSnapshot([], [first,replace(exception,**identity_change)], 'fixed'),[first])


def test_whole_document_over_budget_does_not_drop_exception_to_generate():
    repo, service, calls = components()
    first = replace(repo.snapshot().chunks[0],version='v1',parent_id='p1')
    exception = replace(first,chunk_id='source:2',ordinal=1,text='필수 예외' * 10000)
    repo.snapshot = lambda:CatalogSnapshot([], [first,exception], 'fixed')
    repo.dense_search = lambda *a,**k:[replace(first,score=.65),replace(exception,score=.65)]
    service.llm.context_limit = lambda:6000
    result, _ = answer_document(repo,service,'지원 조건')
    assert result['reason'] == 'document_input_budget' and calls['prompts'] == []


def test_large_unrelated_parent_does_not_block_small_complete_related_scope():
    repo, service, calls = components()
    first = replace(repo.snapshot().chunks[0],version='v1',parent_id='p1',required_parents=('p1','p2'))
    condition = replace(first,chunk_id='condition',parent_id='p2',parent_index=1,text='단, 재학 중인 경우에 한함.')
    unrelated = replace(first,chunk_id='unrelated',parent_id='p3',parent_index=2,heading_context='부록 일반서식',text='무관한 부록' * 10000)
    repo.snapshot = lambda:CatalogSnapshot([], [first,condition,unrelated], 'fixed')
    repo.dense_search = lambda *a,**k:[replace(first,score=.65),replace(condition,score=.65),replace(unrelated,score=.1)]
    service.dense_k = 1
    service.llm.context_limit = lambda:6000
    result, trace = answer_document(repo,service,'지원 조건')
    assert result['kind'] == 'answer'
    assert {c['chunk_id'] for c in result['evidence']} == {first.chunk_id,condition.chunk_id}
    assert trace['evidence_expansion']=={'core_chunks':1,'expanded_chunks':2,'added_chunks':1}
    assert '무관한 부록' not in calls['prompts'][0][1]


def test_source_metadata_enters_prompt_and_display_without_changing_original():
    repo, service, calls = components()
    snapshot = repo.snapshot()
    metadata = {'region_scope':'서울특별시', 'source_updated_at':'2026-07-04',
                'basis_year':'', 'valid_until':'', 'source_organization':'공식기관'}
    repo.snapshot = lambda:replace(snapshot,document_metadata={snapshot.chunks[0].document_id:metadata})
    response, _ = answer_document(repo, service, '지원 내용')
    assert response['evidence'][0]['region_scope'] == '서울특별시'
    assert response['evidence'][0]['source_updated_at'] == '2026-07-04'
    assert '2026-07-04' in calls['prompts'][0][1] and metadata['basis_year'] == ''


def test_repeated_source_metadata_is_compacted_without_losing_required_chunks():
    metadata={'document_id':'doc','version':'v1','name':'지원 안내','source_url':'https://example.invalid/official',
              'source_organization':'공식 발행 기관','region_scope':'서울특별시','source_updated_at':'2026-07-04'}
    documents=[{**metadata,'id':f'chunk:{i}','heading':f'조건·예외 {i}','text':f'필수 원문 {i}','pages':[1]} for i in range(9)]
    context={'profile':{},'profile_description':'','search_intent':'지원 조건','needs_clarification':False}
    prompt=answer_prompt('지원 조건',context,documents)
    sources=json.loads(prompt.split('문서 근거(JSON):\n')[1].split('\n\n질문:')[0])
    assert len(sources)==1 and sources[0]['source_updated_at']=='2026-07-04'
    assert sources[0]['chunks']==[{k:d[k] for k in ('id','heading','text','pages')} for d in documents]
    assert prompt.count(metadata['source_url'])==1
    compact_cost=len((ANSWER_SYSTEM+prompt).encode())
    old_cost=compact_cost-len(json.dumps(sources,ensure_ascii=False).encode())+len(json.dumps(documents,ensure_ascii=False).encode())
    assert old_cost>compact_cost
    llm=SimpleNamespace(input_cost=lambda system,user:len((system+user).encode()))
    fitted,included,_,_=fit_answer(llm,'지원 조건',context,documents,(old_cost+compact_cost)//2+512,512)
    assert fitted and included==documents and documents[0]['text']=='필수 원문 0'


@pytest.mark.parametrize(('query','requested_heading'), [
    ('어떤 혜택과 지원 한도가 있나요?','급여서비스 내용'),
    ('온라인 접수에 필요한 서류와 절차는?','신청방법 내용'),
])
def test_requested_source_sections_and_full_conditions_survive_metadata_ranking(query,requested_heading):
    repo,_,_=components()
    anchor=replace(repo.snapshot().chunks[0],version='v1',parent_id='metadata',heading_context='조회수',text='123')
    details=[]
    for index,heading in enumerate([requested_heading,'선정기준 내용','예외','시군구명','시행종료일자'],1):
        details.append(replace(anchor,chunk_id=f'detail:{index}',parent_id=f'p{index}',parent_index=index,
                               heading_context=heading,text=f'{heading} 원문'))
    continuation=replace(details[0],chunk_id='detail:continuation',ordinal=1,text='해당 절의 나머지 원문')
    large=replace(anchor,chunk_id='unrelated',parent_id='appendix',heading_context='일반서식 부록',text='큰 부록'*10000)
    snapshot=CatalogSnapshot([], [anchor,*details,continuation,large], 'fixed')
    chosen=complete_sources(snapshot,[anchor],query)
    assert {c.chunk_id for c in chosen}=={anchor.chunk_id,*(c.chunk_id for c in details),continuation.chunk_id}
    assert all(c.document_id==anchor.document_id and c.version=='v1' for c in chosen)


def test_missing_required_parent_does_not_allow_partial_factual_context():
    repo,_,_=components()
    anchor=replace(repo.snapshot().chunks[0],version='v1',parent_id='p1',required_parents=('p1','missing'))
    with pytest.raises(DocumentError,match='document_evidence_incomplete'):
        complete_sources(CatalogSnapshot([], [anchor], 'fixed'),[anchor],'지원 내용')


@pytest.mark.parametrize('query',['합성 서비스','집에서 도움을 받을 수 있나요?',''])
def test_basic_sources_reach_prompt_for_short_indirect_or_empty_query(query):
    repo,service,calls=components()
    anchor=replace(repo.snapshot().chunks[0],version='v1',parent_id='base',heading_context='서비스 요약',text='합성 서비스 안내')
    benefit=replace(anchor,chunk_id='benefit',parent_id='benefit',parent_index=1,heading_context='급여서비스 내용',text='돌봄 이용권을 제공합니다.')
    continuation=replace(benefit,chunk_id='benefit:2',ordinal=1,text='지원 내용의 나머지 원문입니다.')
    application=replace(anchor,chunk_id='application',parent_id='application',parent_index=2,heading_context='신청방법 내용',text='주민센터에서 신청합니다.')
    exception=replace(anchor,chunk_id='exception',parent_id='exception',parent_index=3,heading_context='예외',text='단, 별도 조건을 확인합니다.')
    appendix=replace(anchor,chunk_id='appendix',parent_id='appendix',parent_index=4,heading_context='일반서식 부록',text='무관한 부록 원문')
    other=replace(benefit,chunk_id='other',document_id='other',text='다른 문서의 원문')
    snapshot=CatalogSnapshot([], [anchor,benefit,continuation,application,exception,appendix,other], 'fixed')
    selected=complete_sources(snapshot,[anchor,anchor],query)
    assert [c.chunk_id for c in selected]==['source:1','benefit','benefit:2','application','exception']
    repo.document_scope=None
    repo.snapshot=lambda:snapshot
    repo.dense_search=lambda *a,**k:[replace(c,score=.65 if c.chunk_id=='source:1' else .1) for c in snapshot.chunks]
    service.dense_k=1
    result,_=answer_document(repo,service,query)
    assert result['kind']=='answer'
    prompt=calls['prompts'][0][1]
    for chunk in (benefit,continuation,application,exception): assert chunk.text in prompt
    assert appendix.text not in prompt and other.text not in prompt


def test_incomplete_newly_required_source_is_rejected():
    repo,_,_=components()
    anchor=replace(repo.snapshot().chunks[0],version='v1',parent_id='base')
    incomplete=replace(anchor,chunk_id='incomplete',parent_id='benefit',heading_context='급여서비스 내용',complete=False)
    with pytest.raises(DocumentError,match='document_evidence_incomplete'):
        complete_sources(CatalogSnapshot([], [anchor,incomplete], 'fixed'),[anchor],'')


def test_expanded_extra_document_is_omitted_whole_when_over_budget():
    repo,service,calls=components()
    first=replace(repo.snapshot().chunks[0],version='v1',parent_id='first')
    second=replace(first,chunk_id='extra',document_id='second',parent_id='second',text='추가 원문'*10000)
    repo.document_scope=None
    repo.snapshot=lambda:CatalogSnapshot([], [first,second], 'fixed')
    repo.dense_search=lambda *a,**k:[replace(first,score=.8),replace(second,score=.7)]
    service.core_k=2
    service.llm.context_limit=lambda:10000
    result,trace=answer_document(repo,service,'질문')
    assert result['kind']=='answer' and len(result['evidence'])==1
    assert result['evidence'][0]['context']==first.text
    assert trace['budget']['evidence_omitted']==1 and '추가 원문' not in calls['prompts'][-1][1]


def test_short_references_reduce_prompt_cost_and_preserve_original_response_ids():
    repo,service,calls=components()
    snapshot=repo.snapshot(); original=replace(snapshot.chunks[0],chunk_id='original:'+'a'*200)
    repo.snapshot=lambda:replace(snapshot,chunks=[original])
    repo.dense_search=lambda *args,**kwargs:[replace(original,score=.65)]
    result,trace=answer_document(repo,service,'지원 내용')
    assert result['kind']=='answer' and result['evidence'][0]['chunk_id']==original.chunk_id
    assert result['evidence'][0]['quote']==''
    assert trace['source_references']=={'C1':original.chunk_id}
    prompt=calls['prompts'][0][1]
    assert original.chunk_id not in prompt and '"id": "C1"' in prompt
