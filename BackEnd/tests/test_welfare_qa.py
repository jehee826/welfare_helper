"""검사 대역으로 보류·메타데이터·버전 격리와 정확한 원문 인용을 검증한다."""

from dataclasses import replace
import json
from types import SimpleNamespace

import pytest

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.qa import answer_document
from BackEnd.documents.context import ANSWER_SYSTEM,answer_prompt,fit_answer
from BackEnd.documents.welfare import complete_sources, validate_answer
from BackEnd.rag.repository import CatalogSnapshot
from BackEnd.tests.test_document_qa import components


def packet(**values):
    return json.dumps({'status':'answer','text':'연 168,000원 지원',
                       'citations':[{'id':'a','quote':'연 168,000원 지원. 단, 조건 확인 필요.'}], **values}, ensure_ascii=False)


SOURCE = {'id':'a','text':'연 168,000원 지원. 단, 조건 확인 필요.', 'source_url':'https://example.invalid'}


@pytest.mark.parametrize('change', [
    {'citations':[]}, {'citations':[{'id':'fake','quote':SOURCE['text']}]},
    {'citations':[{'id':'a','quote':'조건 없음'}]}, {'text':'연 999999원 지원'},
    {'text':'https://invented.invalid 에서 신청'}, {'text':'연락처 010-1234-5678'},
])
def test_unmatched_citation_numbers_and_contact_are_rejected(change):
    with pytest.raises(ValueError):
        validate_answer(packet(**change), [SOURCE])


def test_literal_amount_normalization_is_not_a_qualification_judgement():
    assert validate_answer(packet(text='연 16.8만원 지원'), [SOURCE]).status == 'answer'

def test_exception_deadline_requires_citation_of_exception_source():
    sources=[{'id':'base','text':'신청은 출산 후 30일까지입니다.'},
             {'id':'exception','text':'관할 보건소 안내에는 출산 후 60일까지로 기재됩니다.'}]
    response={'status':'answer','text':'신청은 출산 후 30일까지이며 관할 안내에는 60일까지로 기재됩니다.',
              'citations':[{'id':'base','quote':'출산 후 30일까지'}]}
    with pytest.raises(ValueError,match='unsupported_quantity'):
        validate_answer(response,sources)
    response['citations'].append({'id':'exception','quote':'출산 후 60일까지'})
    assert validate_answer(response,sources).status=='answer'

def test_grounded_service_explanation_can_include_one_missing_condition_question():
    source={'id':'source','text':'합성 산모 지원은 건강관리 이용권을 제공합니다. 지원 대상은 출산가정입니다. 신청 시기는 출산 전과 출산 후로 구분합니다.'}
    response={'status':'answer','text':'합성 산모 지원은 건강관리 이용권을 제공합니다. 지원받으실 분은 출산 전인가요, 출산 후인가요?',
              'citations':[{'id':'source','quote':'합성 산모 지원은 건강관리 이용권을 제공합니다.'}]}
    accepted=validate_answer(response,[source])
    assert accepted.status=='answer' and accepted.text.count('?')==1
    assert response['citations'][0]['quote'] in source['text']
    assert '출산 전' in source['text'] and '출산 후' in source['text']

def test_missing_requested_information_is_no_evidence_without_citations():
    source={'id':'source','text':'합성 지원은 생리용품 구매 이용권을 제공합니다.'}
    response={'status':'no_evidence','text':'해외 배송비 지원은 이 자료에서 확인되지 않습니다.','citations':[]}
    assert validate_answer(response,[source]).status=='no_evidence'
    assert '해외 배송' not in source['text']

def test_pure_service_clarification_has_no_citations():
    response={'status':'clarify','text':'어느 서비스의 신청 방법을 말씀하시나요?','citations':[]}
    assert validate_answer(response,[SOURCE]).status=='clarify'

def test_answer_document_passes_grounded_explanation_and_question_through_fake_model():
    repo,service,_=components();snapshot=repo.snapshot();chunk=replace(snapshot.chunks[0],text='합성 산모 지원은 건강관리 이용권을 제공합니다. 지원 대상은 출산가정입니다. 신청 시기는 출산 전과 출산 후로 구분합니다.')
    repo.snapshot=lambda:replace(snapshot,chunks=[chunk]);seen=[]
    def generate(system,user,**kwargs):
        seen.append((system,user,kwargs['schema']))
        return {'status':'answer','text':'합성 산모 지원은 건강관리 이용권을 제공합니다. 지원받으실 분은 출산 전인가요, 출산 후인가요?',
                'citations':[{'id':'C1','quote':'합성 산모 지원은 건강관리 이용권을 제공합니다.'}]}
    service.llm.chat=generate
    result,trace=answer_document(repo,service,'가족을 대신해 산모 지원 내용과 신청 시기를 알고 싶어요.')
    assert result['kind']=='answer' and result['text'].count('?')==1 and trace['answer_validation']=='accepted'
    assert result['evidence'][0]['quote'] in chunk.text and len(seen)==1
    assert '출산 전' in chunk.text and '출산 후' in chunk.text
    system=seen[0][0]
    assert '질문1개 순서로 최대3개 서비스' in system and '찾은 서비스가 하나면 하나만' in system
    assert '설명할 근거가 있으면 확인된 내용 뒤에 필요한 질문1개' in system
    assert '보호자에게는 지원받으실 분의 조건' in system and '출산·주거 사실을 추정하지' in system

@pytest.mark.parametrize('status', ['no_evidence','out_of_scope','clarify'])
def test_nonanswer_with_citations_is_rejected(status):
    with pytest.raises(ValueError,match='unsupported_citations'):
        validate_answer(packet(status=status),[SOURCE])


@pytest.mark.parametrize('status', ['no_evidence','out_of_scope','clarify'])
def test_relatedness_and_missing_conditions_do_not_attach_unrelated_sources(status):
    repo, service, _ = components()
    service.llm.chat_text = lambda *args:packet(status=status,text='대상과 거주지를 알려주세요.',citations=[])
    result, trace = answer_document(repo, service, '질문')
    assert result['kind'] == 'fallback' and result['reason'] == status and result['evidence'] == []
    assert trace['reason'] == status


def test_invalid_factual_answer_is_a_withheld_result_not_success():
    repo, service, _ = components()
    service.llm.chat_text = lambda *args:packet()
    result, trace = answer_document(repo, service, '질문')
    assert result['kind'] == 'fallback' and result['reason'] == 'invalid_evidence_answer'
    assert result['evidence'] == [] and trace['citation_validation'] == 'exact_source_span_and_literal_values_only'
    assert trace['answer_validation'] == 'citation_not_in_source'


def test_final_answer_uses_existing_structured_transport_with_answer_schema():
    repo, service, _ = components()
    snapshot=repo.snapshot()
    first=snapshot.chunks[0]
    repo.document_scope=None
    repo.snapshot=lambda:replace(snapshot,chunks=[first,replace(first,chunk_id='omitted',document_id='other')])
    repo.dense_search=lambda *args,**kwargs:[replace(first,score=.65),replace(first,chunk_id='omitted',document_id='other',score=.1)]
    calls=[]
    original=service.llm.chat
    def structured(system,user,**options):
        calls.append(options)
        return original(system,user,**options)
    service.llm.chat=structured
    result,_=answer_document(repo,service,'원문 내용')
    assert result['kind']=='answer' and len(calls)==1
    schema=calls[0]['schema']
    answer,fallback=schema['oneOf']
    assert answer['properties']['status']['enum']==['answer']
    assert fallback['properties']['status']['enum']==['clarify','no_evidence','out_of_scope']
    assert answer['properties']['citations']['minItems']==1 and answer['properties']['citations']['maxItems']==6
    assert fallback['properties']['citations']['maxItems']==0
    for branch in (answer,fallback):
        assert set(branch['required'])=={'status','text','citations'} and branch['additionalProperties'] is False
        assert branch['properties']['text']['minLength']==1 and branch['properties']['text']['maxLength']==3000
        assert branch['properties']['citations']['items']=={'$ref':'#/$defs/Citation'}
    citation=schema['$defs']['Citation']
    assert citation['properties']['id']['enum']==['C1'] and citation['additionalProperties'] is False
    assert set(citation['required'])=={'id','quote'} and citation['properties']['quote']['maxLength']==1600
    assert result['evidence'][0]['chunk_id']=='source:1'


def test_whole_document_expansion_preserves_exception_and_ignores_other_document():
    repo, _, _ = components()
    first = replace(repo.snapshot().chunks[0],version='v1',text='지원 대상',parent_id='p1')
    exception = replace(first,chunk_id='source:2',ordinal=1,text='단, 재학 조건이 필요하다.')
    other = replace(first,chunk_id='foreign',document_id='other',text='다른 지역 서비스')
    snapshot = CatalogSnapshot([], [first, exception, other], 'fixed')
    assert complete_sources(snapshot,[first]) == [first, exception]
    with pytest.raises(DocumentError, match='version_mismatch'):
        complete_sources(CatalogSnapshot([], [first,replace(exception,version='v2')], 'fixed'),[first])


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


@pytest.mark.parametrize('case',['unknown','duplicate_citation','duplicate_alias','duplicate_original','wrong_quote'])
def test_short_references_reject_forgery_duplication_and_cross_source_quotes(case):
    source={**SOURCE,'reference_id':'C1'}
    other={'id':'other','reference_id':'C2','text':'별개의 다른 원문'}
    citation={'id':'C1','quote':SOURCE['text']}
    citations=[citation]
    if case=='unknown':citations=[{**citation,'id':'C99'}]
    if case=='duplicate_citation':citations=[citation,citation]
    if case=='duplicate_alias':other['reference_id']='C1'
    if case=='duplicate_original':other['id']=SOURCE['id']
    if case=='wrong_quote':citations=[{**citation,'quote':other['text']}]
    with pytest.raises(ValueError):
        validate_answer(packet(citations=citations),[source,other])


def test_short_references_reduce_prompt_cost_and_preserve_original_response_ids():
    repo,service,calls=components()
    snapshot=repo.snapshot(); original=replace(snapshot.chunks[0],chunk_id='original:'+'a'*200)
    repo.snapshot=lambda:replace(snapshot,chunks=[original])
    repo.dense_search=lambda *args,**kwargs:[replace(original,score=.65)]
    result,trace=answer_document(repo,service,'지원 내용')
    assert result['kind']=='answer' and result['evidence'][0]['chunk_id']==original.chunk_id
    assert result['evidence'][0]['quote']==original.text
    assert trace['source_references']=={'C1':original.chunk_id}
    prompt=calls['prompts'][0][1]
    assert original.chunk_id not in prompt and '"id": "C1"' in prompt
