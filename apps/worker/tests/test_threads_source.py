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
