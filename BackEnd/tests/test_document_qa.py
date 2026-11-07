from dataclasses import replace
import json
import re
from types import SimpleNamespace

import pytest

from BackEnd.documents.contracts import DocumentError
from BackEnd.documents.qa import answer_document
from BackEnd.rag.evidence import EvidenceChunk
from BackEnd.rag.repository import CatalogSnapshot


DOC_ID = "00000000-0000-0000-0000-000000000001"


def components(*, empty=False, failure=None):
    chunk = EvidenceChunk("source:1", "PROGRAM_1", "content", "평균 절대 오차 MAE는 150만 원입니다.", "",
                          document_id=DOC_ID, document_name="선택 PDF", embed_digest="digest", page_refs=(2,), source_blocks=("b1",))
    snapshot = CatalogSnapshot([], [] if empty else [chunk], "snapshot")
    calls = {"prompts": [], "embeddings": 0}

    def embed(texts):
        calls["embeddings"] += 1
        if failure == "embedding":
            raise RuntimeError("private error")
        return [[0.1] * 1024 for _ in texts]

    def generate(system, user):
        calls["prompts"].append((system, user))
        if failure == "generation":
            raise RuntimeError("private prompt")
        sources = json.loads(user.split('문서 근거(JSON):\n')[1].split('\n\n질문:')[0])
        documents = [chunk for source in sources for chunk in source['chunks']]
        if not documents:
            return json.dumps({'status':'no_evidence','text':'등록된 자료에서 확인하지 못했습니다.'},ensure_ascii=False)
        text = '원문에 따르면 평균 오차는 150만 원입니다.' if '150만 원' in documents[0]['text'] else '자료의 조건과 예외를 확인해 주세요.'
        return json.dumps({'status':'answer', 'text':text}, ensure_ascii=False)

    def rerank(_query, passages):
        if failure == "reranker":
            raise RuntimeError("private passage")
        return [0.01] * len(passages)

    def dense(vector, k, allowed_ids, *, snapshot):
        assert len(vector) == 1024 and allowed_ids == [chunk.chunk_id]
        assert snapshot.chunks[0].document_id == DOC_ID
        return [replace(chunk, score=0.65)][:k]

    repo = SimpleNamespace(document_scope=DOC_ID, snapshot=lambda: snapshot, dense_search=dense)
    service = SimpleNamespace(llm=SimpleNamespace(model_digest=lambda: "digest", embed=embed, chat_text=generate,
                                                 context_limit=lambda: 32768, input_cost=lambda system,user: len((system+user).encode()),
                                                 last_chat_diagnostics={"done_reason": "stop", "eval_count": 20}),
                              reranker=SimpleNamespace(score=rerank), dense_k=30, keyword_k=30, top_n=40, core_k=6,
                              analyzer=lambda text: re.findall(r"[가-힣A-Za-z0-9]+", text.lower()))
    service.min_similarity = .52
    service.llm.chat = lambda system,user,**kwargs:json.loads(service.llm.chat_text(system,user))
    return repo, service, calls


def test_model_selected_reference_retains_same_document_conditions_and_omits_other_sources():
    repo, service, _ = components()
    first = replace(repo.snapshot().chunks[0], text="사업 조건입니다.\n- 문의: 테스트 담당 기관 1355",
                    source_url="https://www.bokjiro.go.kr/selected-source")
    condition = replace(first, chunk_id="source:condition", text="이 사업의 제외 조건입니다.", heading_context="제외·예외")
    other = replace(first, chunk_id="source:other", document_id="00000000-0000-0000-0000-000000000002",
                    service_id="PROGRAM_2", document_name="다른 사업", text="다른 사업 원문입니다.")
    snapshot = replace(repo.snapshot(), chunks=[first, condition, other])
    repo.document_scope = None
    repo.snapshot = lambda: snapshot
    repo.dense_search = lambda *args, **kwargs: [replace(chunk, score=.65) for chunk in snapshot.chunks]
    def generate(system, user, **kwargs):
        sources = json.loads(user.split('문서 근거(JSON):\n')[1].split('\n\n질문:')[0])
        source = next(item for item in sources if item['document_id'] == DOC_ID)
        ids = {chunk['id'] for item in sources for chunk in item['chunks']}
        assert set(kwargs['schema']['properties']['source_ids']['items']['enum']) == ids
        assert 'source_ids' in kwargs['schema']['required']
        return {'status': 'answer', 'text': '선택 원문의 조건을 안내합니다.', 'source_ids': [source['chunks'][0]['id']]}
    service.llm.chat = generate
    answer, trace = answer_document(repo, service, "선택 자료의 조건을 알려주세요")
    assert answer['kind'] == 'answer'
    assert {item['chunk_id'] for item in answer['evidence']} == {first.chunk_id, condition.chunk_id}
    assert {item['document_id'] for item in answer['evidence']} == {DOC_ID}
    assert [item['phone'] for item in answer['contacts']] == ['1355']
    assert trace['source_reference_selection'] == 'model_selected_document_versions'


@pytest.mark.parametrize('selection', [[], ['C999'], ['C1', 'C1']])
def test_invalid_explicit_answer_reference_selection_does_not_publish_evidence(selection):
    repo, service, _ = components()
    service.llm.chat = lambda *args, **kwargs: {'status': 'answer', 'text': '합성 답변', 'source_ids': selection}
    answer, trace = answer_document(repo, service, "선택 자료의 조건을 알려주세요")
    assert answer['reason'] == 'invalid_evidence_answer'
    assert answer['evidence'] == [] and answer['contacts'] == []
    assert trace['answer_validation'] == 'invalid_answer'


@pytest.mark.parametrize(('score','expected'),[(.519999,'no_evidence'),(.52,'answer'),(.520001,'answer')])
def test_document_similarity_threshold_includes_equal_and_withholds_facts_below(score,expected):
    repo,service,calls=components()
    original=repo.dense_search
    repo.dense_search=lambda *args,**kwargs:[replace(c,score=score) for c in original(*args,**kwargs)]
    response,trace=answer_document(repo,service,'MAE 평균 오차')
    assert trace['reason']==expected
    assert len(calls['prompts'])==1
    assert response['kind']==('fallback' if expected=='no_evidence' else 'answer')
    if expected=='no_evidence':
        assert trace['retrieval_reason']=='low_similarity' and response['evidence']==[]


def test_keyword_only_candidate_uses_same_snapshot_cosine_before_reranking(monkeypatch):
    from BackEnd.documents import qa
    repo,service,calls=components();first=repo.snapshot().chunks[0]
    second=replace(first,chunk_id='source:2',text='키워드 원문',ordinal=1)
    snapshot=CatalogSnapshot([], [first,second], 'fixed');repo.snapshot=lambda:snapshot
    scans=[]
    def dense(vector,k,allowed_ids,*,snapshot):
        scans.append((k,set(allowed_ids),snapshot))
        return [replace(first,score=.9),replace(second,score=.75)]
    repo.dense_search=dense;service.dense_k=1
    class Index:
        def search(self,*args):return [(second,2.0)]
    monkeypatch.setattr(qa,'_document_keyword_index',lambda *_:(Index(),None))
    response,trace=answer_document(repo,service,'키워드 원문')
    assert scans==[(2,{first.chunk_id,second.chunk_id},snapshot)]
    assert any(item['chunk_id']==second.chunk_id for item in trace['retrieval'][0]['rrf'])
    assert any(item['chunk_id']==first.chunk_id for item in trace['retrieval'][0]['rrf'])
    assert response['kind']=='answer' and len(calls['prompts'])==1

def test_low_similarity_followup_allows_one_prepare_and_one_scope_response():
    from BackEnd.documents.context import PREPARE_SYSTEM,EMPTY_EVIDENCE_SYSTEM
    repo,service,calls=components();original=repo.dense_search
    repo.dense_search=lambda *args,**kwargs:[replace(c,score=.1) for c in original(*args,**kwargs)]
    seen=[]
    def chat(system,user,**kwargs):
        seen.append(system)
        if system==PREPARE_SYSTEM:
            payload=json.loads(user)
            return {'relation':'followup','search_query':'합성 지원 금액','source_ids':[s['id'] for s in payload['sources']],
                    'document_ids':[],'needs_clarification':False}
        assert system==EMPTY_EVIDENCE_SYSTEM and '합성 지원 금액' in user
        return {'status':'no_evidence','text':'등록된 자료에서 확인하지 못했습니다.'}
    service.llm.chat=chat
    result,trace=answer_document(repo,service,'얼마인가요?',history=[{'role':'user','content':'합성 지원'}])
    assert result['reason']=='no_evidence' and trace['retrieval_reason']=='low_similarity'
    assert seen==[PREPARE_SYSTEM,EMPTY_EVIDENCE_SYSTEM] and calls['prompts']==[]

def test_passing_hybrid_candidates_keep_original_rrf_order(monkeypatch):
    from BackEnd.documents import qa
    from BackEnd.rag.search import reciprocal_ranks
    repo,service,_=components();first=repo.snapshot().chunks[0]
    second=replace(first,chunk_id='source:2',ordinal=1,text='추가 원문')
    snapshot=CatalogSnapshot([], [first,second], 'fixed');repo.snapshot=lambda:snapshot
    scored=[replace(first,score=.9),replace(second,score=.7)]
    repo.dense_search=lambda *_args,**_kwargs:scored
    class Index:
        def search(self,*_args):return [(second,2.0),(first,1.0)]
    monkeypatch.setattr(qa,'_document_keyword_index',lambda *_:(Index(),None))
    _,trace=answer_document(repo,service,'합성 질문')
    actual=trace['retrieval'][0]['rrf'];expected=reciprocal_ranks([scored,[second,first]])
    assert [(item['chunk_id'],item['score']) for item in actual]==[(chunk.chunk_id,score) for chunk,score in expected]

@pytest.mark.parametrize('case',['missing','nan','outside'])
def test_missing_invalid_or_outside_cosine_is_technical_failure(monkeypatch,case):
    from BackEnd.documents import qa
    repo,service,calls=components();first=repo.snapshot().chunks[0]
    if case=='missing':
        repo.dense_search=lambda *_args,**_kwargs:[]
        class Index:
            def search(self,*args):return [(first,1.0)]
        monkeypatch.setattr(qa,'_document_keyword_index',lambda *_:(Index(),None))
    else:
        repo.dense_search=lambda *_args,**_kwargs:[replace(first,score=float('nan')) if case=='nan' else replace(first,chunk_id='outside',score=.9)]
    with pytest.raises(DocumentError,match='document_embedding_failed'):answer_document(repo,service,'질문')
    assert calls['prompts']==[]


def test_plain_document_rag_uses_ranked_source_without_rerank_cutoff_or_fact_selection():
    repo, service, calls = components()
    response, trace = answer_document(repo, service, "MAE 평균 오차는 얼마인가요?")
    assert response["kind"] == "answer" and "150만 원" in response["text"]
    assert calls["prompts"][0][1].endswith("질문: MAE 평균 오차는 얼마인가요?")
    assert "평균 절대 오차 MAE는 150만 원입니다." in calls["prompts"][0][1]
    assert response["evidence"][0]["role"] == "retrieved" and response["evidence"][0]["quote"] == ''
    assert response["evidence"][0]["document_id"] == DOC_ID and response["evidence"][0]["pages"] == [2]
    assert trace["rerank"][0]["score"] == 0.01 and trace["rerank"][0]["selected"]
    assert trace["retrieval"][0]["keyword"] and trace["generation_metadata"]["done_reason"] == "stop"


def test_no_source_is_not_reported_as_a_successful_model_answer():
    repo, service, calls = components(empty=True)
    response, trace = answer_document(repo, service, "무엇인가요?")
    assert response["kind"] == "fallback" and response["reason"] == "no_evidence"
    assert calls["embeddings"] == 0 and len(calls["prompts"]) == 1
    assert trace["reason"] == "no_evidence" and trace["retrieval_reason"] == "no_document_evidence"


@pytest.mark.parametrize("failure", ["embedding", "reranker", "generation"])
def test_real_model_stage_failure_is_exposed_as_a_safe_failure(failure):
    repo, service, _ = components(failure=failure)
    with pytest.raises(DocumentError, match=f"^document_{failure}_failed$"):
        answer_document(repo, service, "질문")


def test_unscoped_qa_searches_all_documents_and_scoped_qa_rejects_other_sources():
    repo, service, calls = components()
    repo.document_scope = None
    response, trace = answer_document(repo, service, "질문")
    assert response["kind"] == "answer" and trace["scope_document_id"] is None
    assert len(calls["prompts"]) == 1
    calls["prompts"].clear()
    repo.document_scope = "00000000-0000-0000-0000-000000000002"
    with pytest.raises(DocumentError, match="document_scope_mismatch"):
        answer_document(repo, service, "질문")
    assert calls["prompts"] == []
