from BackEnd.rag.text import clean_text, name_key, parse_contacts


def test_clean_text_unescapes_and_collapses_spaces():
    assert clean_text("  감면&middot;면제하여   생활 안정 ") == "감면·면제하여 생활 안정"


def test_clean_text_restores_broken_middle_dot_between_hangul():
    assert clean_text("질병?부상 등으로 초?중?고등학교") == "질병·부상 등으로 초·중·고등학교"
    assert clean_text("받을 수 있나요? 네") == "받을 수 있나요? 네"


def test_clean_text_returns_none_for_blank():
    assert clean_text("   ") is None
    assert clean_text(None) is None


def test_parse_contacts_splits_label_and_phone():
    assert parse_contacts("국민건강보험1577-1000 보건복지상담센터129") == [
        {"label": "국민건강보험", "phone": "1577-1000"},
        {"label": "보건복지상담센터", "phone": "129"},
    ]


def test_parse_contacts_keeps_note_in_label():
    assert parse_contacts("K-스타트업1357(내선번호 3번)") == [
        {"label": "K-스타트업 (내선번호 3번)", "phone": "1357"},
    ]


def test_parse_contacts_handles_range_and_area_code():
    assert parse_contacts("근로복지공단 직장보육지원센터02-2670-0410~9") == [
        {"label": "근로복지공단 직장보육지원센터", "phone": "02-2670-0410~9"},
    ]


def test_parse_contacts_dedupes_repeated_trailing_label():
    assert parse_contacts("보건복지상담센터129 주소지 읍·면·동 주민센터주소지 읍·면·동 주민센터") == [
        {"label": "보건복지상담센터", "phone": "129"},
        {"label": "주소지 읍·면·동 주민센터", "phone": ""},
    ]


def test_parse_contacts_without_phone():
    assert parse_contacts("학교 밖 청소년지원센터 홈페이지") == [
        {"label": "학교 밖 청소년지원센터 홈페이지", "phone": ""},
    ]


def test_name_key_ignores_spaces_and_punctuation():
    assert name_key("대중교통비 환급 지원(K-패스)") == "대중교통비환급지원k패스"
