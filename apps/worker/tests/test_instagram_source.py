import io
import json

import pytest

from sentiment_monitor.sources.instagram import (
    fetch_instagram_mentions,
    normalize_hashtag,
    normalize_instagram_item,
)


def test_normalize_hashtag_strips_hash_and_spaces() -> None:
    assert normalize_hashtag("#Kopi Kenangan!") == "kopikenangan"
    assert normalize_hashtag("  @kopi_kenangan ") == "kopi_kenangan"


def test_fetch_instagram_runs_both_reels_and_hashtag_with_id_region_and_dedupes() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        if "/v2/instagram/reels/search" in request.full_url:
            return Response(
                json.dumps(
                    {
                        "reels": [
                            {
                                "pk": "ig-1",
                                "code": "REEL1",
                                "taken_at": 1776578400,
                                "caption": {"text": "Reel kopi kenangan"},
                                "user": {"username": "siti"},
                            },
                            {
                                "pk": "ig-dup",
                                "code": "DUP1",
                                "taken_at": 1776578400,
                                "caption": {"text": "Muncul di dua tempat"},
                                "user": {"username": "agus"},
                            },
                        ]
                    }
                )
            )
        return Response(
            json.dumps(
                {
                    "posts": [
                        {
                            "pk": "ig-dup",
                            "code": "DUP1",
                            "taken_at": 1776578400,
                            "caption": {"text": "Muncul di dua tempat"},
                            "user": {"username": "agus"},
                        },
                        {
                            "pk": "ig-2",
                            "shortcode": "POST2",
                            "taken_at_timestamp": 1776578400,
                            "caption": "Postingan hashtag kopi kenangan",
                            "owner": {"username": "dewi"},
                        },
                    ]
                }
            )
        )

    result = fetch_instagram_mentions(
        "Kopi Kenangan",
        "sc-key-ig",
        "2026-04-19T06:00:00Z",
        opener=opener,
    )

    assert len(seen) == 2
    reels_url, reels_headers = seen[0]
    hashtag_url, hashtag_headers = seen[1]
    assert reels_url.startswith("https://api.scrapecreators.com/v2/instagram/reels/search?")
    assert "query=Kopi+Kenangan" in reels_url
    assert "region=ID" in reels_url
    assert reels_headers.get("x-api-key") == "sc-key-ig"

    assert hashtag_url.startswith("https://api.scrapecreators.com/v1/instagram/search/hashtag?")
    assert "hashtag=kopikenangan" in hashtag_url
    assert "region=ID" in hashtag_url
    assert hashtag_headers.get("x-api-key") == "sc-key-ig"

    ids = [m["external_id"] for m in result["mentions"]]
    assert ids == ["ig-1", "ig-dup", "ig-2"]
    assert all(m["source"] == "instagram" for m in result["mentions"])
    assert result["mentions"][0]["url"] == "https://www.instagram.com/p/REEL1/"
    assert result["mentions"][2]["author"] == "dewi"


class _Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _instagram(payloads):
    def opener(request, timeout=0):
        if "/v2/instagram/reels/search" in request.full_url:
            return _Response(json.dumps(payloads[0]))
        return _Response(json.dumps(payloads[1]))

    return fetch_instagram_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)


def test_instagram_counts_sum_both_calls_and_dedupe():
    result = _instagram(
        (
            {"reels": [{"pk": "1"}, {"pk": "2"}]},
            {"posts": [{"pk": "2"}, {"pk": "3"}]},
        )
    )
    assert result["counts"] == {"returned": 4, "parsed": 4, "deduplicated": 1}


@pytest.mark.parametrize("key", ["reels", "items", "data"])
def test_instagram_reels_accepts_each_key(key):
    assert _instagram(({key: []}, {"posts": []}))["counts"]["returned"] == 0


@pytest.mark.parametrize("key", ["posts", "items", "medias", "data"])
def test_instagram_hashtag_accepts_each_key(key):
    assert _instagram(({"reels": []}, {key: []}))["counts"]["returned"] == 0


def test_instagram_missing_or_malformed_list_fails_safely():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram(({"unexpected": []}, {"posts": []}))
    assert caught.value.code == "missing_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram(({"reels": {"bad": True}}, {"posts": []}))
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram(({"reels": [1, 2]}, {"posts": []}))
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram(({"reels": [{}]}, {"posts": []}))
    assert caught.value.code == "malformed_posts"
