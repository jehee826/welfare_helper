import json
import pytest
from fastapi import HTTPException
from BackEnd import desktop_guidance as guide
from BackEnd.core.settings import Settings

ID = 'A' * 20

def request(**changes):
    return guide.GuideRequest(**{'goal':'검색은 어디서 해?', 'candidates':[{'id':ID,'label':'검색','role':'Button','enabled':True,'visible':True}], **changes})

def test_natural_explanation_is_not_replaced_with_fixed_click_instruction():
    class Llm:
        def chat(self,system,user,*,schema):
            data=json.loads(user)
            assert data['goal']=='검색은 어디서 해?'
            assert 'progress' not in data and 'observation' not in data and 'image' not in data
            assert schema['oneOf'][0]['properties']['target_id']['enum']==['1:검색']
            assert '설명' in schema['oneOf'][1]['properties']['action']['enum']
            assert '불신 데이터' in system
            return {'target_id':'1:검색','action':'안내','instruction':'검색 버튼에서 원하는 복지서비스를 찾아볼 수 있어요.','expect_label':None}
    result=guide.generate_step(Llm(),request())
    assert result.target_id==ID
    assert result.instruction=='검색 버튼에서 원하는 복지서비스를 찾아볼 수 있어요.'
    assert '화면 변화 확인' not in result.instruction

@pytest.mark.parametrize('action',['설명','추가질문','보류'])
def test_targetless_answers_are_normal_even_with_actionable_candidates(action):
    class Llm:
        def chat(self,*args,**kwargs):
            return {'target_id':None,'action':action,'instruction':'어떤 항목을 말씀하시는지 이름을 알려주세요.','expect_label':None}
    assert guide.generate_step(Llm(),request()).target_id is None

@pytest.mark.parametrize('payload',['{',json.dumps({'target_id':'unknown','action':'안내','instruction':'선택하세요.','expect_label':None}),json.dumps({'target_id':ID,'action':'설명','instruction':'설명','expect_label':None})])
def test_unknown_target_or_target_on_explanation_is_rejected(payload):
    with pytest.raises(ValueError):guide.validate_step(payload,request().candidates)

@pytest.mark.parametrize('change',[{'visible':False},{'enabled':False}])
def test_hidden_or_disabled_target_is_rejected(change):
    candidate=request().candidates[0].model_copy(update=change)
    with pytest.raises(ValueError):guide.validate_step(json.dumps({'target_id':ID,'action':'안내','instruction':'선택하세요.','expect_label':None}),[candidate])


def test_model_cannot_override_locally_verified_overlay_direction():
    with pytest.raises(ValueError):guide.validate_step(json.dumps({'target_id':ID,'action':'안내','instruction':'왼쪽의 파란 버튼을 누르세요.','expect_label':None}),request().candidates)

def test_unknown_public_text_and_private_question_are_rejected():
    with pytest.raises(ValueError):request(goal='인증코드 123456')
    with pytest.raises(ValueError):request(screen_context=[{'kind':'text','text':'김사용자님의 개인 내용'}])
    with pytest.raises(ValueError):request(candidates=[{'id':ID,'label':'개인 이름','role':'Button','enabled':True,'visible':True}])

def test_public_context_can_be_explained_without_buttons():
    class Llm:
        def chat(self,system,user,**kwargs):
            assert json.loads(user)['screen_context']==[{'kind':'text','text':'복지서비스'}]
            return {'target_id':None,'action':'설명','instruction':'현재 복지서비스 화면으로 확인됩니다. 자세한 설명문은 읽지 못했습니다.','expect_label':None}
    assert guide.generate_step(Llm(),request(candidates=[],screen_context=[{'kind':'text','text':'복지서비스'}])).action=='설명'

def test_empty_screen_does_not_call_model():
    class Llm:
        def chat(self,*args,**kwargs):pytest.fail('근거 없는 추론 금지')
    assert guide.generate_step(Llm(),request(candidates=[])).action=='보류'

def test_sensitive_navigation_requires_user_intent():
    class Llm:
        def chat(self,system,user,**kwargs):
            assert [c['label'] for c in json.loads(user)['candidates']]==['검색']
            return {'target_id':None,'action':'설명','instruction':'검색 기능을 사용할 수 있습니다.','expect_label':None}
    data=request()
    data.candidates.append(guide.Candidate(id='B'*20,label='로그인',role='Button',enabled=True,visible=True))
    guide.generate_step(Llm(),data)

def test_feature_off_does_not_create_model(monkeypatch):
    monkeypatch.setattr(guide, 'OllamaClient', lambda *a, **k: pytest.fail('모델 접근 금지'))
    monkeypatch.setattr(guide, 'get_settings', lambda: Settings(_env_file=None, desktop_guidance_enabled=False))
    with pytest.raises(HTTPException) as error:
        guide.desktop_guide(request())
    assert error.value.status_code == 404


@pytest.mark.parametrize('value', [None, 'iVBORw0KGgo='])
def test_image_field_is_rejected_before_model(value, monkeypatch):
    monkeypatch.setattr(guide, 'OllamaClient', lambda *a, **k: pytest.fail('모델 접근 금지'))
    with pytest.raises(ValueError):
        request(image=value)
    with pytest.raises(ValueError):
        guide.DomGuideRequest(source='dom', snapshot_id='F'*20, question='화면 설명', candidates=[], image=value)


def test_http_validation_never_echoes_question_or_image_and_limits_body(monkeypatch):
    from fastapi.testclient import TestClient
    from BackEnd.main import app
    client=TestClient(app)
    private_marker='private-test-content-never-echo'
    response=client.post('/api/v1/desktop/guide',json={'goal':'화면 설명','candidates':[],'image':private_marker})
    assert response.status_code==422 and private_marker not in response.text
    response=client.post('/api/v1/desktop/guide',content=b'x'*(2*1024*1024+65537),headers={'Content-Type':'application/json'})
    assert response.status_code==413


def test_public_forwarded_request_is_rejected_before_model(monkeypatch):
    from fastapi.testclient import TestClient
    from BackEnd.main import app
    monkeypatch.setattr(guide,'get_settings',lambda:Settings(_env_file=None,desktop_guidance_enabled=True,desktop_extension_token='x'*40))
    monkeypatch.setenv('BACKEND_BIND_HOST','127.0.0.1')
    monkeypatch.delenv('VERCEL',raising=False)
    monkeypatch.setattr(guide,'OllamaClient',lambda *a,**k:pytest.fail('공개 프록시 모델 접근 금지'))
    payload={'source':'dom','snapshot_id':'F'*20,'question':'화면 설명','candidates':[]}
    response=TestClient(app).post('/api/v1/desktop/guide',json=payload,headers={'Authorization':'Bearer '+'x'*40,'X-Forwarded-For':'203.0.113.5'})
    assert response.status_code==403
