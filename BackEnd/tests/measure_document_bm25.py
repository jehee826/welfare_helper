"""합성 메모리 자료의 반복 BM25 비용만 측정한다. DB·모델·Kiwi를 사용하지 않는다."""

import hashlib
import json
import re
from time import process_time
from types import SimpleNamespace
from unittest.mock import patch

from BackEnd.documents import qa
from BackEnd.rag.evidence import EvidenceChunk
from BackEnd.rag.repository import CatalogSnapshot


class CountingAnalyzer:
    def __init__(self):
        self.document_calls = 0
        self.query_calls = 0

    def __call__(self, text):
        if text.startswith("합성원문 "):
            self.document_calls += 1
        else:
            self.query_calls += 1
        return re.findall(r"[가-힣A-Za-z0-9]+", text.lower())


def components(size):
    chunks = [EvidenceChunk(f"chunk-{i:04}", "S", "content", f"가상 검색 항목 {i}의 합성 설명입니다.", "",
                            document_id=f"document-{i}", document_name="합성원문", embed_digest="synthetic")
              for i in range(size)]
    snapshot = CatalogSnapshot([], chunks, f"synthetic-{size}")
    calls = {"snapshot": 0}

    def current():
        calls["snapshot"] += 1
        return snapshot

    def generate(_system, user, **_kwargs):
        sources = json.loads(user.split("문서 근거(JSON):\n")[1].split("\n\n질문:")[0])
        first = sources[0]["chunks"][0]
        return {"status": "answer", "text": "합성 원문을 확인했습니다.",
                "citations": [{"id": first["id"], "quote": first["text"]}]}

    repo = SimpleNamespace(snapshot=current, document_scope=None, include_local_documents=False,
                           embed_model="synthetic", embed_dim=1024,
                           dense_search=lambda _v, k, allowed, *, snapshot: [c for c in snapshot.chunks if c.chunk_id in allowed][:k])
    llm = SimpleNamespace(context_limit=lambda: 32768, model_digest=lambda: "synthetic",
                          embed=lambda texts: [[.1] * 1024 for _ in texts], chat=generate,
                          input_cost=lambda system, user: len((system + user).encode()), last_chat_diagnostics={})
    service = SimpleNamespace(llm=llm, analyzer=CountingAnalyzer(), dense_k=30, keyword_k=30, top_n=40, core_k=6,
                              reranker=SimpleNamespace(score=lambda _q, passages: [.1] * len(passages)))
    return repo, service, snapshot, calls


def measure(size, repetitions=5):
    repo, service, _, calls = components(size)
    original, builds, build_cpu = qa.BM25Index, 0, 0.0
    rankings = []

    def construct(*args):
        nonlocal builds, build_cpu
        start = process_time()
        index = original(*args)
        build_cpu += process_time() - start
        builds += 1
        return index

    start = process_time()
    with patch.object(qa, "BM25Index", construct):
        for _ in range(repetitions):
            response, trace = qa.answer_document(repo, service, "가상 검색 항목")
            assert response["kind"] == "answer"
            rankings.append(trace["retrieval"][0]["keyword"])
    assert all(ranking == rankings[0] for ranking in rankings)
    return {"chunks": size, "requests": repetitions, "index_builds": builds,
            "document_analyses": service.analyzer.document_calls, "query_analyses": service.analyzer.query_calls,
            "snapshot_checks": calls["snapshot"], "cpu_ms": round((process_time() - start) * 1000, 3),
            "index_cpu_ms": round(build_cpu * 1000, 3),
            "ranking_sha256": hashlib.sha256(json.dumps(rankings[0], sort_keys=True).encode()).hexdigest(),
            "top_ids": [row["chunk_id"] for row in rankings[0][:5]]}


if __name__ == "__main__":
    print(json.dumps([measure(100), measure(1000)], ensure_ascii=False, indent=2))
