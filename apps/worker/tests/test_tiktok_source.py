import io
import json

import pytest

from sentiment_monitor.sources.tiktok import fetch_tiktok_mentions, normalize_tiktok_item


def test_fetch_tiktok_runs_both_keyword_and_top_with_id_region_and_dedupes() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
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

    assert len(seen) == 2
    keyword_url, keyword_headers = seen[0]
    top_url, top_headers = seen[1]
    assert keyword_url.startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "query=kopi+kenangan" in keyword_url
    assert "region=ID" in keyword_url
    assert keyword_headers.get("x-api-key") == "sc-key-tt"

    assert top_url.startswith("https://api.scrapecreators.com/v1/tiktok/search/top?")
    assert "query=kopi+kenangan" in top_url
    assert "region=ID" in top_url
    assert top_headers.get("x-api-key") == "sc-key-tt"

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
