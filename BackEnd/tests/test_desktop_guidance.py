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
        def chat(self, system, user, *, schema):
            calls.append((system, json.loads(user)))
            assert schema["properties"]["target_id"]["enum"] == [None, ID]
            return {"target_id": ID, "action": "안내", "instruction": "서비스 신청 버튼의 위치를 확인하세요.", "expect_label": "다음"}
    result = guide.generate_step(Llm(), request())
    assert result.target_id == ID
    assert "‘서비스 신청’ 버튼을" in result.instruction
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
        def chat(self,*args,**kwargs):
            return {"target_id": ID, "action": "안내", "instruction": "서비스 신청을 확인하세요.", "expect_label": None}
    def create(base,embed,model,*args,**kwargs):
        recorded.append(model)
        return Llm()
    monkeypatch.setattr(guide,"OllamaClient",create)
    response=guide.desktop_guide(request())
    assert response["model"]=="shared-test-model"
    assert recorded==["shared-test-model"]


@pytest.mark.parametrize("change", [{"visible": False}, {"enabled": False}])
def test_hidden_or_disabled_target_is_rejected(change):
    candidate = request().candidates[0].model_copy(update=change)
    step = json.dumps({"target_id": ID, "action": "안내", "instruction": "버튼을 확인하세요.", "expect_label": None})
    with pytest.raises(ValueError):
        guide.validate_step(step, [candidate])


def test_hidden_only_screen_does_not_call_model():
    class Llm:
        def chat(self, *args, **kwargs):
            pytest.fail("보이지 않는 대상만 있으면 모델을 호출하지 않는다.")
    data = request().model_copy(update={"candidates": [request().candidates[0].model_copy(update={"visible": False})]})
    assert guide.generate_step(Llm(), data).action == "보류"


def test_already_visible_expectation_does_not_block_next_screen():
    payload = json.dumps({"target_id": ID, "action": "안내", "instruction": "서비스 신청을 찾으세요.", "expect_label": "서비스 신청"})
    result = guide.validate_step(payload, request().candidates)
    assert result.expect_label is None
    assert "직접 선택" in result.instruction


def test_clarification_context_and_visible_candidates_reach_model():
    calls = []
    class Llm:
        last_chat_diagnostics = {}
        def chat(self, system, user, *, schema):
            calls.append(json.loads(user))
            return {"target_id": ID, "action": "안내", "instruction": "서비스 신청을 확인하세요.", "expect_label": None}
    data = guide.GuideRequest(
        goal="복지서비스를 찾아보고 싶어",
        candidates=[request().candidates[0], request().candidates[0].model_copy(update={"id": "B" * 20, "visible": False})],
        clarifications=[{"question": "어떤 지원을 찾으시나요?", "answer": "주거 지원"}],
    )
    guide.generate_step(Llm(), data)
    assert calls[0]["goal"] == data.goal
    assert calls[0]["clarifications"] == [{"question": "어떤 지원을 찾으시나요?", "answer": "주거 지원"}]
    assert [item["id"] for item in calls[0]["candidates"]] == [ID]
    with pytest.raises(ValueError):
        guide.Clarification(question="어떤 지원이 필요한가요?", answer="인증코드 123456")
