"""정제 원문의 위치를 보존하며 글자·실제 tokenizer 한도를 함께 적용한다."""

import re
from dataclasses import dataclass, replace
from typing import Callable

from BackEnd.rag.evidence import EvidenceChunk, fingerprint, validate_version

CLEAN_VERSION = "structure-nfc-v2"
SPLIT_VERSION = "600-800-400-overlap1-80-40-headings-v3"
BOUNDARY = re.compile(r"(?<=[.!?。])\s+|\n+")


class ChunkingError(ValueError):
    """원문을 보존한 채 분할 한도를 지킬 수 없다."""


@dataclass(frozen=True)
class TextRange:
    start: int
    end: int
    complete: bool = True


def sentence_ranges(text: str) -> list[TextRange]:
    edges = [0] + [m.end() for m in BOUNDARY.finditer(text)] + [len(text)]
    result = []
    for start, end in zip(edges, edges[1:]):
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if start < end:
            result.append(TextRange(start, end))
    return result


def split_ranges(text: str, header: str, count: Callable[[str], int], *, target: int = 600,
                 max_chars: int = 800, max_tokens: int = 400, overlap: bool = True) -> list[TextRange]:
    if not text.strip() or count(header) >= max_tokens:
        raise ChunkingError("본문 또는 헤더의 토큰 예산이 유효하지 않습니다.")

    def fits(start: int, end: int) -> bool:
        return end - start <= max_chars and count(header + text[start:end]) <= max_tokens

    units = []
    for sentence in sentence_ranges(text):
        start = sentence.start
        while start < sentence.end:
            if fits(start, sentence.end):
                units.append(TextRange(start, sentence.end, start == sentence.start))
                break
            # 토큰 수가 문자 수와 선형 관계라고 가정하지 않고 실제 입력을 다시 계수한다.
            low, high, end = start + 1, min(sentence.end, start + max_chars), start
            while low <= high:
                middle = (low + high) // 2
                if fits(start, middle):
                    end, low = middle, middle + 1
                else:
                    high = middle - 1
            if end <= start:
                raise ChunkingError("한 글자도 토큰 예산에 넣을 수 없습니다.")
            separators = [m.end() for m in re.finditer(r"[,;:，；]\s*|\s+", text[start:end])]
            if separators and separators[-1] >= (end - start) // 2:
                end = start + separators[-1]
            units.append(TextRange(start, end, False))
            start = end
    packed = []
    index = 0
    while index < len(units):
        first = units[index]
        start, end, complete = first.start, first.end, first.complete
        index += 1
        while index < len(units) and end - start < target and fits(start, units[index].end):
            end = units[index].end
            complete = complete and units[index].complete
            index += 1
        packed.append(TextRange(start, end, complete))
    if overlap:
        for i in range(1, len(packed)):
            previous = [r for r in sentence_ranges(text) if r.start >= packed[i - 1].start and r.end <= packed[i - 1].end]
            if not previous:
                continue
            last = previous[-1]
            value = text[last.start:last.end]
            if (re.search(r"[.!?。]$", value) and len(value) <= 80 and count(value) <= 40
                    and fits(last.start, packed[i].end)):
                packed[i] = replace(packed[i], start=last.start)
    covered = 0
    for part in packed:
        if text[covered:part.start].strip() or not fits(part.start, part.end):
            raise ChunkingError("분할 중 원문 범위가 유실되었습니다.")
        covered = max(covered, part.end)
    if text[covered:].strip():
        raise ChunkingError("분할 중 원문 끝이 유실되었습니다.")
    return packed


def split_official(sections: list[EvidenceChunk], service_name: str, embed_digest: str,
                   count: Callable[[str], int], tokenizer_revision: str = "") -> list[EvidenceChunk]:
    if any(c.source_kind != "official_detail" for c in sections):
        raise ChunkingError("공식 API 원문만 허용합니다.")
    return split_sections(sections, service_name, embed_digest, count, tokenizer_revision)


def split_sections(sections: list[EvidenceChunk], service_name: str, embed_digest: str,
                   count: Callable[[str], int], tokenizer_revision: str = "") -> list[EvidenceChunk]:
    if not embed_digest or len({c.service_id for c in sections}) != 1 or len(sections) != 4:
        raise ChunkingError("완전한 서비스 원문과 임베딩 digest가 필요합니다.")
    ordered = sorted(sections, key=lambda c: c.section)
    source_hash = fingerprint("\n".join(f"{c.section}|{c.basis_year}|{c.source_updated_at}|{c.source_url}|{c.text}" for c in ordered))
    split_version = SPLIT_VERSION + ":" + tokenizer_revision
    document_id = ordered[0].document_id
    namespace = "document:" + document_id if document_id else "official"
    version = fingerprint(source_hash + CLEAN_VERSION + split_version + service_name + embed_digest + document_id)[:24]
    sid = ordered[0].service_id
    parents = {c.section: f"{sid}:{namespace}:{version}:{c.section}:0" for c in ordered}
    result = []
    for section in ordered:
        header = f"서비스명: {service_name}\n섹션: {section.section}\n"
        headings = list(re.finditer(r"(?m)^\[제목([1-6])\] [^\n]+", section.text))
        blocks, stack, cursor = [], {}, 0
        for heading in headings:
            if heading.start() > cursor:
                blocks.append((cursor, heading.start(), "\n".join(stack[level] for level in sorted(stack))))
            level = int(heading.group(1))
            stack = {depth: value for depth, value in stack.items() if depth < level}
            stack[level] = heading.group()
            cursor = heading.start()
        blocks.append((cursor, len(section.text), "\n".join(stack[level] for level in sorted(stack))))
        ranges = []
        for start, end, heading in blocks:
            if not section.text[start:end].strip():
                continue
            prefix = header + (heading + "\n" if heading else "")
            ranges.extend((replace(part, start=part.start + start, end=part.end + start), heading)
                          for part in split_ranges(section.text[start:end], prefix, count))
        required = {parents[section.section]}
        if section.section in {"benefit", "application", "target", "criteria"}:
            required.update(parents[key] for key in ("target", "criteria"))
        for index, (part, heading) in enumerate(ranges):
            result.append(replace(
                section, chunk_id=f"{sid}:{namespace}:{version}:{section.section}:{index}",
                text=section.text[part.start:part.end], conditions="", service_name=service_name,
                version=version, source_hash=source_hash, clean_version=CLEAN_VERSION,
                split_version=split_version, embed_digest=embed_digest, parent_id=parents[section.section],
                parent_text=section.text if index == 0 else "", ordinal=index, start=part.start,
                end=part.end, complete=part.complete, active=True, required_parents=tuple(sorted(required)),
                heading_context=heading,
            ))
    validate_version(result)
    return result
