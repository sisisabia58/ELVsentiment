"""ScrapeAtlas pagination with synthetic pages shaped like the API contract."""

import io
import json
from urllib.parse import parse_qs, urlsplit

import pytest

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.capabilities import DEFAULT_SETTINGS
from sentiment_monitor.providers.fetch import fetch_platform


class Page(io.StringIO):
    status = 200
    headers = {"x-credits-charged": "1"}

    def __init__(self, **payload):
        super().__init__(json.dumps({"success": True, "status": "success", **payload}))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


@pytest.mark.parametrize(
    "platform,route,field,cursor,records,record,coverage",
    [
        ("tiktok", "tiktok.keyword", "cursor", 12, "item_list",
         lambda id: {"aweme_id": id, "desc": "mandalika", "author": {"unique_id": "brand"}}, {}),
        ("instagram", "instagram.posts", "cursor", "atlas:2", "posts",
         lambda id: {"id": id, "shortcode": "ABC"}, {"warnings": ["web_index_selection"]}),
        ("x", "twitter.posts", "cursor", "serper:2", "posts",
         lambda id: {"rest_id": id, "legacy": {"full_text": "mandalika"}}, {"warnings": ["web_index_selection"]}),
        ("youtube", "youtube.search", "continuationToken", "native+=/long-video-token", "videos",
         lambda id: {"id": id, "title": "mandalika"}, {}),
        ("reddit", "reddit.search", "after", "t3_123", "posts",
         lambda id: {"id": id, "title": "mandalika"}, {}),
        ("facebook", "facebook.hashtag", "cursor", "opaque+=/token", "posts",
         lambda id: {"id": id, "text": "#mandalika"}, {}),
        ("linkedin", "linkedin.posts", "cursor", "2", "posts",
         lambda id: {"id": id, "text": "mandalika"}, {"warnings": ["web_index_selection"]}),
    ],
)
def test_same_route_requests_one_documented_page(
    platform, route, field, cursor, records, record, coverage,
):
    keyword = Keyword("#mandalika", "hashtag") if platform == "facebook" else Keyword("mandalika")
    requests = []
    extra = {"has_more": 1, "search_id": "first-search"} if platform == "tiktok" else {}
    id_before, id_after = (("abcdefghi01", "abcdefghi02") if platform == "youtube" else ("123", "456"))

    def opener(request, timeout):
        requests.append(urlsplit(request.full_url))
        if len(requests) == 1:
            return Page(coverage=coverage, **{records: [record(id_before)], field: cursor, **extra})
        if len(requests) == 2:
            return Page(coverage=coverage, **{records: [record(id_after)], field: None})
        pytest.fail("an additional page made multiple requests")

    def fetch(**continuation):
        return fetch_platform(
            platform, keyword, DEFAULT_SETTINGS, env={"SCRAPEATLAS_API_KEY": "fixture"},
            collected_at="2026-11-15T00:00:00Z", date_window_days=7, opener=opener, **continuation,
        )

    first = fetch()
    assert first.state == "answered"
    assert first.next_cursor == str(cursor)
    assert first.next_companion == extra.get("search_id")
    second = fetch(continuation_route=f"scrapeatlas.{route}", cursor=first.next_cursor,
                   companion=first.next_companion)
    assert second.state == "answered"
    assert second.next_cursor is None
    assert first.posts[0].external_id != second.posts[0].external_id
    assert requests[0].path == requests[1].path
    first_params, page_params = (parse_qs(entry.query) for entry in requests)
    assert page_params.pop(field) == [str(cursor)]
    if platform == "tiktok":
        assert page_params.pop("search_id") == ["first-search"]
    assert page_params == first_params


@pytest.mark.parametrize("platform,payload", [
    ("tiktok", {"cursor": 12, "has_more": 1}),
    ("tiktok", {"cursor": 12, "has_more": 0, "search_id": "unused"}),
    ("tiktok", {"cursor": 0, "has_more": 1, "search_id": "unused"}),
    ("tiktok", {"cursor": 12, "has_more": 1, "search_id": "short"}),
    ("instagram", {"cursor": "x" * 4097}),
    ("instagram", {"cursor": "unknown:2"}),
    ("x", {"cursor": "next\nline"}),
    ("x", {"cursor": "atlas:11"}),
    ("reddit", {"after": "bad+token"}),
    ("linkedin", {"cursor": "opaque-unverified-native"}),
    ("threads", {"cursor": "unspecified"}),
])
def test_unknown_or_invalid_continuation_is_exhausted(platform, payload):
    result = fetch_platform(
        platform, Keyword("mandalika"), DEFAULT_SETTINGS, env={"SCRAPEATLAS_API_KEY": "fixture"},
        collected_at="2026-11-15T00:00:00Z",
        opener=lambda *_a, **_k: Page(posts=[], item_list=[], videos=[], **payload),
    )
    assert result.state == "answered"
    assert result.next_cursor is None


@pytest.mark.parametrize("platform,route,companion", [
    ("threads", "scrapeatlas.threads.recent", None),
    ("instagram", "scrapeatlas.twitter.posts", None),
    ("tiktok", "scrapeatlas.tiktok.keyword", None),
    ("tiktok", "scrapeatlas.tiktok.keyword", "bad-id"),
    ("youtube", "scrapeatlas.youtube.search", None),
    ("facebook", "scrapeatlas.facebook.hashtag", None),
])
def test_unsupported_route_does_not_restart_search(platform, route, companion):
    result = fetch_platform(
        platform, Keyword("mandalika"), DEFAULT_SETTINGS, env={"SCRAPEATLAS_API_KEY": "fixture"},
        collected_at="2026-11-15T00:00:00Z", continuation_route=route, cursor="12", companion=companion,
        opener=lambda *_a, **_k: pytest.fail("unsupported continuation started a paid request"),
    )
    assert result.state == "unavailable"
    assert not result.calls


def test_expired_tiktok_search_session_is_failed_with_one_receipt():
    result = fetch_platform(
        "tiktok", Keyword("mandalika"), DEFAULT_SETTINGS, env={"SCRAPEATLAS_API_KEY": "fixture"},
        collected_at="2026-11-15T00:00:00Z", continuation_route="scrapeatlas.tiktok.keyword",
        cursor="12", companion="first-search",
        opener=lambda *_a, **_k: Page(
            item_list=[{"aweme_id": "123", "desc": "mandalika", "author": {"unique_id": "brand"}}],
            cursor=24, has_more=1, coverage={"warnings": ["search_session_expired"]},
        ),
    )
    assert result.state == "failed" and result.safe_detail == "search_session_expired"
    assert result.posts == [] and result.next_cursor is None
    assert len(result.calls) == 1 and result.calls[0].credits_charged == 1
