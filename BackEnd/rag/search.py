"""활성 스냅샷에만 종속되는 한국어 본문 BM25와 순위 결합."""

import math
import re
import unicodedata
from collections import Counter
from threading import Lock

from BackEnd.rag.evidence import EvidenceChunk


class KoreanAnalyzer:
    def __init__(self):
        self._kiwi = None
        self._lock = Lock()

    def __call__(self, text: str) -> list[str]:
        with self._lock:
            if self._kiwi is None:
                from kiwipiepy import Kiwi

                self._kiwi = Kiwi(num_workers=1)
            normalized = unicodedata.normalize("NFC", text).lower()
            return [token.form for token in self._kiwi.tokenize(normalized)
                    if token.tag.startswith(("N", "V", "M", "SL", "SN", "XR"))]


class BM25Index:
    def __init__(self, chunks: list[EvidenceChunk], names: dict[str, str], analyzer):
        self.chunks, self.analyzer = chunks, analyzer
        self.documents = [Counter(analyzer(
            names[c.service_id] + " " + c.section + " " + c.heading_context + " " + c.text)) for c in chunks]
        self.lengths = [sum(document.values()) for document in self.documents]
        self.average = sum(self.lengths) / max(1, len(chunks)) or 1
        self.frequency = Counter(term for document in self.documents for term in document)

    def search(self, query: str, k: int, allowed: set[str]) -> list[tuple[EvidenceChunk, float]]:
        terms = set(self.analyzer(query))
        ranked = []
        for chunk, document, length in zip(self.chunks, self.documents, self.lengths):
            if chunk.chunk_id not in allowed:
                continue
            score = 0.0
            for term in terms & document.keys():
                inverse = math.log(1 + (len(self.chunks) - self.frequency[term] + 0.5) / (self.frequency[term] + 0.5))
                frequency = document[term]
                score += inverse * frequency * 2.5 / (frequency + 1.5 * (0.25 + 0.75 * length / self.average))
            if score > 0:
                ranked.append((chunk, score))
        return sorted(ranked, key=lambda item: (-item[1], item[0].chunk_id))[:k]


def reciprocal_ranks(rankings: list[list[EvidenceChunk]]) -> list[tuple[EvidenceChunk, float]]:
    chunks, scores = {}, Counter()
    for ranking in rankings:
        for rank, chunk in enumerate(ranking, 1):
            chunks[chunk.chunk_id] = chunk
            scores[chunk.chunk_id] += 1 / (60 + rank)
    return [(chunks[cid], scores[cid]) for cid in sorted(scores, key=lambda cid: (-scores[cid], cid))]


def fair_candidates(rankings: list[list[EvidenceChunk]], limit: int = 40) -> list[EvidenceChunk]:
    # 의도별 순회로 동등한 기회를 주고 빈 의도의 몫은 남은 의도에 재배분한다.
    selected, seen = [], set()
    for index in range(max((len(r) for r in rankings), default=0)):
        for ranking in rankings:
            if index < len(ranking) and ranking[index].chunk_id not in seen:
                seen.add(ranking[index].chunk_id)
                selected.append(ranking[index])
                if len(selected) == limit:
                    return selected
    return selected


def query_intents(query: str) -> list[tuple[str, set[str]]]:
    kinds = []
    if re.search(r"신청|접수|서류|절차|어디서", query):
        kinds.append(("application", {"application"}))
    if re.search(r"자격|대상|조건|받을|받나요|지원되|가능|해당|제외|중복", query):
        kinds.append(("eligibility", {"target", "criteria"}))
    if re.search(r"얼마|금액|만원|지원내용|지원 내용|혜택|지급|지원액|수급액|감액|언제부터|기간", query):
        kinds.append(("benefit", {"benefit"}))
    return kinds or [("overview", set())]
