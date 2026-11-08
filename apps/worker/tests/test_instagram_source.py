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


def test_instagram_wholly_unusable_reels_list_fails_even_when_hashtag_has_posts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram(
            (
                {"reels": [{}], "credits_charged": 2},
                {"posts": [{"pk": "good"}], "credits_charged": 3},
            )
        )
    assert caught.value.code == "malformed_posts"
    assert caught.value.credits_charged == 2


def test_instagram_wholly_unusable_hashtag_list_fails_even_when_reels_has_posts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram(
            (
                {"reels": [{"pk": "good"}], "credits_charged": 3},
                {"posts": [{}], "credits_charged": 2},
            )
        )
    assert caught.value.code == "malformed_posts"
    assert caught.value.credits_charged == 5


def test_instagram_partial_failure_keeps_first_endpoint_counts_and_credits():
    import urllib.error

    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    def opener(request, timeout=0):
        if "/v2/instagram/reels/search" in request.full_url:
            return _Response(
                json.dumps(
                    {
                        "reels": [{"pk": "1"}, {"pk": "2"}],
                        "credits_charged": 3,
                    }
                )
            )
        raise urllib.error.HTTPError(request.full_url, 500, "server error", {}, None)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)
    error = caught.value
    assert error.code == "http_500"
    assert error.http_status == 500
    assert error.credits_charged == 3
    assert error.counts == {"returned": 2, "parsed": 2, "deduplicated": 0}


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


def test_instagram_scalar_only_second_list_keeps_accumulated_returned():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram(
            (
                {"reels": [{"pk": "1"}], "credits_charged": 2},
                {"posts": [1, 2], "credits_charged": 3},
            )
        )
    assert caught.value.code == "malformed_posts"
    assert caught.value.counts == {"returned": 3, "parsed": 1, "deduplicated": 0}
    assert caught.value.credits_charged == 5


class _StatusResponse(io.StringIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_instagram_uses_last_attempted_endpoint_status():
    def opener(request, timeout=0):
        if "/v2/instagram/reels/search" in request.full_url:
            return _StatusResponse('{"reels": []}', status=201)
        return _StatusResponse('{"posts": []}', status=200)

    result = fetch_instagram_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)
    assert result["http_status"] == 200


import urllib.error


class _UnknownStatusResponse(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _ig_opener(first, second):
    def opener(request, timeout=0):
        if "/v2/instagram/reels/search" in request.full_url:
            return first
        if isinstance(second, Exception):
            raise second
        return second

    return opener


def test_instagram_transport_failure_after_first_endpoint_keeps_counts_and_credits():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    first = _StatusResponse(json.dumps({"reels": [{"pk": "1"}], "credits_charged": 2}), status=200)
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions(
            "Kopi",
            "key",
            "2026-11-01T00:00:00Z",
            opener=_ig_opener(first, urllib.error.URLError("synthetic network failure")),
        )
    error = caught.value
    assert error.code == "transport_error"
    assert error.http_status is None
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}
    assert "synthetic" not in str(error)


def test_instagram_read_timeout_after_first_endpoint_keeps_current_status_and_counts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    first = _StatusResponse(json.dumps({"reels": [{"pk": "1"}], "credits_charged": 2}), status=200)
    second = _StatusResponse("", status=200)

    def opener(request, timeout=0):
        if "/v2/instagram/reels/search" in request.full_url:
            return first
        return _ReadTimeout()

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)
    error = caught.value
    assert error.code == "read_timeout"
    assert error.http_status == 200
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}


class _ReadTimeout(io.StringIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        raise TimeoutError("synthetic read timeout")

