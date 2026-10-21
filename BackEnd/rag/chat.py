import re
import time
from typing import Protocol

from BackEnd.ingest.csv_loader import ServiceRecord
from BackEnd.rag.ollama import OllamaError
from BackEnd.rag.text import name_key

GENERAL_CONTACT = {"label": "보건복지상담센터", "phone": "129"}
MAX_CARDS = 3
MAX_PINS = 3
MIN_KEY_LENGTH = 3
KEYWORD_MIN_SCORE = 3
SERVICES_TTL_SECONDS = 300

INCOME_LABELS = {
    "under50": "기준중위소득 50% 이하",
    "under100": "기준중위소득 50~100%",
    "under150": "기준중위소득 100~150%",
    "over150": "기준중위소득 150% 초과",
    "unknown": "소득 구간 모름",
}
HOUSEHOLD_LABELS = {
    "single": "혼자 살아요",
    "couple": "부부",
    "withChildren": "자녀가 있어요",
    "singleParent": "한부모 가정",
    "grandparent": "조부모와 손자녀",
    "other": "기타 가구",
}
STOPWORDS = {
    "지원", "서비스", "받을", "있는", "있나요", "있을까요", "어떻게", "방법", "신청", "문의처", "문의",
    "다른", "알려줘", "알려주세요", "조건", "자격", "대상", "제가", "저는", "필요해요", "궁금해요", "어떤", "무엇",
}
PARTICLES = ["에서", "으로", "이요", "해요", "이", "가", "을", "를", "은", "는", "에", "의", "도", "요", "로", "와", "과"]
PHONE_IN_TEXT = re.compile(r"\d{2,4}-\d{3,4}(?:-\d{4})?|(?<!\d)1\d{2,3}(?![\d\w])")
NUMBER_WITH_UNIT = re.compile(r"\d[\d,.]*\s*(?:만\s*원|천\s*원|원|세|살|%|퍼센트|개월|년|주|일|회|명)")
PARENTHESES = re.compile(r"\([^)]*\)")

SYSTEM_PROMPT = """너는 사회복지관의 복지서비스 안내 도우미다. 다음 규칙을 반드시 지킨다.
1. [참고 자료]의 문장에 있는 내용만 사용한다. 자료에 없는 나이 기준, 지원 금액, 소득 기준, 신청 기간, 전화번호, 링크는 사실이라고 알고 있어도 쓰지 않는다.
2. 이용자가 서비스를 받을 수 있다고 단정하지 않는다. 실제 대상 여부는 담당 기관에서 확인하라고 안내한다.
3. 질문과 관련 있는 자료만 골라 서비스 이름을 자료에 적힌 그대로 언급한다. 관련 없는 자료는 언급하지 않는다.
4. 인사말과 호칭 없이 바로 답한다. 이용자를 '어르신'이라고 부르지 않는다.
5. 쉬운 존댓말로 2~4문장 안에 답한다.
6. 마크다운, 목록 기호, 표, 줄바꿈 없이 한 단락의 평문으로 쓴다."""


class ServiceRepository(Protocol):
    def all_services(self) -> list[ServiceRecord]: ...
    def dense_search(self, embedding: list[float], k: int) -> list[tuple[str, float]]: ...


class LanguageModel(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...
    def chat(self, system: str, user: str) -> str: ...


def describe_profile(profile: dict | None, with_income: bool = False) -> str:
    if not profile:
        return ""
    parts = [f"{profile.get('age')}세", HOUSEHOLD_LABELS.get(profile.get("household", ""), ""), profile.get("region", "")]
    if with_income:
        parts.append(INCOME_LABELS.get(profile.get("income", ""), ""))
    if profile.get("disability"):
        parts.append("장애 있음")
    return " · ".join(p for p in parts if p)


def to_api(record: ServiceRecord) -> dict:
    """프론트엔드 WelfareProgram 타입과 같은 모양으로 바꾼다."""
    return {
        "id": record.service_id,
        "name": record.name,
        "summary": record.summary,
        "ministry": record.ministry,
        "department": record.department,
        "contacts": record.contacts,
        "url": record.url,
        "updatedAt": record.updated_at,
        "category": "",
        "keywords": [],
        "eligibility": "",
        "benefit": "",
        "howToApply": "",
    }


def _unique_contacts(contacts: list[dict]) -> list[dict]:
    seen: set[str] = set()
    result = []
    for contact in contacts:
        key = contact.get("phone") or contact.get("label", "")
        if key and key not in seen:
            seen.add(key)
            result.append(contact)
    return result


def _token_variants(query: str) -> list[set[str]]:
    variants = []
    for token in re.split(r"[^\w]+", query):
        if len(token) < 2:
            continue
        forms = {token}
        for particle in PARTICLES:
            if token.endswith(particle) and len(token) - len(particle) >= 2:
                forms.add(token[: -len(particle)])
        forms -= STOPWORDS
        if forms:
            variants.append(forms)
    return variants


def _follow_ups(record: ServiceRecord) -> list[str]:
    return [f"{record.name} 신청 방법", f"{record.name} 받을 수 있는 조건", f"{record.name} 문의처"]


def _starter_suggestions(profile: dict | None) -> list[str]:
    picks = []
    if profile:
        age = profile.get("age") or 0
        if age >= 65:
            picks.append("어르신이 받을 수 있는 연금")
        if 19 <= age <= 34:
            picks.append("청년 주거 지원")
        if profile.get("disability"):
            picks.append("장애인 지원 서비스")
        if profile.get("household") == "singleParent":
            picks.append("한부모 양육 지원")
    picks += ["생활비가 부족해요", "병원비가 걱정돼요", "일자리를 찾고 있어요"]
    return list(dict.fromkeys(picks))[:4]


class ChatService:
    """질문을 받아 서비스를 검색하고, 근거가 충분할 때만 LLM으로 답변을 만든다."""

    def __init__(self, repo: ServiceRepository, llm: LanguageModel, min_similarity: float, top_n: int):
        self.repo = repo
        self.llm = llm
        self.min_similarity = min_similarity
        self.top_n = top_n
        self._services: list[ServiceRecord] = []
        self._loaded_at = 0.0

    def _all_services(self) -> list[ServiceRecord]:
        if not self._services or time.monotonic() - self._loaded_at > SERVICES_TTL_SECONDS:
            self._services = self.repo.all_services()
            self._loaded_at = time.monotonic()
        return self._services

    def _pinned(self, query: str, services: list[ServiceRecord]) -> list[ServiceRecord]:
        query_key = name_key(query)
        matches = []
        for record in services:
            keys = {name_key(record.name), name_key(PARENTHESES.sub("", record.name))}
            longest = max((len(k) for k in keys if len(k) >= MIN_KEY_LENGTH and k in query_key), default=0)
            if longest:
                matches.append((longest, record))
        matches.sort(key=lambda m: -m[0])
        return [record for _, record in matches[:MAX_PINS]]

    def _keyword_hits(self, query: str, services: list[ServiceRecord]) -> list[ServiceRecord]:
        variants = _token_variants(query)
        scored = []
        for record in services:
            score = 0
            for forms in variants:
                best = 0
                for form in forms:
                    value = (3 if form in record.name else 0) + (1 if form in record.summary else 0) + (1 if form in record.department else 0)
                    best = max(best, value)
                score += best
            if score >= KEYWORD_MIN_SCORE:
                scored.append((score, record))
        scored.sort(key=lambda s: -s[0])
        return [record for _, record in scored]

    def _dense_hits(self, query: str, by_id: dict[str, ServiceRecord]) -> list[ServiceRecord]:
        embedding = self.llm.embed([query])[0]
        results = self.repo.dense_search(embedding, self.top_n)
        return [by_id[sid] for sid, sim in results if sim >= self.min_similarity and sid in by_id]

    def _fallback(self, text: str, contacts: list[dict], suggestions: list[str]) -> dict:
        return {"kind": "fallback", "text": text, "contacts": _unique_contacts(contacts), "suggestions": suggestions}

    def _generate(self, query: str, profile: dict | None, cards: list[ServiceRecord]) -> str:
        description = describe_profile(profile)
        template = (
            f"{description + ' 조건을 참고해 ' if description else ''}관련된 복지서비스 {len(cards)}개를 찾았어요. "
            "실제로 받을 수 있는지는 담당 기관에서 최종 확인해 주세요."
        )
        context = "\n".join(
            f"{i}. 서비스명: {r.name}\n   소관: {r.ministry} {r.department}\n   요약: {r.summary}" for i, r in enumerate(cards, 1)
        )
        user = (
            f"[이용자 조건]\n{describe_profile(profile, with_income=True) or '입력하지 않음'}\n\n"
            f"[참고 자료]\n{context}\n\n[질문]\n{query}"
        )
        try:
            reply = self.llm.chat(SYSTEM_PROMPT, user)
        except OllamaError:
            return template
        reply = re.sub(r"\s*\n+\s*", " ", re.sub(r"[*#]+", "", reply)).strip()
        if not reply.endswith((".", "!", "?")):
            cut = max(reply.rfind(". "), reply.rfind("? "), reply.rfind("! "))
            if cut < 0:
                return template
            reply = reply[: cut + 1]
        allowed_phones = {c["phone"] for r in cards for c in r.contacts if c["phone"]}
        if any(phone not in allowed_phones for phone in PHONE_IN_TEXT.findall(reply)):
            return template
        grounded = re.sub(r"\s+", "", user)
        if any(re.sub(r"\s+", "", number) not in grounded for number in NUMBER_WITH_UNIT.findall(reply)):
            return template
        return reply

    def answer(self, query: str, profile: dict | None) -> dict:
        services = self._all_services()
        by_id = {r.service_id: r for r in services}
        pinned = self._pinned(query, services)

        if pinned:
            target = pinned[0]
            follow = _follow_ups(target)
            if "신청" in query:
                return self._fallback(
                    f"{target.name}의 신청 방법은 지금 가진 자료에 없어서 추측해서 안내하지 않을게요. "
                    "아래 담당 기관에 문의하면 정확하게 안내받을 수 있어요.",
                    target.contacts + [GENERAL_CONTACT],
                    follow,
                )
            if re.search(r"자격|조건|대상|받을 수 있", query):
                return self._fallback(
                    f"{target.name}의 자세한 신청 자격은 지금 가진 자료에 없어서 추측해서 안내하지 않을게요. "
                    "아래 담당 기관에서 내 상황에 맞는지 확인해 주세요.",
                    target.contacts + [GENERAL_CONTACT],
                    follow,
                )
            if re.search(r"문의|연락|전화", query):
                listed = ", ".join(f"{c['label']} {c['phone']}".strip() for c in target.contacts) or "등록된 문의처 없음"
                return {"kind": "answer", "text": f"{target.name} 문의처는 {listed}입니다.", "services": [to_api(target)], "suggestions": follow}

        try:
            hits = self._dense_hits(query, by_id)
        except OllamaError:
            hits = self._keyword_hits(query, services)

        cards = list({r.service_id: r for r in pinned + hits}.values())[:MAX_CARDS]
        if not cards:
            return self._fallback(
                "질문에 맞는 정보를 확실하게 찾지 못했어요. 잘못된 안내를 드리지 않도록 추측해서 답하지 않을게요. "
                "아래 연락처로 문의하면 정확하게 안내받을 수 있어요.",
                [GENERAL_CONTACT],
                _starter_suggestions(profile),
            )
        return {
            "kind": "answer",
            "text": self._generate(query, profile, cards),
            "services": [to_api(r) for r in cards],
            "suggestions": _follow_ups(cards[0]),
        }
