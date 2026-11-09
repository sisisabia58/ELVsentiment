import io
import json

import pytest

from sentiment_monitor.sources.tiktok import fetch_tiktok_mentions, normalize_tiktok_item


def test_normalize_tiktok_item_reads_platform_hashtag_lists() -> None:
    mention = normalize_tiktok_item(
        {
            "aweme_info": {
                "aweme_id": "tt-hashtags",
                "desc": "tanpa frasa di sini",
                "create_time": 1794096000,
                "author": {"unique_id": "akun"},
                "text_extra": [{"hashtag_name": "timnasindonesia"}],
                "challenges": [{"cha_name": "fyp"}],
            }
        },
        collected_at="2026-11-08T00:00:00Z",
    )
    assert mention["hashtags"] == ["timnasindonesia", "fyp"]


def test_fetch_tiktok_runs_both_keyword_and_top_with_windows_and_dedupes() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        if "/v1/tiktok/search/keyword" in request.full_url and "cursor=30" in request.full_url:
            return Response(json.dumps({"search_item_list": []}))
        if "/v1/tiktok/search/keyword" in request.full_url:
            return Response(
                json.dumps(
                    {
                        "search_item_list": [
                            {
                                "aweme_info": {
                                    "aweme_id": "tt-1",
                                    "desc": "Review jujur kopi kenangan",
                                    "create_time": 1776578400,
                                    "author": {"unique_id": "foodies_id"},
                                }
                            },
                            {
                                "aweme_info": {
                                    "aweme_id": "tt-dup",
                                    "desc": "Video populer",
                                    "create_time": 1776578400,
                                    "author": {"unique_id": "viral_id"},
                                }
                            },
                        ]
                    }
                )
            )
        return Response(
            json.dumps(
                {
                    "search_item_list": [
                        {
                            "aweme_info": {
                                "aweme_id": "tt-dup",
                                "desc": "Video populer",
                                "create_time": 1776578400,
                                "author": {"unique_id": "viral_id"},
                            }
                        },
                        {
                            "aweme_id": "tt-2",
                            "desc": "Carousel foto menu baru",
                            "create_time": 1776578400,
                            "author": {"unique_id": "katalog_kopi"},
                        },
                    ]
                }
            )
        )

    result = fetch_tiktok_mentions(
        "kopi kenangan",
        "sc-key-tt",
        "2026-04-19T06:00:00Z",
        opener=opener,
    )

    assert len(seen) == 3
    keyword_url, keyword_headers = seen[0]
    top_url, top_headers = seen[1]
    page2_url, page2_headers = seen[2]
    assert keyword_url.startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "query=kopi+kenangan" in keyword_url
    assert "date_posted=this-week" in keyword_url
    assert "region=" not in keyword_url
    assert keyword_headers.get("x-api-key") == "sc-key-tt"

    assert top_url.startswith("https://api.scrapecreators.com/v1/tiktok/search/top?")
    assert "query=kopi+kenangan" in top_url
    assert "publish_time=this-week" in top_url
    assert "region=" not in top_url
    assert top_headers.get("x-api-key") == "sc-key-tt"

    assert page2_url.startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "query=kopi+kenangan" in page2_url
    assert "date_posted=this-week" in page2_url
    assert "cursor=30" in page2_url
    assert page2_headers.get("x-api-key") == "sc-key-tt"

    ids = [m["external_id"] for m in result["mentions"]]
    assert ids == ["tt-1", "tt-dup", "tt-2"]
    assert all(m["source"] == "tiktok" for m in result["mentions"])
    assert result["mentions"][0]["url"] == "https://www.tiktok.com/@foodies_id/video/tt-1"
    assert result["mentions"][0]["posted_at"] == "2026-04-19T06:00:00Z"


class _Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _tiktok(payloads):
    def opener(request, timeout=0):
        if "/v1/tiktok/search/keyword" in request.full_url:
            if "cursor=30" in request.full_url:
                return _Response(json.dumps({"search_item_list": []}))
            return _Response(json.dumps(payloads[0]))
        return _Response(json.dumps(payloads[1]))

    return fetch_tiktok_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)


def test_tiktok_counts_sum_both_calls_and_dedupe():
    result = _tiktok(
        (
            {"search_item_list": [{"aweme_id": "1"}, {"aweme_id": "2"}]},
            {"search_item_list": [{"aweme_id": "2"}, {"aweme_id": "3"}]},
        )
    )
    assert result["counts"] == {"returned": 4, "parsed": 4, "deduplicated": 1}


@pytest.mark.parametrize("key", ["search_item_list", "aweme_list", "items", "data"])
def test_tiktok_accepts_each_key_on_both_endpoints(key):
    assert _tiktok(({key: []}, {key: []}))["counts"]["returned"] == 0


def test_tiktok_wholly_unusable_keyword_list_fails_even_when_top_has_posts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok(
            (
                {"search_item_list": [{}], "credits_charged": 2},
                {"search_item_list": [{"aweme_id": "good"}], "credits_charged": 3},
            )
        )
    assert caught.value.code == "malformed_posts"
    assert caught.value.credits_charged == 2


def test_tiktok_wholly_unusable_top_list_fails_even_when_keyword_has_posts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok(
            (
                {"search_item_list": [{"aweme_id": "good"}], "credits_charged": 3},
                {"search_item_list": [{}], "credits_charged": 2},
            )
        )
    assert caught.value.code == "malformed_posts"
    assert caught.value.credits_charged == 5


def test_tiktok_missing_or_malformed_list_fails_safely():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok(({"unexpected": []}, {"search_item_list": []}))
    assert caught.value.code == "missing_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok(({"search_item_list": {"bad": True}}, {"search_item_list": []}))
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok(({"search_item_list": [1, 2]}, {"search_item_list": []}))
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok(({"search_item_list": [{}]}, {"search_item_list": []}))
    assert caught.value.code == "malformed_posts"


def test_tiktok_scalar_only_second_list_keeps_accumulated_returned():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok(
            (
                {"search_item_list": [{"aweme_id": "1"}], "credits_charged": 2},
                {"search_item_list": [1, 2], "credits_charged": 3},
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


def test_tiktok_malformed_second_endpoint_keeps_its_response_status():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    def opener(request, timeout=0):
        if "/v1/tiktok/search/keyword" in request.full_url:
            return _StatusResponse('{"search_item_list": []}', status=201)
        return _StatusResponse("{not-json", status=202)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)
    assert caught.value.code == "malformed_json"
    assert caught.value.http_status == 202


import urllib.error


class _UnknownStatusResponse(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _tt_opener(first, second):
    def opener(request, timeout=0):
        if "/v1/tiktok/search/keyword" in request.full_url:
            return first
        if isinstance(second, Exception):
            raise second
        return second

    return opener


def test_tiktok_transport_failure_after_first_endpoint_keeps_counts_and_credits():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    first = _StatusResponse(json.dumps({"search_item_list": [{"aweme_id": "1"}], "credits_charged": 2}), status=200)
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions(
            "Kopi",
            "key",
            "2026-11-01T00:00:00Z",
            opener=_tt_opener(first, urllib.error.URLError("synthetic network failure")),
        )
    error = caught.value
    assert error.code == "transport_error"
    assert error.http_status is None
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}
    assert "synthetic" not in str(error)


class _TTReadTimeout(io.StringIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        raise TimeoutError("synthetic read timeout")


def test_tiktok_read_timeout_after_first_endpoint_keeps_current_status_and_counts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    first = _StatusResponse(json.dumps({"search_item_list": [{"aweme_id": "1"}], "credits_charged": 2}), status=200)

    def opener(request, timeout=0):
        if "/v1/tiktok/search/keyword" in request.full_url:
            return first
        return _TTReadTimeout("")

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)
    error = caught.value
    assert error.code == "read_timeout"
    assert error.http_status == 200
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}

def test_tiktok_missing_or_non_list_is_unknown_returned():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    for payload in ({"credits_charged": 2}, {"search_item_list": "not-a-list", "credits_charged": 2}):
        with pytest.raises(ScrapeCreatorsError) as caught:
            fetch_tiktok_mentions(
                "Kopi",
                "key",
                "2026-11-01T00:00:00Z",
                opener=_tt_opener(
                    _StatusResponse(json.dumps(payload), status=200),
                    _StatusResponse('{"search_item_list": []}', status=200),
                ),
            )
        error = caught.value
        assert isinstance(error.counts, dict)
        assert "returned" not in error.counts
        assert error.counts.get("parsed") == 0
        assert error.counts.get("deduplicated") == 0


def test_tiktok_known_first_endpoint_then_missing_second_is_partial_not_zero():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    first = _StatusResponse(json.dumps({"search_item_list": [{"aweme_id": "1"}], "credits_charged": 2}), status=200)
    second = _StatusResponse(json.dumps({"credits_charged": 3}), status=200)
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=_tt_opener(first, second))
    assert caught.value.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}
    assert caught.value.credits_charged == 5



def test_tiktok_unknown_status_on_second_endpoint_does_not_inherit_first_status():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    first = _StatusResponse(json.dumps({"search_item_list": [{"aweme_id": "1"}], "credits_charged": 2}), status=201)
    second = _UnknownStatusResponse("{")
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=_tt_opener(first, second))
    error = caught.value
    assert error.code == "malformed_json"
    assert error.http_status is None
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}


def test_tiktok_phrase_calls_keyword_top_and_page2_without_region_or_sort_by():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"search_item_list": []}))

    fetch_tiktok_mentions("Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert len(seen) == 3
    assert seen[0].startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "date_posted=this-week" in seen[0]
    assert "cursor=" not in seen[0]
    assert seen[1].startswith("https://api.scrapecreators.com/v1/tiktok/search/top?")
    assert "publish_time=this-week" in seen[1]
    assert "cursor=" not in seen[1]
    assert seen[2].startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "date_posted=this-week" in seen[2]
    assert "cursor=30" in seen[2]
    assert all("region=" not in url for url in seen)
    assert all("sort_by=" not in url for url in seen)


def test_tiktok_hashtag_calls_hashtag_and_keyword_tag_routes():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"search_item_list": [{"aweme_id": "tt-1", "desc": "#Kopi"}]}))

    result = fetch_tiktok_mentions("#Kopi Kenangan", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    assert len(seen) == 2
    assert seen[0].startswith("https://api.scrapecreators.com/v1/tiktok/search/hashtag?")
    assert "hashtag=kopikenangan" in seen[0]
    assert seen[1].startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "query=%23kopikenangan" in seen[1]
    assert "date_posted=this-week" in seen[1]
    assert all("region=" not in url for url in seen)
    assert result["mentions"][0]["route_id"] == "tiktok.hashtag"


def test_tiktok_same_post_on_all_routes_keeps_all_route_ids():
    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        return Response(json.dumps({"items": [{"aweme_id": "same", "desc": "kopi", "create_time": 1794096000}]}))

    result = fetch_tiktok_mentions("Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert len(result["mentions"]) == 1
    assert result["mentions"][0]["route_ids"] == [
        "tiktok.keyword",
        "tiktok.top",
        "tiktok.keyword_page2",
    ]


def test_tiktok_partial_window_failure_preserves_parsed_count():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    class Response(io.StringIO):
        def __init__(self, body, status=200):
            super().__init__(body)
            self.status = status

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    first = Response(
        json.dumps(
            {"items": [{"aweme_id": "stale", "desc": "alpha", "create_time": 1577836800}], "credits_charged": 2}
        ),
        status=200,
    )
    second = Response("{", status=200)
    responses = iter([first, second])

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions(
            "alpha", "key", "2026-11-09T00:00:00Z", intent="phrase", opener=lambda *a, **k: next(responses)
        )
    error = caught.value
    assert error.code == "malformed_json"
    assert error.http_status == 200
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}


def test_tiktok_partial_failure_with_fresh_first_route_and_http_second_keeps_parsed_and_credits():
    import urllib.error

    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    class Response(io.StringIO):
        def __init__(self, body, status=200):
            super().__init__(body)
            self.status = status

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    first = Response(
        json.dumps(
            {"items": [{"aweme_id": "fresh", "desc": "alpha", "create_time": 1794096000}], "credits_charged": 2}
        ),
        status=200,
    )

    def opener(request, timeout=0):
        if "/v1/tiktok/search/keyword" in request.full_url:
            return first
        raise urllib.error.HTTPError(request.full_url, 503, "down", {}, None)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions("alpha", "key", "2026-11-09T00:00:00Z", intent="phrase", opener=opener)
    error = caught.value
    assert error.code == "http_503"
    assert error.http_status == 503
    assert error.credits_charged == 2
    assert error.counts == {"returned": 1, "parsed": 1, "deduplicated": 0}
