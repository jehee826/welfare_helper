import pytest
from BackEnd import desktop_guidance as guide


def request(question):
    return guide.DomGuideRequest(source='dom', snapshot_id='F'*20, question=question,
        screen_context=[{'kind':'heading','text':'복지서비스'}], candidates=[
            {'id':'A'*20,'label':'본문 바로가기','role':'Button','enabled':True,'visible':True},
            {'id':'B'*20,'label':'음성안내 재생','role':'Button','enabled':True,'visible':True}])


@pytest.mark.parametrize('question', ['테두리 표시 없이 화면을 설명해줘', '표시하지 말고 설명해줘'])
def test_explicit_no_highlights_restricts_schema_and_rejects_targets(question):
    class Llm:
        def chat(self, system, user, *, schema):
            assert 'targets=[]' in system
            assert all(branch['properties']['targets']['maxItems'] == 0 for branch in schema['oneOf'])
            return {'kind':'설명','answer':'공개 화면 설명입니다.','targets':[]}
    assert guide.generate_step(Llm(), request(question)).targets == []
    class Invalid(Llm):
        def chat(self, *args, **kwargs):
            return {'kind':'설명','answer':'공개 화면입니다.','targets':[{'target_id':'본문 바로가기','meaning':'본문'}]}
    with pytest.raises(ValueError): guide.generate_step(Invalid(), request(question))


def test_not_only_explanation_allows_target():
    class Llm:
        def chat(self, system, user, *, schema):
            assert any(branch['properties']['targets'].get('minItems') == 1 for branch in schema['oneOf'])
            return {'kind':'안내','answer':'본문으로 이동할 수 있습니다.','targets':[{'target_id':'본문 바로가기','meaning':'본문'}]}
    assert len(guide.generate_step(Llm(), request('설명만 말고 본문 바로가기 위치도 알려줘')).targets) == 1


def test_each_feature_explanation_keeps_two_targets():
    class Llm:
        def chat(self, system, user, *, schema):
            assert schema['oneOf'][0]['properties']['targets']['minItems'] == 2
            return {'kind':'설명','answer':'각 기능을 확인하세요.','targets':[
                {'target_id':'본문 바로가기','meaning':'본문'}, {'target_id':'음성안내 재생','meaning':'음성'}]}
    assert len(guide.generate_step(Llm(), request('본문 바로가기와 음성안내 재생을 각각 설명해줘')).targets) == 2
