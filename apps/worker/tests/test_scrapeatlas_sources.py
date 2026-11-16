import io
import json
from pathlib import Path
import urllib.error

import pytest

from sentiment_monitor.providers.scrapeatlas import ScrapeAtlasError
from sentiment_monitor.providers.scrapeatlas_sources import (
    fetch_scrapeatlas_threads,
    fetch_scrapeatlas_tiktok,
)

FIXTURES = Path(__file__).parent / "fixtures" / "scrapeatlas"
RECENT = 1794754670
OLD = 1750000000


class Response(io.StringIO):
    def __init__(self, payload, status=200, headers=None):
        super().__init__(json.dumps(payload))
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_threads_uses_recent_true_and_filters_dates_locally():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(
            {"success": True, "status": "success", "posts": [
                {"pk": "old", "caption": {"text": "barayam lama"}, "taken_at": OLD,
                 "user": {"username": "a"}},
                {"pk": "new", "caption": {"text": "barayam baru"}, "taken_at": RECENT,
                 "user": {"username": "b"}},
            ], "coverage": {"warnings": []}},
            headers={"x-credits-charged": "1"},
        )

    result = fetch_scrapeatlas_threads("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener, date_window_days=7)
    assert "recent=true" in seen[0]
    assert "region=ID" in seen[0]
    assert [post.external_id for post in result.posts] == ["new"]
    assert result.calls[0].credits_charged == 1
    assert result.calls[0].safe_detail == "ok"


def test_tiktok_ignores_provider_date_filter_and_filters_locally():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(
            {"success": True, "status": "success", "search_item_list": [
                {"aweme_id": "old", "desc": "barayam lama", "create_time": OLD,
                 "author": {"unique_id": "a"}},
                {"aweme_id": "new", "desc": "barayam baru", "create_time": RECENT,
                 "author": {"unique_id": "b"}},
            ], "coverage": {"warnings": ["search_filters_ignored"]}},
            headers={"x-credits-charged": "1"},
        )

    result = fetch_scrapeatlas_tiktok("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener, date_window_days=7)
    assert [post.external_id for post in result.posts] == ["new"]
    assert result.calls[0].credits_charged == 1
    assert "region=ID" in seen[0]
    assert "date_posted" not in seen[0]
    assert "start_date" not in seen[0]


def test_threads_fixture_maps_enrichment_and_keeps_partial_as_answered():
    payload = fixture("threads_recent.json")

    def opener(request, timeout=0):
        return Response(payload, headers={"x-credits-charged": "1"})

    result = fetch_scrapeatlas_threads("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.state == "answered"
    assert len(result.posts) == 2
    first = result.posts[0]
    assert first.platform == "threads"
    assert first.source_provider == "scrapeatlas"
    assert first.routes == ("scrapeatlas.threads.recent",)
    assert first.author_handle
    assert first.thumbnail_url.startswith("https://example.invalid/")
    assert first.likes is not None
    assert result.calls[0].outcome == "partial"


def test_tiktok_fixture_maps_stats_and_cover():
    payload = fixture("tiktok_keyword.json")

    def opener(request, timeout=0):
        return Response(payload, headers={"x-credits-charged": "1"})

    result = fetch_scrapeatlas_tiktok("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.state == "answered"
    assert result.posts[0].source_provider == "scrapeatlas"
    assert result.posts[0].routes == ("scrapeatlas.tiktok.keyword",)
    assert result.posts[0].thumbnail_url.startswith("https://example.invalid/")
    assert result.posts[0].likes is not None


def test_404_not_found_is_answered_with_zero_posts_and_zero_credits():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url, 404, "not found", {},
            io.BytesIO(json.dumps({"success": False, "status": "failed",
                                   "failure": {"code": "not_found"}}).encode()),
        )

    result = fetch_scrapeatlas_threads("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.state == "answered"
    assert result.posts == []
    assert result.calls[0].credits_charged == 0
    assert result.calls[0].http_status == 404


def test_200_with_status_failed_becomes_failed_and_inserts_no_rows():
    payload = fixture("failed_status.json")

    def opener(request, timeout=0):
        return Response(payload, headers={"x-credits-charged": "1"})

    result = fetch_scrapeatlas_threads("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.state == "failed"
    assert result.safe_detail == "failed_status"
    assert result.posts == []


def test_429_failure_keeps_only_safe_metadata():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url, 429, "busy synthetic-key prompt", {"Retry-After": "2"},
            io.BytesIO(b'{"failure":{"code":"busy"},"prompt":"synthetic-key"}'),
        )

    result = fetch_scrapeatlas_tiktok("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.state == "failed"
    assert result.safe_detail == "http_429"
    assert result.posts == []
    assert "synthetic-key" not in repr(result)
    assert "prompt" not in repr(result)
