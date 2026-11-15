"""최종 답변 생성 스트림에서 표시용 text 초안을 추출한다. 초안은 검증 전 값이며 최종 응답이 항상 대체한다."""

import json
import time

from BackEnd.core.privacy import mask_text

HOLD_CHARACTERS = 80
NUMBER_RUN = set("0123456789 \t-")
ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


def _member_start(raw: str, name: str) -> int | None:
    """최상위 키만 찾는다. 앞선 문자열·배열·객체가 미완성이면 다음 조각을 기다린다."""
    decoder = json.JSONDecoder()
    index = 0
    while index < len(raw) and raw[index] in " \t\r\n":
        index += 1
    if index >= len(raw) or raw[index] != "{":
        return None
    index += 1
    while index < len(raw):
        while index < len(raw) and raw[index] in " \t\r\n":
            index += 1
        try:
            key, index = decoder.raw_decode(raw, index)
        except ValueError:
            return None
        if not isinstance(key, str):
            return None
        while index < len(raw) and raw[index] in " \t\r\n":
            index += 1
        if index >= len(raw) or raw[index] != ":":
            return None
        index += 1
        while index < len(raw) and raw[index] in " \t\r\n":
            index += 1
        if key == name:
            return index
        try:
            _, index = decoder.raw_decode(raw, index)
        except ValueError:
            return None
        while index < len(raw) and raw[index] in " \t\r\n":
            index += 1
        if index >= len(raw) or raw[index] != ",":
            return None
        index += 1
    return None


def member_value(raw: str, name: str) -> tuple[bool, object]:
    """최상위 키의 값이 완성됐을 때만 (True, 값)을 돌려준다. 키가 없거나 값이 미완성이면 (False, None)이다."""
    start = _member_start(raw, name)
    if start is None:
        return False, None
    try:
        return True, json.JSONDecoder().raw_decode(raw, start)[0]
    except ValueError:
        return False, None


def partial_text(raw: str) -> tuple[str | None, bool]:
    """완성된 JSON 문자열 조각까지만 해독한다. 끝이 잘린 escape는 다음 조각을 기다린다."""
    start = _member_start(raw, "text")
    if start is None or start >= len(raw) or raw[start] != '"':
        return None, False
    result, index = [], start + 1
    while index < len(raw):
        char = raw[index]
        if char == '"':
            return "".join(result), True
        if char != "\\":
            result.append(char)
            index += 1
            continue
        if index + 1 >= len(raw):
            break
        kind = raw[index + 1]
        if kind in ESCAPES:
            result.append(ESCAPES[kind])
            index += 2
            continue
        if kind != "u" or index + 6 > len(raw):
            break
        try:
            code = int(raw[index + 2:index + 6], 16)
        except ValueError:
            break
        if 0xD800 <= code < 0xDC00:
            if index + 12 > len(raw):
                break
            try:
                result.append(json.loads('"' + raw[index:index + 12] + '"'))
            except ValueError:
                break
            index += 12
            continue
        result.append(chr(code))
        index += 6
    return "".join(result), False


def stable_draft(text: str, complete: bool) -> str:
    """개인정보 형식이 완성되기 전의 숫자 구간을 내보내지 않도록 끝부분을 보류한 뒤 가린다."""
    cut = len(text)
    if not complete:
        window = max(0, len(text) - HOLD_CHARACTERS)
        digit = next((i for i in range(window, len(text)) if text[i].isdigit()), None)
        if digit is not None:
            cut = digit
            while cut > 0 and text[cut - 1] in NUMBER_RUN:
                cut -= 1
    return mask_text(text[:cut])


class DraftStream:
    """모델 조각을 누적해 바뀐 초안만 콜백으로 전달한다. 범위 밖 답변은 초안을 보내지 않는다."""

    def __init__(self, emit, *, interval: float = 0.1, clock=time.monotonic):
        self.emit, self.interval, self.clock = emit, interval, clock
        self.raw, self.sent, self.last = "", "", None

    def feed(self, piece: str) -> None:
        self.raw += piece
        start = _member_start(self.raw, "status")
        if start is None:
            return
        try:
            status, _ = json.JSONDecoder().raw_decode(self.raw, start)
        except ValueError:
            return
        if status not in ("answer", "clarify", "no_evidence"):
            return
        text, complete = partial_text(self.raw)
        if text is None:
            return
        now = self.clock()
        if not complete and self.last is not None and now - self.last < self.interval:
            return
        draft = stable_draft(text, complete)
        if draft and draft != self.sent:
            self.sent, self.last = draft, now
            self.emit(draft)
