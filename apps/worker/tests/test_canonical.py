import json
from pathlib import Path

import pytest

from sentiment_monitor.providers.canonical import (
    CanonicalPost,
    detect_language,
    keyword_relevance,
    post_identity,
    safe_published_at,
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


RELEVANCE_FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "scrapeatlas" / "relevance.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("example", RELEVANCE_FIXTURES)
def test_search_relevance_requires_the_entity_or_all_topic_words(example):
    item = post(text=example["text"], title=example["title"], hashtags=tuple(example["hashtags"]))
    assert keyword_relevance(item, example["query"], example["intent"]) == example["expected"]


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


from sentiment_monitor.providers.canonical import (
    dedupe_posts,
    engagement_score,
    filter_since,
    sort_posts,
)


def test_date_filter_keeps_undated_and_drops_older():
    posts = [
        post(external_id="new", published_at="2026-11-15T00:00:00Z"),
        post(external_id="old", published_at="2026-10-01T00:00:00Z"),
        post(external_id="undated", published_at=None),
    ]
    kept = filter_since(posts, "2026-11-08T00:00:00Z")
    assert [item.external_id for item in kept] == ["new", "undated"]


def test_dedupe_merges_routes_and_keeps_richest_fields():
    sparse = post(external_id="same", source_provider="scrapecreators", likes=None)
    rich = post(external_id="same", source_provider="scrapeatlas", likes=99,
                thumbnail_url="https://img/x.jpg", routes=("threads.recent",))
    merged = dedupe_posts([sparse, rich])
    assert len(merged) == 1
    assert merged[0].likes == 99
    assert merged[0].thumbnail_url == "https://img/x.jpg"
    assert set(merged[0].routes) == {"threads.keyword", "threads.recent"}


def test_undated_items_sort_last_even_for_popular():
    posts = [
        post(external_id="undated", published_at=None, views=10**9),
        post(external_id="dated", published_at="2026-11-15T00:00:00Z", views=1),
    ]
    assert [item.external_id for item in sort_posts(posts, "popular")] == ["dated", "undated"]


def test_undated_stays_last_in_newest_and_relevance_modes():
    posts = [
        post(external_id="undated", published_at=None, relevance="literal_match", views=10**9),
        post(external_id="new", published_at="2026-11-15T00:00:00Z", relevance="no_match"),
        post(external_id="old", published_at="2026-11-01T00:00:00Z", relevance="all_words_match"),
    ]
    assert [item.external_id for item in sort_posts(posts, "newest")] == ["new", "old", "undated"]
    assert [item.external_id for item in sort_posts(posts, "relevance")] == [
        "old", "new", "undated"
    ]


def test_dedupe_drops_blank_identity_without_colliding():
    blank = post(external_id="  ", url=None, raw_ref="scrapeatlas:threads:blank")
    blank_two = post(external_id="", url="   ", raw_ref="scrapeatlas:threads:blank-two")
    real = post(external_id="p2", raw_ref="scrapeatlas:threads:p2")
    merged = dedupe_posts([blank, blank_two, real])
    assert [item.external_id for item in merged] == ["p2"]


def test_engagement_score_weights_views_and_actions():
    assert engagement_score(post(views=10, likes=2, replies=3, shares=4)) == 10 + 6 + 6 + 8
    assert engagement_score(post(views=None, likes=None, replies=None, shares=None)) == 0


@pytest.mark.parametrize(
    "value",
    [
        "9999-12-31T23:59:59-14:00",
        "0001-01-01T00:00:00+14:00",
        10**20,
        -(10**20),
        float("inf"),
        float("-inf"),
        "999999999999999999999",
        "-999999999999999999999",
    ],
)
def test_extreme_dates_become_undated_instead_of_raising(value):
    assert safe_published_at(value) is None


def test_ordinary_iso_dates_still_normalise_to_utc():
    assert safe_published_at("2026-11-15T00:00:00Z") == "2026-11-15T00:00:00Z"
    assert safe_published_at("2026-11-15T07:00:00+07:00") == "2026-11-15T00:00:00Z"


@pytest.mark.parametrize("tz", ["UTC", "Asia/Jakarta"])
def test_naive_dates_are_treated_as_utc_and_never_raise(tz):
    import os
    import time

    previous = os.environ.get("TZ")
    os.environ["TZ"] = tz
    time.tzset()
    try:
        posts = [
            post(external_id="naive-old", published_at="0001-01-01"),
            post(external_id="naive-future", published_at="9999-12-31T23:59:59"),
            post(external_id="undated", published_at=None),
            post(external_id="new", published_at="2026-11-15T00:00:00Z"),
        ]
        kept = filter_since(posts, "2026-11-08T00:00:00Z")
        assert [item.external_id for item in kept] == [
            "naive-future",
            "undated",
            "new",
        ]
        ordered = sort_posts(posts, "newest")
        assert [item.external_id for item in ordered] == [
            "naive-future",
            "new",
            "naive-old",
            "undated",
        ]
        assert filter_since(
            [post(external_id="poison", published_at="not-a-date")],
            "0001-01-01T00:00:00Z",
        )[0].external_id == "poison"
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()
