"""실제 DB·모델 대신 결정적 문서 스냅샷으로 채팅과 진단의 실행 계약을 비교한다."""

from collections import OrderedDict
import json
from dataclasses import replace
import re
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from pydantic import SecretStr

from BackEnd.core.settings import Settings
from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.qa import answer_document
from BackEnd.documents.context import PREPARE_SYSTEM, ANSWER_SYSTEM, EMPTY_EVIDENCE_SYSTEM
from BackEnd.rag.chat import ChatService
from BackEnd.rag.evidence import EvidenceChunk
from BackEnd.rag.repository import CatalogSnapshot
from BackEnd.tests.test_api import api  # noqa: F401


TOKEN = "virtual-diagnostic-token-" * 2
DOC = "00000000-0000-0000-0000-000000000001"
PRIVATE_DOC = "00000000-0000-0000-0000-000000000002"
DIGEST = "digest-9913991234567"


@pytest.mark.parametrize('failure', [False, True])
def test_native_generation_scalars_are_recorded_without_private_data_even_on_failure(monkeypatch, failure):
    from BackEnd.core import qa_diagnostics as diagnostics
    logged = Mock()
    monkeypatch.setattr(diagnostics.logger, 'info', logged)
    @diagnostics.diagnose_qa
    def run():
        try:
            if failure:
                raise DocumentError('document_generation_failed')
            return {}, {'reason':'answer'}
        finally:
            diagnostics.record_generation_metrics({'done_reason':'length' if failure else 'stop',
                'prompt_eval_count':3000,'eval_count':1024,'load_duration':100,
                'total_duration':False,'eval_duration':-1,'prompt_eval_duration':'private',
                'query':'private-question','profile':'private-profile','text':'private-answer'})
    if failure:
        with pytest.raises(DocumentError):run()
    else:
        run()
    records = [json.loads(call.args[1]) for call in logged.call_args_list]
    metrics = next(row for row in records if row['event']=='generation_metrics')
    assert {k:metrics[k] for k in ('prompt_eval_count','eval_count','load_duration','done_reason')} == {
        'prompt_eval_count':3000,'eval_count':1024,'load_duration':100,'done_reason':'length' if failure else 'stop'}
    assert not any(key in metrics for key in ('query','profile','text','total_duration','eval_duration','prompt_eval_duration'))
    assert 'private-' not in json.dumps(records)
    assert records[-1]['code'] == ('document_generation_failed' if failure else 'answer')


def test_cancelled_before_generation_does_not_relabel_preparation_metrics(monkeypatch):
    from BackEnd.core.execution import ExecutionCancelledError
    from BackEnd.documents import qa
    from BackEnd.tests.test_document_qa import components as simple_components
    repo, service, _ = simple_components()
    service.llm.last_chat_diagnostics = {'prompt_eval_count':7777,'eval_count':88,'done_reason':'stop'}
    stage = [None]
    def enter(name):stage[0] = name
    def check():
        if stage[0] == 'generation':raise ExecutionCancelledError()
    recorder = Mock()
    service.llm.chat = Mock()
    monkeypatch.setattr(qa, 'qa_stage', enter)
    monkeypatch.setattr(qa, 'checkpoint', check)
    monkeypatch.setattr(qa, 'record_generation_metrics', recorder)
    with pytest.raises(ExecutionCancelledError):
        qa.answer_document(repo,service,'지원 조건')
    service.llm.chat.assert_not_called()
    recorder.assert_not_called()


def components(settings, *, private=False):
    public = EvidenceChunk("public:9913991234567", "PUBLIC", "content", "2026년 문서 안내입니다.", "",
                           document_id=DOC, document_name="공개 문서", embed_digest=DIGEST,
                           page_refs=(1,), source_blocks=("block:9913991234567",))
    hidden = replace(public, chunk_id="private:9913991234567", service_id="TEST_PRIVATE", document_id=PRIVATE_DOC,
                     document_name="비공개 가상 문서", text="가상 계좌번호: 321-00-000001")
    snapshot = CatalogSnapshot([], [public, hidden] if private else [public], "snapshot-9913991234567")
    repo = SimpleNamespace(document_scope=None, include_local_documents=private, snapshot=Mock(return_value=snapshot),
                           dense_search=Mock(return_value=[replace(c, score=.99) for c in snapshot.chunks]))
    def generate(system, user):
        if system == PREPARE_SYSTEM:
            payload=json.loads(user)
            return json.dumps({'relation':'followup' if payload['sources'] else 'independent',
                               'search_query':payload['current_question'],'source_ids':[item['id'] for item in payload['sources']][:8], 'document_ids':[], 'needs_clarification':False})
        if system == EMPTY_EVIDENCE_SYSTEM:
            return json.dumps({'status':'no_evidence','text':'현재 자료에서 확인하지 못했습니다.'})
        sources = json.loads(user.split('문서 근거(JSON):\n')[1].split('\n\n질문:')[0])
        documents = [chunk for source in sources for chunk in source['chunks']]
        return json.dumps({'status':'answer','text':('관리자' if private else '공개') + ' 답변. 가상 991399-1234567. 2026년 129/1355 안내'}, ensure_ascii=False)
    llm = SimpleNamespace(model_digest=Mock(return_value=DIGEST), embed=Mock(return_value=[[.1] * 1024]),
                          context_limit=lambda:32768, input_cost=lambda system,user:len((system+user).encode()),
                          chat_text=Mock(side_effect=generate),
                          last_chat_diagnostics={"done_reason": "stop", "eval_count": 17})
    llm.chat = Mock(side_effect=lambda system,user,**kwargs:json.loads(generate(system,user)))
    llm.for_request = lambda *_: SimpleNamespace(**{**vars(llm), "last_chat_diagnostics": dict(llm.last_chat_diagnostics)})
    service = ChatService(repo, llm, settings.min_dense_sim, settings.retrieve_top_n,
                          reranker=SimpleNamespace(score=Mock(side_effect=lambda _q, passages: [.01] * len(passages))),
                          min_rerank_score=settings.min_rerank_score,
                          analyzer=lambda text: re.findall(r"[가-힣A-Za-z0-9]+", text.lower()),
                          dense_k=settings.dense_top_k, keyword_k=settings.keyword_top_k, core_k=settings.core_evidence_k)
    service.answer_with_diagnostics = Mock(side_effect=AssertionError("이전 진단 경로를 호출했습니다."))
    service.answer = Mock(side_effect=AssertionError("이전 채팅 경로를 호출했습니다."))
    return service


@pytest.fixture
def diagnostic_api(api, monkeypatch):
    import BackEnd.admin.session as sessions
    import BackEnd.documents.auth as auth
    import BackEnd.documents.api as documents
    import BackEnd.documents.qa as qa_module

    monkeypatch.delenv("VERCEL", raising=False)
    settings = Settings(_env_file=None, documents_enabled=True, admin_password="virtual-stage-two-password",
                        rag_diagnostics_enabled=True, rag_diagnostics_token=TOKEN,
                        retrieve_top_n=50, dense_top_k=12, keyword_top_k=10, core_evidence_k=4,
                        min_dense_sim=.99, min_rerank_score=.99)
    for module in (api.main, sessions, auth, documents):
        monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(sessions, "_sessions", {})
    monkeypatch.setattr(sessions, "_failures", OrderedDict())
    public, private = components(settings), components(settings, private=True)
    monkeypatch.setitem(api.main.app.dependency_overrides, api.main.get_chat_service, lambda: public)
    repository = Mock(return_value=private.repo)
    factory = Mock(return_value=private)
    monkeypatch.setattr(api.main, "PgServiceRepository", repository)
    monkeypatch.setattr(api.main, "build_chat_service", factory)
    qa = Mock(wraps=answer_document)
    monkeypatch.setattr(api.main, "answer_document", qa)
    monkeypatch.setattr(qa_module, "answer_document", qa)
    return SimpleNamespace(**vars(api), settings=settings, public=public, private=private,
                           qa=qa, repository=repository, factory=factory, documents=documents)


def admin_headers(api):
    response = api.client.post("/api/v1/admin/login", json={"password": "virtual-stage-two-password"})
    assert response.status_code == 200
    return {"Authorization": "Bearer " + response.json()["access_token"]}


@pytest.mark.parametrize("private", [False, True])
def test_chat_and_debug_execute_identical_document_qa_once_per_request(diagnostic_api, private):
    api = diagnostic_api
    headers = admin_headers(api) if private else {}
    body = {"query": "  현재 질문  ", "profile": {"age": 70, "income": "under50", "household": "single", "region": "부산광역시", "disability": False},
            "history": [{"role": "user", "content": "과거 질문"}]}
    chat = api.client.post("/api/v1/chat", headers=headers, json=body)
    debug = api.client.post("/debug/rag", headers={**headers, "X-Rag-Debug-Token": TOKEN}, json=body)
    assert chat.status_code == debug.status_code == 200
    assert chat.json() == debug.json()["response"]
    service = api.private if private else api.public
    assert api.qa.call_count == 2
    for call in api.qa.call_args_list:
        assert call.args == (service.repo, service, "현재 질문")
        assert call.kwargs == {"history":body["history"]}
    assert service.llm.embed.call_count == 2 and service.llm.chat.call_count == 4
    service.llm.chat_text.assert_not_called()
    assert service.answer_with_diagnostics.call_count == service.answer.call_count == 0
    trace = debug.json()["diagnostics"]
    assert trace["mode"] == "document_rag" and trace["scope_document_id"] is None
    assert trace["snapshot"] == "snapshot-9913991234567" and trace["versions"]
    assert trace["retrieval"][0]["dense"] and trace["retrieval"][0]["rrf"]
    assert trace["rerank"][0]["score"] == .01 < api.settings.min_rerank_score
    assert trace["reason"] == "answer" and trace["generation_metadata"]["eval_count"] == 17
    assert set(trace["timings_ms"]) == {"retrieval", "rerank", "generation", "total"}
    assert "991399-1234567" not in chat.json()["text"]
    public_evidence = next(item for item in chat.json()["evidence"] if item["document_id"] == DOC)
    assert public_evidence["chunk_id"] == "public:9913991234567"
    assert public_evidence["source_blocks"] == ["block:9913991234567"]
    assert any(item["document_id"] == PRIVATE_DOC for item in chat.json()["evidence"]) is private
    for prompt in (call for call in service.llm.chat.call_args_list if call.args[0] == PREPARE_SYSTEM):
        assert "과거 질문" in prompt.args[1] and "부산광역시" not in prompt.args[1]
    for prompt in (call for call in service.llm.chat.call_args_list if call.args[0] == ANSWER_SYSTEM):
        assert "과거 질문" in prompt.args[1] and "부산광역시" not in prompt.args[1]
    assert api.repository.call_count == (2 if private else 0)
    if private:
        assert all(call.kwargs == {"documents_enabled": True, "include_local_documents": True} for call in api.repository.call_args_list)
        assert any(item.get("redacted") for item in chat.json()["evidence"])
    assert chat.headers["cache-control"] == debug.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("case", ["disabled", "missing", "wrong", "short_configured", "vercel"])
def test_diagnostic_gate_never_grants_search_permission(diagnostic_api, monkeypatch, case):
    api = diagnostic_api
    headers = {"X-Rag-Debug-Token": TOKEN}
    if case == "disabled":
        monkeypatch.setattr(api.main, "get_settings", lambda: api.settings.model_copy(update={"rag_diagnostics_enabled": False}))
    elif case == "missing":
        headers = admin_headers(api)
    elif case == "wrong":
        headers["X-Rag-Debug-Token"] = "wrong-token"
    elif case == "short_configured":
        monkeypatch.setattr(api.main, "get_settings", lambda: api.settings.model_copy(update={"rag_diagnostics_token": SecretStr("short")}))
        headers["X-Rag-Debug-Token"] = "short"
    else:
        monkeypatch.setenv("VERCEL", "1")
    response = api.client.post("/debug/rag", headers=headers, json={"query": "현재 질문"})
    assert response.status_code == 404 and response.headers["cache-control"] == "no-store"
    api.qa.assert_not_called()
    api.repository.assert_not_called()


@pytest.mark.parametrize("authorization", ["Basic invalid", "Bearer", "Bearer not-a-session", "Bearer " + TOKEN])
def test_invalid_authorization_is_not_silently_downgraded(diagnostic_api, authorization):
    api = diagnostic_api
    for path in ("/api/v1/chat", "/debug/rag"):
        response = api.client.post(path, headers={"Authorization": authorization, "X-Rag-Debug-Token": TOKEN}, json={"query": "현재 질문"})
        assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    api.qa.assert_not_called()
    api.repository.assert_not_called()


def test_expired_admin_session_cannot_open_private_debug(diagnostic_api, monkeypatch):
    import BackEnd.admin.session as sessions
    api = diagnostic_api
    headers = admin_headers(api)
    future = sessions.time.time() + sessions.SESSION_SECONDS + 1
    monkeypatch.setattr(sessions.time, "time", lambda: future)
    response = api.client.post("/debug/rag", headers={**headers, "X-Rag-Debug-Token": TOKEN}, json={"query": "현재 질문"})
    assert response.status_code == 401
    api.qa.assert_not_called()
    api.repository.assert_not_called()


@pytest.mark.parametrize("empty", ["snapshot", "candidates"])
def test_no_evidence_has_matching_fallback_and_one_final_generation(diagnostic_api, empty):
    api = diagnostic_api
    if empty == "snapshot":
        api.public.repo.snapshot.return_value = CatalogSnapshot([], [], "empty")
    else:
        api.public.repo.dense_search.return_value = []
    body = {"query": "ZZZZZZ"}
    chat = api.client.post("/api/v1/chat", json=body)
    debug = api.client.post("/debug/rag", headers={"X-Rag-Debug-Token": TOKEN}, json=body)
    assert chat.status_code == debug.status_code == 200
    assert chat.json() == debug.json()["response"] and chat.json()["kind"] == "fallback"
    assert chat.json()['contacts'] == [] and chat.json()['reason'] == 'no_evidence'
    assert debug.json()["diagnostics"]["reason"] == "no_evidence"
    assert "generation" in debug.json()["diagnostics"]["timings_ms"]
    assert api.public.llm.chat.call_count == 2
    assert all(call.args[0] == EMPTY_EVIDENCE_SYSTEM for call in api.public.llm.chat.call_args_list)
    api.public.llm.chat_text.assert_not_called()
    if empty == "snapshot":
        api.public.llm.embed.assert_not_called()


def test_actual_synthetic_api_contact_dto_is_rendered_and_restored(diagnostic_api):
    import subprocess
    from pathlib import Path
    api=diagnostic_api
    snapshot=api.public.repo.snapshot.return_value
    chunk=replace(snapshot.chunks[0],heading_context='문의처',text='합성 기관 1355',source_url='https://www.example.go.kr/help')
    record=SimpleNamespace(service_id=chunk.service_id,name='합성 복지 서비스',contacts=[])
    api.public.repo.snapshot.return_value=replace(snapshot,services=[record],chunks=[chunk])
    api.public.repo.dense_search.return_value=[replace(chunk,score=.99)]
    response=api.client.post('/api/v1/chat',json={'query':'합성 질문'})
    assert response.status_code==200 and response.json()['kind']=='answer'
    assert response.json()['contacts'][0]['phone']=='1355'
    script=r"""
const assert=require('node:assert/strict');
const {worker,ui}=require('./Extension/tests/conversation_fixture.cjs');
let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>text+=x);process.stdin.on('end',async()=>{
  const body=JSON.parse(text),server=worker(),f=ui(server);
  try{await f.ready();await f.question('합성 질문');await f.answer(body);assert.ok(f.root.querySelector('.conversation a[href="tel:1355"]'));assert.match(f.root.querySelector('.conversation').textContent,/자료 대조일/);}finally{f.close();}
  const restored=ui(server);try{await restored.ready();assert.ok(restored.root.querySelector('.conversation a[href="tel:1355"]'));}finally{restored.close();}
  process.stdout.write('API_DTO_RENDER_RESTORE_OK');
});
"""
    completed=subprocess.run(['node','-e',script],input=response.content,capture_output=True,cwd=Path(__file__).resolve().parents[2],timeout=20)
    assert completed.returncode==0,completed.stderr.decode('utf-8',errors='replace')
    assert completed.stdout==b'API_DTO_RENDER_RESTORE_OK'


@pytest.mark.parametrize("failure,code", [
    ("embedding", "document_embedding_failed"), ("reranker", "document_reranker_failed"),
    ("generation", "document_generation_failed"), ("scope", "document_scope_mismatch"),
    ("snapshot", "document_changed_during_search"), ("digest", "embedding_digest_changed"),
])
def test_real_document_qa_failures_have_matching_status_without_fabricated_trace(diagnostic_api, failure, code, caplog):
    api = diagnostic_api
    service = api.public
    snapshot = service.repo.snapshot.return_value
    for path in ("/api/v1/chat", "/debug/rag"):
        if failure == "embedding":
            service.llm.embed.side_effect = RuntimeError("virtual-private-exception")
        elif failure == "reranker":
            service.reranker.score.side_effect = RuntimeError("virtual-private-exception")
        elif failure == "generation":
            service.llm.chat.side_effect = RuntimeError("virtual-private-exception")
        elif failure == "scope":
            service.repo.document_scope = PRIVATE_DOC
        elif failure == "snapshot":
            service.repo.snapshot.side_effect = [snapshot, replace(snapshot, stamp="changed")]
        else:
            service.llm.model_digest.side_effect = [DIGEST, "changed"]
        response = api.client.post(path, headers={"X-Rag-Debug-Token": TOKEN}, json={"query": "현재 질문"})
        assert response.status_code == 503 and response.json()["detail"] == code
        assert response.headers["cache-control"] == "no-store"
        assert "virtual-private-exception" not in response.text + caplog.text
        if path == "/debug/rag":
            assert response.json() == {"detail": code, "response": None, "diagnostics": None}
    assert api.qa.call_count == 2
    service.answer_with_diagnostics.assert_not_called()


@pytest.mark.parametrize("error", [DocumentError("virtual-private-exception"), RuntimeError("virtual-private-exception")])
def test_unexpected_errors_do_not_export_exception_text(diagnostic_api, error, caplog):
    api = diagnostic_api
    api.qa.side_effect = error
    for path in ("/api/v1/chat", "/debug/rag"):
        response = api.client.post(path, headers={"X-Rag-Debug-Token": TOKEN}, json={"query": "현재 질문"})
        assert response.status_code == 503
        assert "virtual-private-exception" not in response.text + caplog.text
        if path == "/debug/rag":
            assert response.json() == {"detail": "document_service_unavailable", "response": None, "diagnostics": None}


@pytest.mark.parametrize("field", ["query", "history"])
def test_debug_rejects_sensitive_input_before_qa_without_echo(diagnostic_api, field, caplog):
    api = diagnostic_api
    raw = "991399-1234567"
    body = {"query": raw} if field == "query" else {"query": "현재 질문", "history": [{"role": "assistant", "content": raw}]}
    response = api.client.post("/debug/rag", headers={"X-Rag-Debug-Token": TOKEN}, json=body)
    assert response.status_code == 422 and response.json() == {"detail": "sensitive_input"}
    assert response.headers["cache-control"] == "no-store"
    assert raw not in response.text + caplog.text
    api.qa.assert_not_called()


def test_document_query_retains_scope_and_search_does_not_generate(diagnostic_api, monkeypatch):
    from BackEnd.documents.store import get_document_store
    api = diagnostic_api
    headers = admin_headers(api)
    service = api.public
    service.repo.document_scope = DOC
    store = SimpleNamespace(status=lambda _id: ({"test_only": False, "program_test_only": False}, None))
    monkeypatch.setitem(api.main.app.dependency_overrides, get_document_store, lambda: store)
    scoped = Mock(return_value=service.repo)
    monkeypatch.setattr(api.documents, "scoped_repository", scoped)
    monkeypatch.setattr("BackEnd.rag.factory.build_chat_service", lambda *_: service)
    query = api.client.post(f"/api/v1/admin/documents/{DOC}/query", headers=headers, json={"query": "현재 질문"})
    assert query.status_code == 200
    assert query.json()["diagnostics"]["scope_document_id"] == DOC
    assert query.json()["response"]["evidence"][0]["document_id"] == DOC
    assert api.qa.call_count == service.llm.chat.call_count == 1
    service.llm.chat.reset_mock()
    search = api.client.post(f"/api/v1/admin/documents/{DOC}/search", headers=headers, json={"query": "현재 질문"})
    assert search.status_code == 200 and search.json()["chunks"]
    assert all(str(call.args[1]) == DOC for call in scoped.call_args_list)
    service.llm.chat.assert_not_called()
    assert api.qa.call_count == 1


def test_runtime_policy_directly_reports_reference_validation_disabled(monkeypatch):
    from BackEnd import main
    settings=Settings(_env_file=None)
    monkeypatch.setattr(main,'get_settings',lambda:settings)
    monkeypatch.setattr(main,'get_chat_service',lambda:pytest.fail('외부 서비스 호출 금지'))
    qa=main.runtime_settings()['qa']
    assert qa['source_span_validation_enabled'] is False
    assert qa['strict_citation_validation_enabled'] is False
    assert qa['semantic_entailment_verified'] is False

def test_runtime_reports_effective_document_policy_without_external_calls(diagnostic_api, monkeypatch):
    api = diagnostic_api
    blocked = Mock(side_effect=AssertionError("설정 조회에서 실행 의존성을 사용했습니다."))
    monkeypatch.setattr(api.main, "get_chat_service", blocked)
    response = api.client.get("/health/runtime")
    assert response.status_code == 200
    body = response.json()
    assert body["configuration_only"] is True and body["readiness_checked"] is False
    assert body["qa"] == {"mode": "document_rag", "policy": "welfare_document_evidence", "profile_supported": True,
                          "profile_requires_consent": True, "profile_usage_stage": "generation_only",
                          "history_supported": True, "conversation_summary_supported": True,
                          "usage_is_request_specific": True, "strict_citation_validation_enabled": False,
                          "source_span_validation_enabled": False, "semantic_entailment_verified": False}
    assert body["retrieval"]["candidate_limit"] == api.public.top_n == 40 < api.settings.retrieve_top_n
    assert body["retrieval"]["dense_limit"] == api.public.dense_k
    assert body["retrieval"]["keyword_limit"] == api.public.keyword_k
    assert body["retrieval"]["core_evidence_limit"] == api.public.core_k
    assert body["retrieval"]["min_dense_similarity"] == body["retrieval"]["dense_threshold"]["configured"] == .99
    assert body['retrieval']['dense_threshold']=={'configured':.99,'enabled':True,'effective':.99,'stage':'hybrid_union'}
    assert body["reranker"]["min_score"] == body["reranker"]["score_threshold"]["configured"] == .99
    assert body["reranker"]["score_threshold"]["enabled"] is False and body["reranker"]["score_threshold"]["effective"] is None
    for dependency in (api.qa, api.repository, api.factory, api.public.llm.embed, api.public.llm.chat_text, blocked):
        dependency.assert_not_called()


def test_chat_and_diagnostics_share_summary_input_and_safe_failure_update(diagnostic_api):
    api = diagnostic_api
    context = {"text":"", "coveredThroughMessageId":None, "profileRevision":1,
               "batch":[{"id":"A"*20+":"+role,"role":role,"content":"합성 대화 주제"} for role in ("user","assistant")], "omitted":False}
    payload = {"query":"그 서비스는?", "conversation_context":context}
    chat = api.client.post("/api/v1/chat", json=payload)
    debug = api.client.post("/debug/rag", headers={"X-Rag-Debug-Token":TOKEN}, json=payload)
    assert chat.status_code == debug.status_code == 200 and chat.json() == debug.json()["response"]
    assert chat.json()['context_update']['status'] in ('unchanged','omitted')
    assert chat.json()['context_update']['coveredThroughMessageId'] is None
    assert all(call.kwargs["conversation_context"] == context for call in api.qa.call_args_list)
    api.public.llm.chat_text.assert_not_called()
    assert api.public.llm.chat.call_count == 4
    assert "합성 대화 주제" not in json.dumps(debug.json()["diagnostics"],ensure_ascii=False)
