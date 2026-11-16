from sentiment_monitor.providers.canonical import (
    CanonicalPost,
    detect_language,
    keyword_relevance,
    post_identity,
)


def post(**overrides):
    values = dict(
        platform="threads", external_id="p1",
        text="ayam goreng ini enak banget, antreannya panjang",
        title=None, author_name="Rina", author_handle="rina",
        url="https://threads.com/@rina/post/p1", published_at="2026-11-14T10:00:00Z",
        thumbnail_url=None, views=None, likes=10, replies=2, shares=0,
        top_replies=(), hashtags=(), source_provider="scrapecreators",
        routes=("threads.keyword",), raw_ref="scrapecreators:threads:p1",
        collected_at="2026-11-15T00:00:00Z",
    )
    values.update(overrides)
    return CanonicalPost(**values)


def test_detects_indonesian_english_and_keeps_short_text_other():
    assert detect_language("ayam goreng ini enak banget, antreannya panjang") == "id"
    assert detect_language("this chicken is so good and crispy") == "en"
    assert detect_language("barayam") == "other"


def test_relevance_prefers_literal_then_all_words_then_none():
    assert keyword_relevance(post(text="suka barayam banget"), "barayam", "phrase") == "literal_match"
    assert keyword_relevance(post(text="barayam enak"), "barayam goreng", "phrase") == "no_match"
    assert keyword_relevance(
        post(text="goreng-nya enak banget, barayam juara"),
        "barayam goreng",
        "phrase",
    ) == "all_words_match"


def test_identity_falls_back_to_normalized_url_and_rejects_blanks():
    assert post_identity(post(external_id="  ", url="https://Example.com/p/1/?utm=x")) == (
        "threads", "url:https://example.com/p/1"
    )
    assert post_identity(post(external_id="", url=None)) is None


def test_blank_identity_without_url_never_collides_with_another_post():
    first = post(external_id="  ", url=None, raw_ref="scrapeatlas:threads:missing")
    second = post(external_id="", url="   ", raw_ref="scrapeatlas:threads:missing-too")
    assert post_identity(first) is None
    assert post_identity(second) is None


def test_identity_keeps_distinct_urls_apart():
    left = post(external_id="", url="https://Example.com/p/1/?utm=x")
    right = post(external_id="", url="https://example.com/p/2")
    assert post_identity(left) != post_identity(right)
