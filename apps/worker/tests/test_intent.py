from sentiment_monitor.intent import Keyword, hashtag_term, parse_keyword


def test_explicit_intent_wins_even_when_text_starts_with_hash():
    assert parse_keyword("#lama", "phrase") == ("#lama", "phrase")
    assert parse_keyword("#baru", None) == ("#baru", "hashtag")
    assert parse_keyword("Kopi  Kenangan", "hashtag") == ("Kopi Kenangan", "hashtag")


def test_a_lone_hash_is_a_phrase_not_a_hashtag():
    assert parse_keyword("#") == ("#", "phrase")


def test_keyword_is_a_string_that_carries_intent():
    keyword = Keyword("#Kopi", "hashtag")
    assert keyword == "#Kopi"
    assert keyword.intent == "hashtag"
    assert isinstance(keyword, str)


def test_hashtag_term_compacts_unicode_letters_digits_and_underscore():
    assert hashtag_term("#Kopi Kenangan!") == "kopikenangan"
    assert hashtag_term("  @kopi_kenangan ") == "kopi_kenangan"
    assert hashtag_term("#CAFÉ") == "café"
