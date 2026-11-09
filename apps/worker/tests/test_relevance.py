import pytest

from sentiment_monitor.relevance import (
    hashtags_in_text,
    literal_match_status,
    normalize_match_text,
)


def test_normalization_uses_nfkc_casefold_and_whitespace_collapse():
    assert normalize_match_text("  ＫＯＰＩ\tKenangan  ") == "kopi kenangan"


def test_phrase_matches_case_and_hash_prefix_but_not_a_longer_word():
    assert literal_match_status("Saya suka Indonesia", "Indonesia", "phrase") == "literal_match"
    assert literal_match_status("#Indonesia", "Indonesia", "phrase") == "literal_match"
    assert literal_match_status("Indonesian food", "Indonesia", "phrase") == "no_literal_match"


def test_phrase_multi_word_matches_the_joined_hashtag_but_not_bare_joined_text():
    assert literal_match_status("Bank Mandiri buka cabang", "Bank Mandiri", "phrase") == "literal_match"
    assert literal_match_status("#BankMandiri", "Bank Mandiri", "phrase") == "literal_match"
    assert literal_match_status("bankmandiri", "Bank Mandiri", "phrase") == "no_literal_match"
    assert literal_match_status(
        "", "Bank Mandiri", "phrase", hashtags=["bankmandiri"]
    ) == "literal_match"


def test_joined_hashtag_rule_is_case_and_accent_insensitive():
    assert literal_match_status("#TimnasIndonesia menang", "timnas indonesia", "phrase") == "literal_match"
    assert literal_match_status("#cafe", "café", "phrase") == "literal_match"
    assert literal_match_status(
        "", "café", "phrase", hashtags=["CAFÉ"]
    ) == "literal_match"


def test_hashtag_intent_uses_explicit_platform_hashtags():
    assert literal_match_status("", "#Kopi", "hashtag", hashtags=["kopi"]) == "literal_match"
    assert literal_match_status("", "#Kopi", "hashtag", hashtags=["teh"]) == "no_literal_match"


def test_hashtags_in_text_extracts_hashtag_tokens():
    assert hashtags_in_text("a #TimnasIndonesia b #fyp_2026") == ["TimnasIndonesia", "fyp_2026"]


def test_hashtag_intent_matches_compact_forms_but_not_the_spaced_phrase():
    assert literal_match_status("#BankMandiri", "Bank Mandiri", "hashtag") == "literal_match"
    assert literal_match_status("bankmandiri", "Bank Mandiri", "hashtag") == "literal_match"
    assert literal_match_status("bank mandiri", "Bank Mandiri", "hashtag") == "no_literal_match"


def test_punctuation_and_symbol_boundaries_are_defined():
    assert literal_match_status("C++", "C++", "phrase") == "literal_match"
    assert literal_match_status("C++17", "C++", "phrase") == "no_literal_match"
    assert literal_match_status("C ++", "C++", "phrase") == "no_literal_match"


@pytest.mark.parametrize("text", ["", "   ", "\n\t"])
def test_empty_text_is_unknown_not_unmatched(text):
    assert literal_match_status(text, "Kopi", "phrase") == "unknown_text"
