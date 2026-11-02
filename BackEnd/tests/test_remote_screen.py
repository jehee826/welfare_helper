import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from BackEnd import desktop_guidance as guide, screen_guidance as screen
from BackEnd.admin import session
from BackEnd.core import chat_rate, execution
from BackEnd.core.settings import Settings
from BackEnd.tests.test_desktop_dom import BudgetLlm


def payload(**changes):
    return {'source':'dom','snapshot_id':'F'*20,'question':'공개 메뉴 설명',
            'candidates':[{'id':'A'*20,'label':'공개 메뉴','role':'Button','enabled':True,'visible':True}],
            **changes}


@pytest.fixture
def api(monkeypatch):
    from BackEnd import main
    settings=Settings(_env_file=None,remote_dom_guidance_enabled=True,desktop_guidance_enabled=True,
                      desktop_extension_token='x'*40,ollama_timeout=600)
    for module in (screen,main,chat_rate,session,guide):monkeypatch.setattr(module,'get_settings',lambda:settings)
    monkeypatch.delenv('VERCEL',raising=False)
    monkeypatch.setenv('BACKEND_BIND_HOST','127.0.0.1')
    calls=[];models=[]
    class Llm(BudgetLlm):
        def __init__(self,*args,**kwargs):super().__init__();models.append((args,kwargs))
        def chat(self,*args,**kwargs):
            calls.append('generation')
            return {'kind':'설명','answer':'공개 메뉴가 보입니다.','targets':[]}
    monkeypatch.setattr(guide,'OllamaClient',Llm)
    monkeypatch.setattr(chat_rate,'chat_rate_limiter',chat_rate.ChatRateLimiter())
    with TestClient(main.app) as client:
        yield SimpleNamespace(client=client,settings=settings,calls=calls,models=models)


@pytest.mark.parametrize('disabled',['flag','vercel'])
def test_disabled_rejects_before_body_and_quota(api,monkeypatch,disabled):
    if disabled=='flag':api.settings.remote_dom_guidance_enabled=False
    else:monkeypatch.setenv('VERCEL','1')
    response=api.client.post('/api/v1/screen/guide',content=b'{' + b'x'*70000,headers={'Content-Type':'application/json'})
    assert response.status_code==404 and response.json()=={'detail':'screen_guidance_disabled'}
    assert response.headers['cache-control']=='no-store' and not api.calls and not api.models
    assert not chat_rate.chat_rate_limiter.windows
    response=api.client.get('/api/v1/screen/guide')
    assert response.status_code==404 and response.json()=={'detail':'screen_guidance_disabled'}
    assert response.headers['cache-control']=='no-store' and not api.calls and not api.models
    assert not chat_rate.chat_rate_limiter.windows


@pytest.mark.parametrize('changes',[
    {'image':None},{'image':'x'},{'title':'title'},{'url':'https://example.invalid'},
    {'profile':{}},{'conversation_context':{}},{'inputvalue':'secret'},
    {'source':'image'},{'unknown':'x'},{'question':'비밀번호 123456'},
])
def test_invalid_remote_payload_is_rejected_before_model(api,changes):
    response=api.client.post('/api/v1/screen/guide',json=payload(**changes))
    assert response.status_code==422 and response.json()=={'detail':'invalid_screen_request'}
    assert not api.calls and not api.models


def test_remote_shares_generation_model_and_enforces_body_cap(api):
    response=api.client.post('/api/v1/screen/guide',json=payload())
    assert response.status_code==200 and response.json()['reply']['snapshot_id']=='F'*20
    assert api.calls==['generation'] and api.models[0][0][2]==api.settings.ollama_llm
    before=len(api.calls)
    response=api.client.post('/api/v1/screen/guide',content=b' '*65537,headers={'Content-Type':'application/json'})
    assert response.status_code==413 and len(api.calls)==before


def test_local_desktop_protection_remains_separate(api):
    assert api.client.post('/api/v1/desktop/guide',json=payload()).status_code==401
    response=api.client.post('/api/v1/desktop/guide',json=payload(),headers={'Authorization':'Bearer '+'x'*40,'X-Forwarded-For':'198.51.100.1'})
    assert response.status_code==403 and not api.calls


def test_public_chat_and_remote_share_rate_budget(api,monkeypatch):
    from BackEnd import main
    api.settings.chat_rate_limit_per_minute=1
    assert api.client.post('/api/v1/screen/guide',json=payload()).status_code==200
    calls=[]
    monkeypatch.setitem(main.app.dependency_overrides,main.get_chat_service,lambda:calls.append('factory'))
    result=api.client.post('/api/v1/chat',json={'query':'공개 질문'})
    assert result.status_code==429 and result.json()=={'detail':'chat_rate_limited'}
    assert 1<=int(result.headers['retry-after'])<=60 and calls==[]


def test_remote_busy_uses_existing_gate(api):
    assert execution.inference_gate.acquire(blocking=False)
    try:
        result=api.client.post('/api/v1/screen/guide',json=payload())
        assert result.status_code==429 and result.json()=={'detail':'inference_busy'}
        assert result.headers['retry-after']=='1' and not api.calls
    finally:execution.inference_gate.release()


@pytest.mark.parametrize('count',[0,1,3])
def test_remote_targets_are_mapped_to_current_candidate_ids(api,monkeypatch,count):
    candidates=[{'id':letter*20,'label':'공개 메뉴 '+letter,'role':'Button','enabled':True,'visible':True} for letter in 'ABC']
    class Llm(BudgetLlm):
        def chat(self,*args,**kwargs):
            return {'kind':'설명','answer':'공개 메뉴를 확인하세요.',
                    'targets':[{'target_id':c['id'],'meaning':'공개 메뉴'} for c in candidates[:count]]}
    monkeypatch.setattr(guide,'OllamaClient',lambda *a,**k:Llm())
    result=api.client.post('/api/v1/screen/guide',json=payload(candidates=candidates))
    assert result.status_code==200
    assert [t['target_id'] for t in result.json()['reply']['targets']]==[c['id'] for c in candidates[:count]]


@pytest.mark.parametrize('case',['unknown','disabled','hidden','outside_modal'])
def test_invalid_or_outside_modal_target_is_never_returned(api,monkeypatch,case):
    candidate={'id':'A'*20,'label':'공개 메뉴','role':'Button','enabled':case!='disabled','visible':case!='hidden',
               'in_modal':case!='outside_modal'}
    class Llm(BudgetLlm):
        def chat(self,*args,**kwargs):
            return {'kind':'안내','answer':'공개 메뉴를 확인하세요.',
                    'targets':[{'target_id':'Z'*20 if case=='unknown' else 'A'*20,'meaning':'공개 메뉴'}]}
    monkeypatch.setattr(guide,'OllamaClient',lambda *a,**k:Llm())
    result=api.client.post('/api/v1/screen/guide',json=payload(candidates=[candidate],
                           screen_context=[{'kind':'heading','text':'공개 안내'}],modal_open=case=='outside_modal'))
    assert result.status_code==503 and result.json()=={'detail':'screen_generation_failed'}
    assert 'A'*20 not in result.text and 'Z'*20 not in result.text
