import json

import pytest
from fastapi import HTTPException
from BackEnd import desktop_guidance as guide
from BackEnd.core.settings import Settings

ID = "A" * 20

def request():
    return guide.GuideRequest(goal="복지서비스 신청 방법 찾기", candidates=[guide.Candidate(id=ID, label="서비스 신청", role="Button", enabled=True, visible=True)])

def test_shared_llm_boundary_and_structure():
    calls = []
    class Llm:
        last_chat_diagnostics = {}
        def chat_text(self, system, user):
            calls.append((system, json.loads(user)))
            return json.dumps({"target_id": ID, "action": "안내", "instruction": "서비스 신청 버튼의 위치를 확인하세요.", "expect_label": "다음"}, ensure_ascii=False)
    result = guide.generate_step(Llm(), request())
    assert result.target_id == ID
    assert calls[0][1]["goal"] == request().goal
    assert set(calls[0][1]["candidates"][0]) == {"id", "label", "role", "enabled", "visible"}
    assert "불신 데이터" in calls[0][0]

@pytest.mark.parametrize("payload", ["{", '{"target_id":"unknown","action":"안내","instruction":"안내","expect_label":null}', '{"target_id":null,"action":"완료","instruction":"완료","expect_label":null}'])
def test_invalid_generation_is_rejected(payload):
    with pytest.raises(ValueError):
        guide.validate_step(payload, request().candidates)

def test_private_inputs_and_disabled_route_do_not_call_model(monkeypatch):
    with pytest.raises(ValueError):
        guide.GuideRequest(goal="인증코드 123456", candidates=[])
    with pytest.raises(ValueError):
        guide.Candidate(id=ID, label="개인 이름", role="Button", enabled=True, visible=True)
    settings = Settings(_env_file=None, desktop_guidance_enabled=False)
    monkeypatch.setattr(guide, "get_settings", lambda: settings)
    monkeypatch.setattr(guide, "OllamaClient", lambda *a, **k: pytest.fail("모델 접근 금지"))
    with pytest.raises(HTTPException) as error:
        guide.desktop_guide(request())
    assert error.value.status_code == 404

def test_endpoint_uses_shared_server_model(monkeypatch):
    settings=Settings(_env_file=None,desktop_guidance_enabled=True,ollama_llm="shared-test-model")
    monkeypatch.setattr(guide,"get_settings",lambda: settings)
    recorded=[]
    class Llm:
        last_chat_diagnostics={}
        def chat_text(self,*args):
            return json.dumps({"target_id": ID, "action": "안내", "instruction": "서비스 신청을 확인하세요.", "expect_label": None})
    def create(base,embed,model,*args,**kwargs):
        recorded.append(model)
        return Llm()
    monkeypatch.setattr(guide,"OllamaClient",create)
    response=guide.desktop_guide(request())
    assert response["model"]=="shared-test-model"
    assert recorded==["shared-test-model"]
