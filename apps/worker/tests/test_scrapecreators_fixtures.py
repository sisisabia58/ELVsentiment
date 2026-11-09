import io
import json
from pathlib import Path

from sentiment_monitor.relevance import literal_match_status
from sentiment_monitor.sources.instagram import fetch_instagram_mentions
from sentiment_monitor.sources.threads import fetch_threads_mentions
from sentiment_monitor.sources.tiktok import fetch_tiktok_mentions

FIXTURES = Path(__file__).parent / "fixtures" / "scrapecreators"


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_threads_real_fixture_keeps_text_and_joined_hashtag_matches():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(_fixture("threads_timnas.json"))

    result = fetch_threads_mentions(
        "timnas indonesia", "key", "2026-11-09T16:31:00Z", intent="phrase", opener=opener
    )

    assert len(result["mentions"]) == 3
    assert "start_date=2026-11-02" in seen[0]
    assert "end_date=2026-11-10" in seen[0]
    statuses = [
        literal_match_status(
            item["text"], "timnas indonesia", "phrase", hashtags=item.get("hashtags")
        )
        for item in result["mentions"]
    ]
    assert statuses.count("literal_match") == 2
    assert statuses.count("no_literal_match") == 1


def test_tiktok_real_fixture_reads_text_extra_hashtags():
    def opener(request, timeout=0):
        return Response(_fixture("tiktok_keyword_timnas.json"))

    result = fetch_tiktok_mentions(
        "timnas indonesia", "key", "2026-11-09T00:00:00Z", intent="phrase", opener=opener
    )

    assert result["mentions"]
    assert any("timnasindonesia" in item["hashtags"] for item in result["mentions"])
    statuses = [
        literal_match_status(
            item["text"], "timnas indonesia", "phrase", hashtags=item.get("hashtags")
        )
        for item in result["mentions"]
    ]
    assert statuses.count("literal_match") >= 2


def test_instagram_real_hashtag_fixture_follows_the_page_two_cursor():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        if "cursor=2" in request.full_url:
            return Response(_fixture("instagram_hashtag_page2.json"))
        return Response(_fixture("instagram_hashtag_page1.json"))

    result = fetch_instagram_mentions(
        "#indonesia", "key", "2026-11-09T00:00:00Z", intent="hashtag", opener=opener
    )

    assert len(seen) == 2
    assert "cursor=2" in seen[1]
    assert result["counts"]["returned"] == 8
    assert any(item["route_ids"] == ["instagram.hashtag_page2"] for item in result["mentions"])


def test_tiktok_real_hashtag_fixture_uses_both_routes():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(_fixture("tiktok_hashtag_timnas.json"))

    result = fetch_tiktok_mentions(
        "#timnasindonesia", "key", "2026-11-09T00:00:00Z", intent="hashtag", opener=opener
    )

    assert len(seen) == 2
    assert any("hashtag=timnasindonesia" in url for url in seen)
    assert any("query=%23timnasindonesia" in url for url in seen)
    assert result["mentions"]
    assert all(item["hashtags"] for item in result["mentions"])
