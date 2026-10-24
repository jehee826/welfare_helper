"""수치와 제도는 전부 가상 자료이며 실제 모델·공식 API를 호출하지 않는다."""

from dataclasses import replace

import pytest

from BackEnd.ingest.official import OfficialDataError, parse_detail, plain_text
from BackEnd.rag.chunking import split_official, split_ranges
from BackEnd.rag.evidence import EvidenceConsistencyError, active_chunks, read_chunk, validate_version
from BackEnd.rag.repository import PgServiceRepository
from BackEnd.rag.reranker import LocalReranker, RerankerInputError
from BackEnd.rag.search import BM25Index, fair_candidates
from BackEnd.tests.test_chat import APPLICATION, BENEFIT, CRITERIA, PENSION, TARGET, FakeRepo, make
from BackEnd.tests.test_official import XML


def children(text=None, digest="test-digest"):
    sections = [TARGET, CRITERIA, BENEFIT, APPLICATION]
    if text is not None:
        sections[2] = replace(BENEFIT, text=text)
    return split_official(sections, PENSION.name, digest, len, "fake-tokenizer-v1")


def test_split_preserves_every_source_position_and_both_bounds():
    source = ("조건을 모두 확인합니다. " * 90) + "다만 테스트 제외 대상에는 지원하지 않습니다."
    rows = children(source)
    validate_version(rows)
    covered = set()
    for row in rows:
        assert len(row.text) <= 800 and len(row.embedding_text()) <= 400
        assert read_chunk(row.chunk_id, row.service_id, row.storage(), row.source_url) == row
        if row.section == "benefit":
            covered.update(range(row.start, row.end))
    assert all(i in covered or value.isspace() for i, value in enumerate(source))
    assert any("다만" in row.text for row in rows)


def test_overlap_is_one_complete_sentence_within_both_caps():
    text = "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다. 넷째 문장입니다."
    spans = split_ranges(text, "", len, target=15, max_chars=40, max_tokens=40)
    for left, right in zip(spans, spans[1:]):
        if right.start < left.end:
            overlap = text[right.start:left.end]
            assert len(overlap) <= 80 and len(overlap) <= 40
            assert overlap.count(".") == 1


def test_long_sentence_fragments_require_whole_parent():
    rows = children("가" * 1100)
    assert any(not row.complete for row in rows if row.section == "benefit")
    representative = next(row for row in rows if row.section == "benefit" and row.parent_text)
    assert len(representative.parent_text) == 1100


def test_partial_collection_and_missing_basis_are_rejected():
    for xml in [XML.replace(b"<crtrYr>2026</crtrYr>", b""),
                XML.replace("테스트 소득 조건입니다. 다만 예외가 있습니다.".encode(), b"")]:
        with pytest.raises(OfficialDataError):
            parse_detail(xml, PENSION, "2026-10-24T00:00:00+00:00")


def test_table_keeps_header_units_and_exception_footnotes():
    text = plain_text("<table><caption>월 단위</caption><tr><th>가구</th><th>금액(원)</th></tr>"
                      "<tr><td>가상 가구</td><td>10</td></tr></table><p>다만 C는 제외합니다.</p>")
    assert "금액(원): 10" in text and "가구: 가상 가구" in text
    assert "월 단위" in text and "C는 제외" in text


def test_heading_is_inherited_from_same_parent_without_crossing_sections():
    source = plain_text("<h1>가상 구분</h1><h2>가상 가구</h2><p>" + "지원 조건을 확인합니다. " * 90 + "</p>")
    rows = children(source)
    benefit = [c for c in rows if c.section == "benefit"]
    assert any(c.start > 50 and "가상 가구" in c.heading_context for c in benefit)
    assert all("가상 가구" not in c.heading_context for c in rows if c.section != "benefit")


def test_active_version_excludes_old_details_before_retrieval():
    old = children(digest="old-digest")
    new = children()
    with pytest.raises(EvidenceConsistencyError):
        active_chunks(old + new)
    active = active_chunks([replace(c, active=False) for c in old] + new + [TARGET])
    assert {c.version for c in active} == {new[0].version}


def test_missing_parent_or_child_or_condition_link_is_not_silently_used():
    rows = children("가" * 1000)
    with pytest.raises(EvidenceConsistencyError):
        validate_version(rows[1:])
    middle = next(c.chunk_id for c in rows if c.section == "benefit" and c.ordinal == 1)
    with pytest.raises(EvidenceConsistencyError):
        validate_version([c for c in rows if c.chunk_id != middle])
    with pytest.raises(EvidenceConsistencyError):
        validate_version([replace(c, required_parents=(c.parent_id,)) if c.section == "benefit" else c for c in rows])


def test_collected_time_does_not_change_embedding_or_version_but_digest_does():
    rows = children()
    updated = [replace(c, collected_at="2026-10-25T00:00:00+00:00") for c in rows]
    assert [c.embedding_text() for c in rows] == [c.embedding_text() for c in updated]
    assert rows[0].version == updated[0].version != children(digest="different")[0].version


def test_invalid_activation_fails_before_database_connection():
    def forbidden():
        pytest.fail("불완전한 버전으로 DB에 접근했습니다.")

    with pytest.raises(ValueError):
        PgServiceRepository(forbidden).activate_details(children()[:-1], {}, {})


def test_bm25_searches_body_and_fair_merge_redistributes_empty_slots():
    a, b = replace(BENEFIT, text="보조기기"), replace(APPLICATION, text="접수처")
    index = BM25Index([a, b], {PENSION.service_id: PENSION.name}, str.split)
    assert index.search("보조기기", 30, {a.chunk_id, b.chunk_id})[0][0] == a
    assert fair_candidates([[a], [], [b]], 40) == [a, b]


def test_dense_below_old_threshold_is_still_reranked():
    service, _ = make(FakeRepo(dense=[(PENSION.service_id, 0.01)]))
    response, trace = service.answer_with_diagnostics("노후 생활 도움", None)
    assert response["kind"] == "answer"
    assert trace["retrieval"][0]["dense"][0]["similarity"] == 0.01


def test_body_index_refreshes_when_snapshot_changes_without_ttl_delay():
    from BackEnd.rag.evidence import EvidenceChunk

    overview = EvidenceChunk(PENSION.service_id + ":overview", PENSION.service_id, "summary", "보조기기", PENSION.url)
    repo = FakeRepo(records=[PENSION], chunks=[overview], dense=[])
    service, _ = make(repo)
    assert service.answer("방문돌봄", None)["kind"] == "fallback"
    repo.chunks = [replace(overview, text="방문돌봄")]
    assert service.answer("방문돌봄", None)["kind"] == "answer"


def test_requested_old_year_does_not_use_active_year_as_an_answer():
    service, _ = make(FakeRepo(chunks=[TARGET, CRITERIA, BENEFIT]))
    response, trace = service.answer_with_diagnostics("2025년 기초연금 금액", None)
    assert response["kind"] == "fallback"
    assert "requested_basis_mismatch" in trace["omission_reasons"].values()


def test_generic_application_sentence_is_not_a_document_list():
    service, _ = make(FakeRepo(chunks=[TARGET, CRITERIA, APPLICATION]))
    response, trace = service.answer_with_diagnostics("기초연금 신청 서류", None)
    assert response["kind"] == "fallback"
    assert "application_documents_missing" in trace["omission_reasons"].values()


def test_partial_answer_names_unsupported_amount_without_inventing_it():
    service, _ = make(FakeRepo(chunks=[TARGET, CRITERIA, APPLICATION]))
    response = service.answer("기초연금 신청 방법과 금액", None)
    assert response["kind"] == "answer" and APPLICATION.text in response["text"]
    assert "확인하지 못한 항목" in response["text"] and "지원 내용" in response["text"]


def test_version_change_retries_once_and_then_abstains():
    from BackEnd.rag.repository import CatalogSnapshot

    repo = FakeRepo()
    original = repo.snapshot
    counter = []

    def changing():
        snapshot = original()
        counter.append(1)
        return CatalogSnapshot(snapshot.services, snapshot.chunks, str(len(counter)))

    repo.snapshot = changing
    service, _ = make(repo)
    result, trace = service.answer_with_diagnostics("기초연금 소개", None)
    assert result["reason"] == "data_version_conflict" and trace["attempts"] == 2


def test_large_required_parent_is_not_summarized_to_fit_context():
    rows = children(("가상 지원 조건과 예외를 확인합니다. " * 200))
    service, llm = make(FakeRepo(chunks=rows))
    result = service.answer("기초연금 혜택", None)
    assert result["reason"] == "context_budget" and llm.chat_calls == 0


def test_oversized_question_is_rejected_before_onnx_loading(monkeypatch):
    reranker = LocalReranker("unused", "unused", "unused")
    monkeypatch.setattr(reranker, "count_tokens", lambda value: 129)
    with pytest.raises(RerankerInputError):
        reranker.score("질문", ["원문"])
    assert reranker._session is None
