import io
import json
import urllib.error

import pytest

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import CanonicalPost
from sentiment_monitor.providers.scrapecreators_adapter import (
    PlatformFetch,
    fetch_scrapecreators_platform,
)
from sentiment_monitor.sources.instagram import normalize_instagram_item
from sentiment_monitor.sources.threads import normalize_threads_item
from sentiment_monitor.sources.tiktok import normalize_tiktok_item

RECENT = 1794754670


class Response(io.StringIO):
    status = 200

    def __init__(self, payload, headers=None):
        super().__init__(json.dumps(payload))
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_threads_adapter_keeps_engagement_media_and_credits():
    def opener(request, timeout=0):
        return Response({
            "posts": [{
                "pk": "th1", "code": "C1", "caption": {"text": "barayam enak"},
                "user": {"username": "rina", "full_name": "Rina"},
                "taken_at": RECENT, "like_count": 42,
                "text_post_app_info": {"direct_reply_count": 7, "repost_count": 3, "quote_count": 1},
                "image_versions2": {"candidates": [{"url": "https://img/threads.jpg"}]},
            }],
            "credits_charged": 1,
        })

    result = fetch_scrapecreators_platform(
        "threads", Keyword("barayam"), api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener,
    )
    post = result.posts[0]
    assert (post.platform, post.external_id, post.likes, post.replies, post.shares) == (
        "threads", "th1", 42, 7, 3
    )
    assert post.thumbnail_url == "https://img/threads.jpg"
    assert post.author_handle == "rina"
    assert post.author_name == "Rina"
    assert post.relevance == "literal_match"
    assert post.source_provider == "scrapecreators"
    assert post.routes == ("threads.keyword",)
    assert result.calls[0].credits_charged == 1
    assert result.state == "answered"
    assert result.safe_detail == "ok"


def test_threads_normalizer_exposes_optional_enrichment_fields():
    item = normalize_threads_item(
        {
            "pk": "th-enrich", "code": "CE", "caption": {"text": "barayam"},
            "user": {"username": "rina", "full_name": "Rina"},
            "taken_at": RECENT, "like_count": 42,
            "text_post_app_info": {"direct_reply_count": 7, "repost_count": 3},
            "video_versions": [{"url": "https://img/video.jpg"}],
        },
        collected_at="2026-11-15T00:00:00Z",
    )
    assert item["author_handle"] == "rina"
    assert item["author_name"] == "Rina"
    assert item["thumbnail_url"] == "https://img/video.jpg"
    assert (item["likes"], item["replies"], item["shares"]) == (42, 7, 3)
    assert item["title"] is None
    assert item["views"] is None


def test_tiktok_normalizer_exposes_stats_and_cover():
    item = normalize_tiktok_item(
        {
            "aweme_id": "tt-enrich", "desc": "barayam", "create_time": RECENT,
            "author": {"unique_id": "foodies", "nickname": "Foodies ID"},
            "stats": {"diggCount": 9, "commentCount": 4, "shareCount": 2, "playCount": 100},
            "video": {"cover": "https://img/cover.jpg"},
        },
        collected_at="2026-11-15T00:00:00Z",
    )
    assert item["author_handle"] == "foodies"
    assert item["author_name"] == "Foodies ID"
    assert item["thumbnail_url"] == "https://img/cover.jpg"
    assert (item["views"], item["likes"], item["replies"], item["shares"]) == (100, 9, 4, 2)
    assert item["title"] is None


def test_instagram_normalizer_exposes_edges_and_media():
    item = normalize_instagram_item(
        {
            "pk": "ig-enrich", "code": "CIE", "taken_at": RECENT,
            "caption": {"text": "barayam"},
            "user": {"username": "rina", "full_name": "Rina"},
            "edge_media_preview_like": {"count": 5},
            "edge_media_to_parent_comment": {"count": 2},
            "display_uri": "https://img/ig.jpg",
        },
        collected_at="2026-11-15T00:00:00Z",
    )
    assert item["author_handle"] == "rina"
    assert item["author_name"] == "Rina"
    assert item["thumbnail_url"] == "https://img/ig.jpg"
    assert (item["likes"], item["replies"]) == (5, 2)
    assert item["shares"] is None


def test_scrapecreators_error_becomes_failed_without_leaking_body():
    calls = []

    def opener(request, timeout=0):
        calls.append(1)
        raise urllib.error.HTTPError(
            request.full_url, 500, "boom", {},
            io.BytesIO(b'{"error":"synthetic-key prompt text"}'),
        )

    result = fetch_scrapecreators_platform(
        "threads", Keyword("barayam"), api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener,
    )
    assert result.state == "failed"
    assert result.safe_detail == "http_500"
    assert result.posts == []
    assert "synthetic-key" not in repr(result)
    assert "prompt text" not in repr(result)


def test_platform_fetch_defaults_match_dispatcher_contract():
    fetch = PlatformFetch("threads", "scrapecreators", [], [], "failed", "http_500", 10)
    assert fetch.platform == "threads"
    assert fetch.provider == "scrapecreators"
    assert fetch.attempted_providers == ()
    assert isinstance(fetch.posts, list)
    assert all(isinstance(item, CanonicalPost) for item in fetch.posts)
