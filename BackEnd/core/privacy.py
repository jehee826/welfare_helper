"""문서 질의의 형식 기반 입력 검사와 표시용 정제. 원본 문서는 변경하지 않는다."""

import re

from pydantic_core import PydanticCustomError


# JS 문서 정책과 구분자·길이를 맞춘다. 체크섬이나 실제 소유자를 판별하지 않는다.
RESIDENT = re.compile(r"(?<![0-9])[0-9]{6}[ \t-]*[1-8][0-9]{6}(?![0-9])")
MOBILE = re.compile(r"(?<![0-9])01[016789][ \t-]*[0-9]{3,4}[ \t-]*[0-9]{4}(?![0-9])")
ACCOUNT = re.compile(
    r"(?:계좌(?:[ \t]*번호)?|account(?:[ \t]*number)?)(?:는|은)?[ \t]*[:：=]?[ \t]*"
    r"[0-9](?:[ \t-]*[0-9]){8,15}(?![0-9]|[ \t-]+[0-9]|[ \t]*(?:만|억)?[ \t]*원)", re.I)
PERSONAL_MOBILE = re.compile(
    r"(?:개인|신청자|수급자|본인|내)(?:의)?[ \t]*(?:휴대(?:전화|폰)(?:번호)?|연락처|전화(?:번호)?)(?:는|은)?"
    r"[ \t]*[:：=]?[ \t]*01[016789][ \t-]*[0-9]{3,4}[ \t-]*[0-9]{4}(?![0-9])")
MASK = "[개인정보 가림]"
DISPLAY_FIELDS = {
    "text", "quote", "context", "heading_context", "source_url", "sourceUrl", "url",
    "name", "title", "summary", "label", "phone", "suggestions", "ministry", "department",
    "category", "keywords", "eligibility", "benefit", "howToApply",
}


def sensitive_input(text: str) -> bool:
    return any(pattern.search(text) for pattern in (RESIDENT, MOBILE, ACCOUNT))


def validate_document_input(data):
    if isinstance(data, dict):
        texts = [data.get("query")]
        history = data.get("history")
        if isinstance(history, list):
            texts.extend(item.get("content") for item in history if isinstance(item, dict))
        context = data.get("conversation_context")
        if isinstance(context, dict):
            texts.append(context.get("text"))
            if isinstance(context.get("batch"), list):
                texts.extend(item.get("content") for item in context["batch"] if isinstance(item, dict))
        if any(sensitive_input(text) for text in texts if isinstance(text, str)):
            raise PydanticCustomError("sensitive_input", "개인정보를 제외하고 질문해 주세요.")
    return data


def mask_text(text: str, *, user_history: bool = False) -> str:
    for pattern in (RESIDENT, ACCOUNT, MOBILE if user_history else PERSONAL_MOBILE):
        text = pattern.sub(MASK, text)
    return text


def redact_document(value, *, display_text: bool = True):
    """표시 응답의 복사본만 정제하고, 변경된 근거에는 가림 표시를 남긴다."""
    if isinstance(value, str):
        return mask_text(value) if display_text else value
    if isinstance(value, list):
        return [redact_document(item, display_text=display_text) for item in value]
    if isinstance(value, dict):
        # ID·해시·원문 위치는 보존하고 표시 필드만 가린다.
        result = {key: redact_document(item, display_text=key in DISPLAY_FIELDS) for key, item in value.items()}
        if "chunk_id" in value and any(result.get(key) != value.get(key) for key in value):
            result["redacted"] = True
        return result
    return value
