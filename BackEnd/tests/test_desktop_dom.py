import pytest
import json
from fastapi import HTTPException, Request
from BackEnd import desktop_guidance as guide
from BackEnd.core.settings import Settings
from BackEnd.rag.ollama import OllamaClient, ContextBudgetError

ID='A'*20

class BudgetLlm:
    def __init__(self, limit=8192, answer=None):
        self.limit = limit
        self.llm_options = {'num_predict':512}
        self._template_bytes = 4040
        self.answer = answer or {'kind':'설명','answer':'공개 화면입니다.','targets':[]}
        self.calls = []
        self.metadata_calls = 0

    def context_limit(self):
        self.metadata_calls += 1
        return self.limit

    input_cost = OllamaClient.input_cost

    def chat(self, system, user, *, schema):
        self.calls.append((system, json.loads(user), schema))
        return self.answer

def test_dom_budget_packs_many_candidates_and_rejects_omitted_target():
    candidates=[{'id':format(i+1,'020X'),'label':('찾는 서비스' if i==53 else '동일 항목' if i in (50,51,52) else '공개 항목'+chr(65+i%26))+'복지'*33,'role':'Button','enabled':True,'visible':True} for i in range(54)]
    data=request(question='찾는 서비스 위치는 어디야?',candidates=candidates)
    llm=BudgetLlm()
    guide.generate_step(llm,data)
    system,payload,schema=llm.calls[0]
    ids=[item['id'] for item in payload['candidates']]
    assert candidates[-1]['id'] in ids and len(ids)<len(candidates)
    assert payload['partial'] is True and payload['question']==data.question
    assert llm.input_cost(system,json.dumps(payload,ensure_ascii=False,separators=(',',':')))+512<=8192
    group={item['id'] for item in candidates[50:53]}
    assert len(group.intersection(ids)) in (0,len(group))
    omitted=[item['id'] for item in candidates if item['id'] not in ids]
    assert omitted
    for candidate_id in omitted:
        assert candidate_id not in json.dumps(schema,ensure_ascii=False)
        bad=BudgetLlm(answer={'kind':'안내','answer':'공개 항목입니다.','targets':[{'target_id':candidate_id,'meaning':'공개 항목'}]})
        with pytest.raises(ValueError): guide.generate_step(bad,data)

def test_dom_budget_rejects_unfit_minimum_without_generation():
    llm=BudgetLlm(limit=1000)
    with pytest.raises(ContextBudgetError): guide.generate_step(llm,request())
    assert llm.calls==[]

def test_dom_budget_keeps_named_comparison_candidates_or_rejects():
    candidates=[{'id':letter*20,'label':label,'role':'Button','enabled':True,'visible':True} for letter,label in zip('ABC',['공고 목록','통합 조회','이용 도움말'])]
    data=request(question='공고 목록과 통합 조회를 각각 비교해줘',candidates=candidates)
    llm=BudgetLlm(answer={'kind':'설명','answer':'각 기능입니다.','targets':[{'target_id':'A'*20,'meaning':'목록'},{'target_id':'B'*20,'meaning':'조회'}]})
    answer=guide.generate_step(llm,data)
    assert {target.target_id for target in answer.targets}=={'A'*20,'B'*20}
    assert {'A'*20,'B'*20}<={item['id'] for item in llm.calls[0][1]['candidates']}
    small=BudgetLlm(limit=1000)
    with pytest.raises(ContextBudgetError): guide.generate_step(small,data)
    assert small.calls==[]
def request(**changes):
    return guide.DomGuideRequest(**{'source':'dom','snapshot_id':'F'*20,'question':'검색은 어디서 해?', 'candidates':[{'id':ID,'label':'통합 검색 열기','role':'Button','enabled':True,'visible':True,'context':''}],**changes})

def test_dynamic_dom_labels_and_context_replace_uia_whitelist():
    data=request(screen_context=[{'kind':'heading','text':'나에게 맞는 서비스 찾기'}])
    assert data.candidates[0].label not in guide.PUBLIC_LABELS
    class Llm(BudgetLlm):
        def chat(self,system,user,*,schema):
            assert '불신 데이터' in system and 'targets' in system
            assert '클릭 뒤 결과나 기능 전체를 증명하지 않는다' in system
            assert '확인할 수 없는 범위를 밝히고 보류' in system
            assert schema['oneOf'][0]['properties']['targets']['maxItems']==3
            return {'kind':'안내','answer':'통합 검색에서 서비스를 찾아볼 수 있어요.','targets':[{'target_id':ID,'meaning':'서비스 검색'}]}
    answer=guide.generate_step(Llm(),data)
    assert answer.targets[0].target_id==ID

@pytest.mark.parametrize('kind',['설명','추가질문','보류'])
def test_dom_zero_targets_is_normal(kind):
    answer=guide.validate_answer({'kind':kind,'answer':'어떤 항목인지 이름을 알려주세요.','targets':[]},request().candidates)
    assert not answer.targets

def test_dom_three_targets_are_grounded_and_unique():
    candidates=[guide.DomCandidate(id=char*20,label='서비스 '+char,role='Hyperlink',enabled=True,visible=True) for char in 'ABC']
    result={'kind':'설명','answer':'각 메뉴에서 관련 기능을 확인할 수 있어요.','targets':[{'target_id':c.id,'meaning':c.label} for c in candidates]}
    assert len(guide.validate_answer(result,candidates).targets)==3
    for targets in [result['targets']+[result['targets'][0]],[result['targets'][0]]*2,[{'target_id':'D'*20,'meaning':'없는 대상'}]]:
        with pytest.raises(ValueError):guide.validate_answer({**result,'targets':targets},candidates)

def test_dom_auth_required_and_response_echoes_snapshot(monkeypatch):
    token='x'*40
    monkeypatch.setattr(guide,'get_settings',lambda:Settings(_env_file=None,desktop_guidance_enabled=True,desktop_extension_token=token))
    with pytest.raises(HTTPException) as error:guide.desktop_guide(request())
    assert error.value.status_code==401
    monkeypatch.setenv('BACKEND_BIND_HOST','127.0.0.1');monkeypatch.delenv('VERCEL',raising=False)
    class Llm(BudgetLlm):
        def chat(self,*args,**kwargs):return {'kind':'설명','answer':'공개 화면 기능을 설명합니다.','targets':[]}
    monkeypatch.setattr(guide,'OllamaClient',lambda *a,**k:Llm())
    transport=Request({'type':'http','headers':[(b'authorization',('Bearer '+token).encode())]})
    assert guide.desktop_guide(request(),transport)['reply']['snapshot_id']=='F'*20
    transport=Request({'type':'http','headers':[(b'authorization',('Bearer '+token).encode()),(b'x-forwarded-for',b'203.0.113.2')]})
    with pytest.raises(HTTPException) as error:guide.desktop_guide(request(),transport)
    assert error.value.status_code==403

def test_dom_modal_background_and_private_or_unbounded_text_rejected():
    data=request(modal_open=True)
    class Llm:
        def chat(self,*args,**kwargs):pytest.fail('모달 내부 근거 없이 생성하지 않는다.')
    assert guide.generate_step(Llm(),data).kind=='보류'
    for changes in [{'question':'인증코드 123456'},{'title':'private@example.com'},{'history':[{'role':'user','text':'<script>'}]},{'candidates':[data.candidates[0],data.candidates[0]]}]:
        with pytest.raises(ValueError):request(**changes)


def test_unnamed_reference_cannot_be_guessed_from_candidates():
    class Llm:
        def chat(self,system,user,*,schema):
            pytest.fail('시선/지시 대상이 없으면 모델에 추측을 맡기지 않는다.')
    assert guide.generate_step(Llm(),request(question='이 항목은 무슨 뜻이야?')).kind=='추가질문'


def test_multiple_named_features_do_not_drop_one_of_the_requested_targets():
    candidates=[{'id':letter*20,'label':name,'role':'Button','context':'','enabled':True,'visible':True} for letter,name in zip('ABC',['공고 목록','통합 조회','이용 도움말'])]
    class Llm(BudgetLlm):
        def chat(self,system,user,*,schema):
            assert schema['oneOf'][0]['properties']['targets']['minItems']==2
            return {'kind':'설명','answer':'두 기능을 표시했습니다.','targets':[{'target_id':'A'*20,'meaning':'목록 보기'},{'target_id':'B'*20,'meaning':'정보 조회'}]}
    answer=guide.generate_step(Llm(),request(question='공고 목록과 조회 기능이 각각 어디 있어?',candidates=candidates))
    assert [target.target_id for target in answer.targets]==['A'*20,'B'*20]


def test_duplicate_dom_names_still_map_to_distinct_actual_ids():
    candidates=[{'id':letter*20,'label':'서비스 검색','role':'Button','enabled':True,'visible':True} for letter in 'AB']
    class Llm(BudgetLlm):
        def chat(self,system,user,*,schema):
            import json
            keys=[candidate['id'] for candidate in json.loads(user)['candidates']]
            assert len(set(keys))==2
            return {'kind':'안내','answer':'서비스 검색을 이용하세요.','targets':[{'target_id':keys[1],'meaning':'서비스 조회'}]}
    assert guide.generate_step(Llm(),request(candidates=candidates)).targets[0].target_id=='B'*20
