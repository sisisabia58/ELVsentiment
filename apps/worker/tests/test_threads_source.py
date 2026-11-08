import io
import json
import urllib.error

import pytest

from sentiment_monitor.sources.collect import collect_project_sources
from sentiment_monitor.sources.threads import fetch_threads_mentions, normalize_threads_item


def test_threads_mentions_keep_null_posted_at_when_source_omits_timestamp() -> None:
    mention = normalize_threads_item(
        {
            "pk": "th-1",
            "code": "C123",
            "caption": {"text": "Kopi Kenangan baru"},
            "user": {"username": "rina"},
        },
        collected_at="2026-04-19T06:00:00Z",
    )

    assert mention["external_id"] == "th-1"
    assert mention["source"] == "threads"
    assert mention["author"] == "rina"
    assert mention["text"] == "Kopi Kenangan baru"
    assert mention["url"] == "https://www.threads.com/@rina/post/C123"
    assert mention["posted_at"] is None
    assert mention["collected_at"] == "2026-04-19T06:00:00Z"


def test_fetch_threads_calls_scrapecreators_with_id_region_and_api_key() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        return Response(
            json.dumps(
                {
                    "success": True,
                    "posts": [
                        {
                            "pk": "th-99",
                            "code": "D999",
                            "taken_at": 1776578400,
                            "caption": {"text": "Suka banget Kopi Kenangan"},
                            "user": {"username": "budi"},
                        }
                    ],
                }
            )
        )

    result = fetch_threads_mentions(
        "kopi kenangan",
        "sc-secret-key",
        "2026-04-19T06:00:00Z",
        opener=opener,
    )

    assert len(seen) == 1
    url, headers = seen[0]
    assert url.startswith("https://api.scrapecreators.com/v1/threads/search?")
    assert "query=kopi+kenangan" in url
    assert "region=ID" in url
    assert headers.get("x-api-key") == "sc-secret-key"
    assert result["outcome"] == "empty_or_success"
    assert len(result["mentions"]) == 1
    assert result["mentions"][0]["external_id"] == "th-99"
    assert result["mentions"][0]["posted_at"] == "2026-04-19T06:00:00Z"


def test_one_failing_source_does_not_discard_other_sources() -> None:
    def fail_x():
        raise urllib.error.HTTPError("https://api.x.com", 503, "unavailable", {}, None)

    def ok_threads():
        return {
            "mentions": [
                normalize_threads_item(
                    {"id": "th-2", "text": "Masih jalan", "timestamp": "2026-04-19T05:00:00Z"},
                    collected_at="2026-04-19T06:00:00Z",
                )
            ]
        }

    result = collect_project_sources({"x": fail_x, "threads": ok_threads})

    assert result["sources"]["x"]["state"] == "unavailable"
    assert result["sources"]["x"]["outcome"] == "failed"
    assert result["sources"]["threads"]["state"] == "ready"
    assert len(result["mentions"]) == 1
    assert result["mentions"][0]["external_id"] == "th-2"


class _Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _threads(payload):
    return fetch_threads_mentions(
        "kopi",
        "key",
        "2026-11-01T00:00:00Z",
        opener=lambda *args, **kwargs: _Response(json.dumps(payload)),
    )


def test_threads_present_empty_list_is_success_with_zero_counts():
    result = _threads({"posts": []})
    assert result["mentions"] == []
    assert result["counts"] == {"returned": 0, "parsed": 0, "deduplicated": 0}


def test_threads_reports_returned_parsed_and_deduplicated():
    result = _threads({"posts": [{"pk": "1"}, {"pk": "1"}, {"pk": "2"}]})
    assert result["counts"] == {"returned": 3, "parsed": 3, "deduplicated": 1}


@pytest.mark.parametrize("key", ["posts", "items", "data"])
def test_threads_accepts_each_recognized_key(key):
    assert _threads({key: []})["counts"]["returned"] == 0


def test_threads_unusable_list_failure_carries_known_credits():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": [{}], "credits_charged": 3})
    assert caught.value.code == "malformed_posts"
    assert caught.value.credits_charged == 3


def test_threads_missing_or_malformed_list_fails_safely():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"unexpected": []})
    assert caught.value.code == "missing_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": {"bad": True}})
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": [1, 2]})
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": [{}]})
    assert caught.value.code == "malformed_posts"


def test_threads_scalar_only_list_keeps_raw_returned_count():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": [1, 2], "credits_charged": 2})
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


def test_threads_success_result_keeps_known_response_status():
    result = fetch_threads_mentions(
        "kopi",
        "key",
        "2026-11-01T00:00:00Z",
        opener=lambda *args, **kwargs: _StatusResponse('{"posts": []}', status=200),
    )
    assert result["http_status"] == 200


def test_threads_transport_failure_is_typed_without_accumulated_counts():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_threads_mentions(
            "kopi",
            "key",
            "2026-11-01T00:00:00Z",
            opener=lambda *args, **kwargs: (_ for _ in ()).throw(
                urllib.error.URLError("synthetic network failure")
            ),
        )
    error = caught.value
    assert error.code == "transport_error"
    assert error.http_status is None
    assert error.counts is None
    assert "synthetic" not in str(error)


class _ThreadsReadTimeout(io.StringIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        raise TimeoutError("synthetic read timeout")


def test_threads_read_timeout_keeps_known_response_status():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_threads_mentions(
            "kopi",
            "key",
            "2026-11-01T00:00:00Z",
            opener=lambda *args, **kwargs: _ThreadsReadTimeout(""),
        )
    assert caught.value.code == "read_timeout"
    assert caught.value.http_status == 200

def test_threads_missing_or_non_list_marks_returned_unknown():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    for payload in ({"credits_charged": 2}, {"posts": "not-a-list", "credits_charged": 2}):
        with pytest.raises(ScrapeCreatorsError) as caught:
            fetch_threads_mentions(
                "kopi",
                "key",
                "2026-11-01T00:00:00Z",
                opener=lambda *args, _payload=payload, **kwargs: _StatusResponse(json.dumps(_payload), status=200),
            )
        error = caught.value
        assert error.code in ("missing_posts", "malformed_posts")
        assert error.counts is None or error.counts.get("returned") is None
        assert error.http_status == 200
