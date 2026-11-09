from datetime import datetime, timezone

from sentiment_monitor.intent import Keyword
from sentiment_monitor.sources.routes import (
    request_params,
    routes_for,
    scrapecreators_request_count,
    threads_date_window,
    within_overlap,
)


def test_route_whitelist_is_fixed_per_platform_and_intent():
    assert [r.id for r in routes_for("threads", Keyword("kopi", "phrase"))] == ["threads.keyword"]
    assert [r.id for r in routes_for("threads", Keyword("#kopi", "hashtag"))] == ["threads.hashtag_text"]
    assert [r.id for r in routes_for("instagram", Keyword("kopi", "phrase"))] == ["instagram.reels"]
    assert [r.id for r in routes_for("instagram", Keyword("#kopi", "hashtag"))] == ["instagram.hashtag"]
    assert [r.id for r in routes_for("tiktok", Keyword("kopi", "phrase"))] == ["tiktok.keyword", "tiktok.top"]
    assert [r.id for r in routes_for("tiktok", Keyword("#kopi", "hashtag"))] == ["tiktok.hashtag"]
    assert routes_for("threads", Keyword("#kopi", "hashtag"))[0].disclosure == (
        "Threads has no hashtag search; searched as text"
    )


def test_threads_date_window_uses_jakarta_civil_days_and_the_ledger_format():
    assert threads_date_window("2026-11-09T16:31:00Z") == ("2026-11-02", "2026-11-10")
    assert threads_date_window("2026-11-09T18:00:00Z") == ("2026-11-03", "2026-11-11")
    assert threads_date_window(datetime(2026, 11, 9, 16, 31, tzinfo=timezone.utc)) == (
        "2026-11-02",
        "2026-11-10",
    )


def test_request_params_use_documented_windows_and_never_region():
    phrase = Keyword("Kopi Kenangan", "phrase")
    now = "2026-11-09T16:31:00Z"
    assert request_params(routes_for("threads", phrase)[0], phrase, now=now) == {
        "query": "Kopi Kenangan",
        "start_date": "2026-11-02",
        "end_date": "2026-11-10",
    }
    assert request_params(routes_for("instagram", phrase)[0], phrase) == {
        "query": "Kopi Kenangan",
        "date_posted": "last-week",
    }
    tiktok_keyword, tiktok_top = routes_for("tiktok", phrase)
    assert request_params(tiktok_keyword, phrase) == {
        "query": "Kopi Kenangan",
        "date_posted": "this-week",
    }
    assert request_params(tiktok_top, phrase) == {
        "query": "Kopi Kenangan",
        "publish_time": "this-week",
    }


def test_hashtag_params_are_compact_but_threads_keeps_the_literal_hash():
    hashtag = Keyword("#Kopi Kenangan", "hashtag")
    now = "2026-11-09T16:31:00Z"
    assert request_params(routes_for("instagram", hashtag)[0], hashtag) == {
        "hashtag": "kopikenangan",
        "date_posted": "last-week",
    }
    assert request_params(routes_for("tiktok", hashtag)[0], hashtag) == {"hashtag": "kopikenangan"}
    assert request_params(routes_for("threads", hashtag)[0], hashtag, now=now) == {
        "query": "#Kopi Kenangan",
        "start_date": "2026-11-02",
        "end_date": "2026-11-10",
    }


def test_threads_phrase_is_never_quoted():
    phrase = Keyword("timnas indonesia", "phrase")
    params = request_params(
        routes_for("threads", phrase)[0], phrase, now="2026-11-09T16:31:00Z"
    )
    assert params["query"] == "timnas indonesia"
    assert not params["query"].startswith('"')
    assert not params["query"].endswith('"')


def test_request_count_is_keywords_times_fixed_routes():
    keywords = [Keyword("kopi", "phrase"), Keyword("#kopi", "hashtag")]
    assert scrapecreators_request_count(keywords, ["threads", "instagram", "tiktok"]) == 7
    assert scrapecreators_request_count([Keyword("kopi", "phrase")], ["x"]) == 0


def test_local_overlap_keeps_undated_and_threads_items():
    threads = routes_for("threads", Keyword("kopi", "phrase"))[0]
    instagram = routes_for("instagram", Keyword("kopi", "phrase"))[0]
    assert within_overlap(None, "2026-11-08T00:00:00Z", threads) is True
    assert within_overlap("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z", instagram) is True
    assert within_overlap("2026-10-30T00:00:00Z", "2026-11-08T00:00:00Z", instagram) is False
    assert within_overlap("2020-01-01T00:00:00Z", "2026-11-08T00:00:00Z", threads) is True
