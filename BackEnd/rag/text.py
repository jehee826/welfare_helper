import html
import re
import unicodedata

CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​﻿]")
BROKEN_MIDDLE_DOT = re.compile(r"(?<=[가-힣])\?(?=[가-힣])")
PHONE = re.compile(
    r"(?<![\d-])(?:국번없이\s*)?"
    r"((?:0\d{1,2}-\d{3,4}-\d{4}|1\d{3}-\d{4}|1\d{2,3})"
    r"(?:~\d{1,4})?"
    r"(?:,\s*\d{4}(?:-\d{4})?)*)"
    r"(\s*\([^)]*\))?(?!\d)"
)
KEYMAP = str.maketrans({"Ⅰ": "I", "Ⅱ": "II"})
KEY_STRIP = re.compile(r"[\s·ㆍ,.\-'~()]")


def clean_text(value: str | None) -> str | None:
    """HTML 엔티티 복원, NFC 정규화, 제어문자 제거, 깨진 가운뎃점(한글?한글) 복원, 공백 정리를 한다. 빈 값은 None."""
    if value is None or not value.strip():
        return None
    value = html.unescape(value)
    value = unicodedata.normalize("NFC", value)
    value = CONTROL_CHARS.sub("", value)
    value = BROKEN_MIDDLE_DOT.sub("·", value)
    return re.sub(r"\s+", " ", value).strip()


def _dedupe_repeated(label: str) -> str:
    half, rest = divmod(len(label), 2)
    if rest == 0 and half > 0 and label[:half] == label[half:]:
        return label[:half]
    return label


def parse_contacts(raw: str | None) -> list[dict[str, str]]:
    """'기관명전화번호'가 붙어 이어진 대표문의 문자열을 [{label, phone}] 목록으로 나눈다."""
    text = clean_text(raw)
    if not text:
        return []
    contacts: list[dict[str, str]] = []
    cursor = 0
    for match in PHONE.finditer(text):
        label = text[cursor:match.start()].strip()
        note = (match.group(2) or "").strip()
        if note:
            label = f"{label} {note}".strip()
        contacts.append({"label": label or "문의처", "phone": match.group(1)})
        cursor = match.end()
    rest = _dedupe_repeated(text[cursor:].strip())
    if rest:
        contacts.append({"label": rest, "phone": ""})
    return contacts


def name_key(value: str) -> str:
    """검색 비교용 키. 공백·구두점을 지우고 소문자로 바꾼다. 화면 표시에 쓰지 않는다."""
    return KEY_STRIP.sub("", value.translate(KEYMAP)).lower()
