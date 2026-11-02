"""수동 실행 전용: 로컬 기존 모델 + 합성 원문 + 메모리 저장소로 QA를 검증한다.

환경 파일·Supabase·제품 Chrome 저장소는 사용하지 않는다. 실행 결과는 stdout JSON이다.
"""

import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time
from unittest.mock import patch
from urllib.parse import urlparse

from BackEnd.core.execution import inference_request
from BackEnd.core.settings import Settings
from BackEnd.documents.context import PREPARE_SYSTEM
from BackEnd.documents.qa import answer_document
from BackEnd.rag.chat import ChatService
from BackEnd.rag.evidence import EvidenceChunk
from BackEnd.rag.ollama import OllamaClient
from BackEnd.rag.repository import CatalogSnapshot, PgServiceRepository
from BackEnd.rag.reranker import LocalReranker


ROOT = Path(__file__).resolve().parents[2]
SYNTHETIC_DOCUMENTS = [
    ("SYNTH_SINGLE", "한빛 1인가구 상담지원", "합성 평가용 문서이며 실제 복지제도가 아니다. "
     "한빛 1인가구 상담지원은 서울특별시에 사는 1인가구의 생활 상담을 위한 가상 서비스다. "
     "신청처는 한빛상담센터 1층 방문접수 창구다. 온라인 접수 경로는 이 자료에 기재되어 있지 않다. "
     "준비 자료는 본인확인증과 1인가구 현황 확인서다. 접수는 평일 오전 9시부터 오후 4시까지이며 공휴일은 제외한다. "
     "지원금액이나 소득 판정기준은 이 자료에 없다."),
    ("SYNTH_FAMILY", "바다 다인가구 상담지원", "합성 평가용 문서이며 실제 복지제도가 아니다. "
     "바다 다인가구 상담지원은 서울특별시의 자녀와 함께 사는 가구를 위한 가상 생활 상담 서비스다. "
     "신청처는 바다주민센터 2층 가족상담 창구다. 준비 자료는 가족 현황 확인서다. "
     "접수는 평일 오후 1시부터 오후 5시까지다. 1인가구를 대상으로 하지 않는다. "
     "지원금액이나 소득 판정기준은 이 자료에 없다."),
]


class MemoryDocuments(PgServiceRepository):
    def __init__(self, snapshot):
        def no_database():
            raise AssertionError("이 하네스는 DB에 연결하지 않는다.")
        super().__init__(no_database, include_local_documents=True)
        self.current = snapshot

    def snapshot(self):
        return self.current


def bridge(operation, data, **values):
    result = subprocess.run(["node", str(ROOT / "Extension/tests/live_context_bridge.cjs")],
                            input=json.dumps({"operation": operation, "data": data, **values}, ensure_ascii=False),
                            encoding="utf-8", capture_output=True, cwd=ROOT, timeout=20)
    if result.returncode:
        raise RuntimeError("storage_bridge_" + result.stderr[:120])
    return json.loads(result.stdout)


def main():
    # 실행기가 이 시험 전용 환경값만 주입한다. Settings()와 dotenv를 호출하지 않는다.
    base_url = os.environ.get("T3_LIVE_OLLAMA_URL", "")
    model = os.environ.get("T3_LIVE_MODEL", "")
    embed_model = os.environ.get("T3_LIVE_EMBED_MODEL", "")
    parsed = urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port != 11434 or not model or not embed_model:
        raise RuntimeError("explicit_local_test_configuration_required")
    total_seconds = min(1800, int(os.environ.get("T3_LIVE_TOTAL_SECONDS", "1800")))
    request_seconds = min(600, int(os.environ.get("T3_LIVE_REQUEST_SECONDS", "600")))
    selected_cases = os.environ.get("T3_LIVE_CASES", "all")
    if total_seconds < 1 or request_seconds < 1:
        raise RuntimeError("invalid_test_deadline")
    started = time.monotonic()
    llm = OllamaClient(base_url, embed_model, model, request_seconds,
                       {"temperature": 0, "num_ctx": 8192, "num_predict": 512, "num_thread": 2})
    defaults = Settings.model_fields
    reranker = LocalReranker(defaults["rerank_model"].default, defaults["rerank_revision"].default,
                            str(ROOT / ".reranker_cache"), threads=2)
    reranker.model_files()
    with inference_request(None, request_seconds):
        digest = llm.model_digest()
        chunks = [EvidenceChunk("synthetic:" + str(index), sid, "content", text, "https://example.invalid/" + sid,
                                document_id=f"00000000-0000-0000-0000-{index:012d}", document_name=name,
                                embed_digest=digest, page_refs=(1,), source_blocks=(f"#/texts/{index}",), test_only=True)
                  for index, (sid, name, text) in enumerate(SYNTHETIC_DOCUMENTS, 1)]
        vectors = llm.embed([chunk.embedding_text() for chunk in chunks])
    snapshot = CatalogSnapshot([], chunks, "synthetic-t3-live-v1", embeddings={c.chunk_id: v for c, v in zip(chunks, vectors, strict=True)})
    repo = MemoryDocuments(snapshot)
    service = ChatService(repo, llm, defaults["min_dense_sim"].default, defaults["retrieve_top_n"].default,
                          reranker=reranker, dense_k=defaults["dense_top_k"].default,
                          keyword_k=defaults["keyword_top_k"].default, core_k=defaults["core_evidence_k"].default)
    profile = {"age":70,"income":"unknown","household":"single","region":"서울특별시","disability":None}
    data = None
    questions = [
        "테스트 자료에서 내 조건에 맞는 생활 상담 서비스 한 가지를 두 문장으로 알려줘.",
        "그 서비스는 어디에서 신청해? 짧게 알려줘.",
        "혼자 살고 있어. 앞에서 말한 서비스의 대상과 맞는지 자료 기준으로 알려줘.",
        "그 서비스 온라인 신청도 가능한지 자료에 있어?",
        "방문할 때 준비할 것은?",
        "공휴일에도 접수할 수 있어?",
        "앞에서 말한 그 서비스 신청처와 준비 자료를 다시 짧게 알려줘.",
        "지금 조건에서 어떤 합성 서비스가 맞는지 다시 두 문장으로 찾아줘.",
        "그 서비스 신청은 어디에서 해?",
        "합성 한빛 서비스는 공휴일에도 접수할 수 있어? 문서의 접수 시간을 확인해줘.",
    ]
    replayed = 0
    if selected_cases in {"resume", "reuse"}:
        previous = json.load(sys.stdin)
        required = 7 if selected_cases == "reuse" else 6
        if len(previous) != required or [row.get("case") for row in previous] != list(range(1,required+1)):
            raise RuntimeError("actual_case_results_required")
        # 이전 실제 응답만 재사용한다. 정답을 만들거나 새 생성 프롬프트에 주입하지 않는다.
        by_id = {chunk.chunk_id:chunk for chunk in chunks}
        for row in previous:
            pair_id=f'{row["case"]:020X}'
            planned=bridge("prepare",data,pairId=pair_id,profile=profile)
            references=[by_id[cid] for cid in row["evidence_ids"]]
            response={"kind":row["kind"],"text":row["text"],"evidence":[
                {"chunk_id":c.chunk_id,"document_id":c.document_id,"role":"retrieved","quote":"","context":c.text,
                 "text":c.text,"pages":list(c.page_refs),"source_blocks":list(c.source_blocks),"source_url":c.source_url,"heading_context":c.heading_context}
                for c in references]}
            for field in ("context_update","context_usage"):
                if row.get(field) is not None:
                    response[field]=row[field]
            data=bridge("commit",planned["data"],pairId=pair_id,question=questions[row["case"]-1],answer=response,submitted=planned["input"])["data"]
        replayed=required
    if selected_cases == "first":
        questions = questions[:1]
    elif selected_cases == "reuse":
        questions = questions[:7]+[questions[5]]
    elif selected_cases != "resume":
        questions = questions[:9]
    original_embed, original_chat, original_structured = OllamaClient.embed, OllamaClient.chat_text, OllamaClient.chat
    events = []
    def observe_embed(client, texts):
        events.append({"stage":"embedding", "query":texts})
        return original_embed(client, texts)
    def observe_chat(client, system, user):
        stage = "preparation" if system == PREPARE_SYSTEM else "answer"
        event = {"stage":stage}; events.append(event)
        value = original_chat(client, system, user)
        if stage == "preparation":
            event["output"] = value
        return value
    def observe_structured(client, system, user, **options):
        event={"stage":"preparation","structured":True};events.append(event)
        value=original_structured(client,system,user,**options)
        event["output"]=value
        return value
    emit = lambda value: print(json.dumps(value, ensure_ascii=False), flush=True)
    emit({"type":"setup", "model":model,"embed_model":embed_model,"embedding_digest":digest,
          "context_source_sha256":hashlib.sha256((ROOT/"BackEnd/documents/context.py").read_bytes()).hexdigest(),
          "documents":len(chunks),"actual_embeddings":True,"actual_reranker":True,
          "database_calls":0,"chrome_used":False,"scenario":selected_cases,"replayed_actual_responses":replayed,"timeout_seconds":request_seconds,"total_seconds":total_seconds})
    for index, question in enumerate(questions, 1):
        if index <= replayed:
            continue
        if index == 8 and selected_cases != "reuse":
            profile = {**profile,"household":"withChildren"}
            data = bridge("profile", data, profile=profile)["data"]
        pair_id = f"{index:020X}"
        plan = bridge("prepare", data, pairId=pair_id, profile=profile)
        data = plan["data"]
        submitted = plan["input"]
        remaining = total_seconds-(time.monotonic()-started)
        if remaining <= 0:
            emit({"type":"stopped","case":index,"reason":"total_deadline"}); break
        events.clear()
        emit({"type":"case_start","case":index,"question":question,
              "profile_revision":data["gyeote.profile"]["revision"],"history_messages":len(submitted["history"]),
              "batch_messages":len(submitted["conversation_context"]["batch"]),
              "summary_sent":bool(submitted["conversation_context"]["text"]),"context_omitted":submitted["conversation_context"]["omitted"]})
        turn_started = time.monotonic()
        try:
            with patch.object(OllamaClient,"embed",observe_embed), patch.object(OllamaClient,"chat_text",observe_chat), patch.object(OllamaClient,"chat",observe_structured):
                with inference_request(None, min(request_seconds, remaining)):
                    response, trace = answer_document(repo, service, question, profile=profile, **submitted)
            saved = bridge("commit", data, pairId=pair_id, question=question, answer=response, submitted=submitted)
            data = saved["data"]
            conversation = saved["restored"]["conversations"][0]
            emit({"type":"case_result","case":index,"seconds":round(time.monotonic()-turn_started,2),
                  "kind":response["kind"],"text":response["text"],"evidence_ids":[e["chunk_id"] for e in response.get("evidence",[])],
                  "context_update":response.get("context_update"),"context_usage":response.get("context_usage"),
                  "events":events,"context_trace":trace.get("context"),"budget":trace.get("budget"),
                  "stored_messages":len(conversation["messages"]),"stored_summary":conversation.get("summary"),
                  "worker_recreated_read":True})
        except Exception as error:
            emit({"type":"case_error","case":index,"seconds":round(time.monotonic()-turn_started,2),
                  "error_type":type(error).__name__,"safe_code":getattr(error,"detail",None),"events":events})
            break
    emit({"type":"finished","seconds":round(time.monotonic()-started,2),"stored_messages":len(data.get("gyeote.conversations",{}).get("conversations",[{}])[0].get("messages",[])) if data else 0,
          "database_calls":0,"chrome_used":False})


if __name__ == "__main__":
    main()
