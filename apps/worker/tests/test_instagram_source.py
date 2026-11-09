import io
import json

import pytest

from sentiment_monitor.sources.instagram import (
    INSTAGRAM_PAGE2_LITERAL_MIN_PERCENT,
    INSTAGRAM_PAGE2_MIN_PAGE_SIZE,
    fetch_instagram_mentions,
    normalize_hashtag,
    normalize_instagram_item,
    should_fetch_instagram_page2,
)


def test_normalize_hashtag_strips_hash_and_spaces() -> None:
    assert normalize_hashtag("#Kopi Kenangan!") == "kopikenangan"
    assert normalize_hashtag("  @kopi_kenangan ") == "kopi_kenangan"


def test_fetch_instagram_phrase_uses_reels_route_with_api_key_and_dedupes() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        if "/v1/instagram/search/hashtag" in request.full_url:
            return Response(json.dumps({"posts": []}))
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
                            "caption": {"text": "Muncul dua kali"},
                            "user": {"username": "agus"},
                        },
                        {
                            "pk": "ig-dup",
                            "code": "DUP1",
                            "taken_at": 1776578400,
                            "caption": {"text": "Muncul dua kali"},
                            "user": {"username": "agus"},
                        },
                    ]
                }
            )
        )

    result = fetch_instagram_mentions(
        "Kopi Kenangan",
        "sc-key-ig",
        "2026-04-19T06:00:00Z",
        intent="phrase",
        opener=opener,
    )

    assert len(seen) == 2
    url, headers = seen[0]
    assert url.startswith("https://api.scrapecreators.com/v2/instagram/reels/search?")
    assert "query=Kopi+Kenangan" in url
    assert "date_posted=last-week" in url
    assert "region=" not in url
    assert headers.get("x-api-key") == "sc-key-ig"
    hashtag_url, hashtag_headers = seen[1]
    assert hashtag_url.startswith("https://api.scrapecreators.com/v1/instagram/search/hashtag?")
    assert "hashtag=kopikenangan" in hashtag_url
    assert "date_posted=last-week" in hashtag_url
    assert hashtag_headers.get("x-api-key") == "sc-key-ig"

    ids = [m["external_id"] for m in result["mentions"]]
    assert ids == ["ig-1", "ig-dup"]
    assert all(m["source"] == "instagram" for m in result["mentions"])
    assert result["mentions"][0]["url"] == "https://www.instagram.com/p/REEL1/"


class _Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _instagram(payload, *, intent="phrase"):
    def opener(request, timeout=0):
        if intent == "phrase" and "/v1/instagram/search/hashtag" in request.full_url:
            return _Response(json.dumps({"posts": []}))
        return _Response(json.dumps(payload))

    return fetch_instagram_mentions(
        "Kopi",
        "key",
        "2026-11-01T00:00:00Z",
        intent=intent,
        opener=opener,
    )


def test_instagram_counts_returned_parsed_and_deduplicated():
    result = _instagram({"reels": [{"pk": "1"}, {"pk": "2"}, {"pk": "2"}]})
    assert result["counts"] == {"returned": 3, "parsed": 3, "deduplicated": 1}


@pytest.mark.parametrize("key", ["reels", "items", "data"])
def test_instagram_reels_accepts_each_key(key):
    assert _instagram({key: []})["counts"]["returned"] == 0


@pytest.mark.parametrize("key", ["posts", "items", "medias", "data"])
def test_instagram_hashtag_accepts_each_key(key):
    assert _instagram({key: []}, intent="hashtag")["counts"]["returned"] == 0


def test_instagram_wholly_unusable_list_fails_with_credits():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram({"reels": [{}], "credits_charged": 2})
    assert caught.value.code == "malformed_posts"
    assert caught.value.credits_charged == 2


def test_instagram_missing_or_malformed_list_fails_safely():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram({"unexpected": []})
    assert caught.value.code == "missing_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram({"reels": {"bad": True}})
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram({"reels": [1, 2]})
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram({"reels": [{}]})
    assert caught.value.code == "malformed_posts"


def test_instagram_scalar_only_list_keeps_raw_returned_count():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram({"reels": [1, 2], "credits_charged": 2})
    assert caught.value.code == "malformed_posts"
    assert caught.value.counts == {"returned": 2, "parsed": 0, "deduplicated": 0}
    assert caught.value.credits_charged == 2


class _StatusResponse(io.StringIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_instagram_success_result_keeps_known_response_status():
    def opener(request, timeout=0):
        if "/v1/instagram/search/hashtag" in request.full_url:
            return _StatusResponse('{"posts": []}', status=201)
        return _StatusResponse('{"reels": []}', status=201)

    result = fetch_instagram_mentions(
        "Kopi",
        "key",
        "2026-11-01T00:00:00Z",
        intent="phrase",
        opener=opener,
    )
    assert result["http_status"] == 201


class _UnknownStatusResponse(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


import urllib.error


def test_instagram_transport_failure_is_typed_without_accumulated_counts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions(
            "Kopi",
            "key",
            "2026-11-01T00:00:00Z",
            intent="phrase",
            opener=lambda *args, **kwargs: (_ for _ in ()).throw(
                urllib.error.URLError("synthetic network failure")
            ),
        )
    error = caught.value
    assert error.code == "transport_error"
    assert error.http_status is None
    assert error.counts is None
    assert "synthetic" not in str(error)


class _ReadTimeout(io.StringIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        raise TimeoutError("synthetic read timeout")


def test_instagram_read_timeout_keeps_known_response_status():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions(
            "Kopi",
            "key",
            "2026-11-01T00:00:00Z",
            intent="phrase",
            opener=lambda *args, **kwargs: _ReadTimeout(""),
        )
    assert caught.value.code == "read_timeout"
    assert caught.value.http_status == 200


def test_instagram_malformed_json_with_unknown_status_does_not_invent_status():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions(
            "Kopi",
            "key",
            "2026-11-01T00:00:00Z",
            intent="phrase",
            opener=lambda *args, **kwargs: _UnknownStatusResponse("{"),
        )
    error = caught.value
    assert error.code == "malformed_json"
    assert error.http_status is None


def test_instagram_missing_or_non_list_is_unknown_returned():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    for payload in ({"credits_charged": 2}, {"reels": "not-a-list", "credits_charged": 2}):
        with pytest.raises(ScrapeCreatorsError) as caught:
            fetch_instagram_mentions(
                "Kopi",
                "key",
                "2026-11-01T00:00:00Z",
                intent="phrase",
                opener=lambda *args, _payload=payload, **kwargs: _StatusResponse(
                    json.dumps(_payload), status=200
                ),
            )
        error = caught.value
        assert isinstance(error.counts, dict)
        assert "returned" not in error.counts
        assert error.counts.get("parsed") == 0
        assert error.counts.get("deduplicated") == 0


def test_instagram_phrase_calls_reels_then_joined_hashtag_without_region():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        if "/v1/instagram/search/hashtag" in request.full_url:
            return Response(json.dumps({"posts": []}))
        return Response(json.dumps({"reels": [{"pk": "ig-1", "caption": "Kopi"}]}))

    result = fetch_instagram_mentions("Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert len(seen) == 2
    assert seen[0].startswith("https://api.scrapecreators.com/v2/instagram/reels/search?")
    assert "query=Kopi" in seen[0]
    assert "date_posted=last-week" in seen[0]
    assert seen[1].startswith("https://api.scrapecreators.com/v1/instagram/search/hashtag?")
    assert "hashtag=kopi" in seen[1]
    assert "date_posted=last-week" in seen[1]
    assert all("region=" not in url for url in seen)
    assert result["mentions"][0]["route_ids"] == ["instagram.reels"]


def test_instagram_hashtag_calls_only_hashtag_with_compact_term():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"posts": [{"pk": "ig-2", "caption": "#Kopi"}]}))

    result = fetch_instagram_mentions("#Kopi Kenangan", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    assert len(seen) == 1
    assert seen[0].startswith("https://api.scrapecreators.com/v1/instagram/search/hashtag?")
    assert "hashtag=kopikenangan" in seen[0]
    assert "date_posted=last-week" in seen[0]
    assert "region=" not in seen[0]
    assert result["mentions"][0]["route_id"] == "instagram.hashtag"


def _ig_hashtag_payload(literal, total, *, cursor="2", prefix="p"):
    posts = []
    for index in range(total):
        posts.append(
            {
                "id": f"{prefix}{index}",
                "caption": "#kopi" if index < literal else "#other",
                "taken_at": 1794096000,
            }
        )
    payload = {"posts": posts, "credits_charged": 1}
    if cursor is not None:
        payload["cursor"] = cursor
    return payload


def test_instagram_page2_threshold_constants_and_boundaries():
    assert INSTAGRAM_PAGE2_LITERAL_MIN_PERCENT == 60
    assert INSTAGRAM_PAGE2_MIN_PAGE_SIZE == 5
    assert should_fetch_instagram_page2(5, 10, "2") is False
    assert should_fetch_instagram_page2(6, 10, "2") is True
    assert should_fetch_instagram_page2(7, 10, "2") is True
    assert should_fetch_instagram_page2(4, 4, "2") is False
    assert should_fetch_instagram_page2(5, 5, "2") is True
    assert should_fetch_instagram_page2(0, 0, "2") is False
    assert should_fetch_instagram_page2(6, 10, None) is False


def test_instagram_hashtag_page2_fetches_at_threshold_with_route_provenance():
    page1 = _ig_hashtag_payload(6, 10, cursor="2")
    page2 = _ig_hashtag_payload(3, 3, cursor="3", prefix="q")
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        if "cursor=2" in request.full_url:
            return Response(json.dumps(page2))
        return Response(json.dumps(page1))

    result = fetch_instagram_mentions("#kopi", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    assert len(seen) == 2
    assert "cursor=2" in seen[1]
    assert "date_posted=last-week" in seen[1]
    assert result["counts"]["returned"] == 13
    assert any(item["route_ids"] == ["instagram.hashtag_page2"] for item in result["mentions"])


def test_instagram_hashtag_does_not_page_below_threshold():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps(_ig_hashtag_payload(5, 10, cursor="2")))

    result = fetch_instagram_mentions("#kopi", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    assert len(seen) == 1
    assert result["counts"]["returned"] == 10


def test_instagram_hashtag_does_not_page_empty_or_without_a_cursor():
    for payload in ({"posts": [], "cursor": "2"}, _ig_hashtag_payload(10, 10, cursor=None)):
        seen = []

        class Response(io.StringIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def opener(request, timeout=0):
            seen.append(request.full_url)
            return Response(json.dumps(payload))

        fetch_instagram_mentions("#kopi", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
        assert len(seen) == 1


def test_instagram_hashtag_page2_failure_preserves_page1_counts_and_credits():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    page1 = _ig_hashtag_payload(6, 10, cursor="2")
    page1["credits_charged"] = 2

    class Response(io.StringIO):
        def __init__(self, body, status=200):
            super().__init__(body)
            self.status = status

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        if "cursor=2" in request.full_url:
            return Response("{not-json")
        return Response(json.dumps(page1))

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions("#kopi", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    error = caught.value
    assert error.code == "malformed_json"
    assert error.credits_charged == 2
    assert error.counts == {"returned": 10, "parsed": 10, "deduplicated": 0}


def test_instagram_drops_a_stale_item_only_when_the_route_has_a_window():
    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        if "/v1/instagram/search/hashtag" in request.full_url:
            return Response(json.dumps({"posts": []}))
        return Response(
            json.dumps(
                {
                    "reels": [
                        {"pk": "fresh", "taken_at": 1794096000},
                        {"pk": "stale", "taken_at": 1791417600},
                    ]
                }
            )
        )

    result = fetch_instagram_mentions("Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert [item["external_id"] for item in result["mentions"]] == ["fresh"]
    assert result["counts"] == {
        "returned": 2,
        "parsed": 2,
        "deduplicated": 0,
        "dropped_out_of_window": 1,
    }


def test_instagram_empty_zero_credit_is_known_zero_not_unknown():
    result = _instagram({"reels": [], "credits_charged": 0})
    assert result["credits_charged"] == 0
    assert result["counts"]["returned"] == 0


def test_instagram_empty_missing_credit_is_unknown():
    result = _instagram({"reels": []})
    assert result["credits_charged"] is None


def test_instagram_hashtag_empty_zero_credit_is_known_zero():
    result = _instagram({"posts": [], "credits_charged": 0}, intent="hashtag")
    assert result["credits_charged"] == 0


def test_instagram_second_route_failure_preserves_first_route_counts_and_credits():
    import urllib.error

    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        if "/v1/instagram/search/hashtag" in request.full_url:
            raise urllib.error.HTTPError(request.full_url, 500, "down", {}, None)
        return Response(
            json.dumps(
                {
                    "reels": [
                        {
                            "pk": "ig-keep",
                            "taken_at": 1794096000,
                            "caption": "Kopi",
                        }
                    ],
                    "credits_charged": 2,
                }
            )
        )

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions(
            "Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener
        )
    error = caught.value
    assert error.code == "http_500"
    assert error.http_status == 500
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}
