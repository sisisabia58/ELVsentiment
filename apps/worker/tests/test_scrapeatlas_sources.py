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
    assert "region" not in seen[0]
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


from sentiment_monitor.providers.canonical import sort_posts
from sentiment_monitor.providers.scrapeatlas_sources import (
    fetch_scrapeatlas_facebook,
    fetch_scrapeatlas_linkedin,
    fetch_scrapeatlas_reddit,
    fetch_scrapeatlas_youtube,
)


def test_youtube_keeps_undated_shorts_and_flags_them():
    def opener(request, timeout=0):
        return Response(
            {"success": True, "status": "success", "videos": [
                {"id": "v1", "title": "Review barayam", "channel": {"title": "Jajan"},
                 "publishedTime": "2026-11-14T00:00:00Z", "url": "https://youtube/v1",
                 "viewCountInt": 1000, "thumbnail": "https://img/v1.jpg"},
            ], "shorts": [
                {"id": "s1", "title": "barayam #shorts", "channel": {"title": "Jajan"},
                 "url": "https://youtube/s1", "viewCountInt": 50},
            ], "coverage": {"warnings": []}},
            headers={"x-credits-charged": "1"},
        )

    result = fetch_scrapeatlas_youtube("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener, date_window_days=7)
    assert [post.external_id for post in result.posts] == ["v1", "s1"]
    assert result.posts[1].published_at is None
    assert result.posts[1].views == 50
    assert result.posts[0].routes == ("scrapeatlas.youtube.search",)


def test_linkedin_is_flagged_as_web_index_and_costs_two_credits():
    def opener(request, timeout=0):
        return Response(
            {"success": True, "status": "partial",
             "coverage": {"warnings": ["web_index_selection"]},
             "posts": [{"id": "l1", "description": "barayam", "author": {"name": "Budi"},
                        "datePublished": "2026-11-03T00:00:00Z", "url": "https://linkedin/l1"}]},
            headers={"x-credits-charged": "2"},
        )

    result = fetch_scrapeatlas_linkedin("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.posts[0].web_index is True
    assert result.calls[0].credits_charged == 2
    assert result.posts[0].relevance == "literal_match"


def test_youtube_fixture_keeps_undated_shorts_under_date_filter_and_sorts_last():
    payload = fixture("youtube.json")

    def opener(request, timeout=0):
        return Response(payload, headers={"x-credits-charged": "1"})

    result = fetch_scrapeatlas_youtube("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener, date_window_days=7)
    assert result.state == "answered"
    assert result.posts, "undated shorts must not be dropped"
    assert all(post.published_at is None for post in result.posts)
    ordered = sort_posts(result.posts, "newest")
    assert [post.external_id for post in ordered] == [post.external_id for post in result.posts]


def test_reddit_and_facebook_fixtures_map_fields():
    def reddit_opener(request, timeout=0):
        assert "sort=relevance" in request.full_url
        return Response(fixture("reddit.json"), headers={"x-credits-charged": "1"})

    reddit = fetch_scrapeatlas_reddit("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=reddit_opener)
    assert reddit.state == "answered"
    assert reddit.posts[0].source_provider == "scrapeatlas"
    assert reddit.posts[0].external_id
    assert reddit.posts[0].url and reddit.posts[0].url.startswith("https://")
    assert reddit.posts[0].likes is not None
    assert reddit.posts[0].replies is not None

    def facebook_opener(request, timeout=0):
        assert "hashtag=barayam" in request.full_url
        return Response(fixture("facebook_hashtag.json"), headers={"x-credits-charged": "1"})

    facebook = fetch_scrapeatlas_facebook("#barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=facebook_opener)
    assert facebook.state == "answered"
    assert facebook.posts[0].likes is not None
    assert facebook.posts[0].replies is not None
    assert facebook.posts[0].thumbnail_url.startswith("https://example.invalid/")


def test_facebook_phrase_is_unavailable_without_request():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response({"success": True, "status": "success", "posts": [],
                         "coverage": {"warnings": []}}, headers={"x-credits-charged": "1"})

    result = fetch_scrapeatlas_facebook("Ayam Barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.state == "unavailable"
    assert result.safe_detail == "hashtag_only"
    assert not seen


def test_linkedin_all_time_omits_date_filter_and_marks_web_index():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(fixture("linkedin.json"), headers={"x-credits-charged": "2"})

    result = fetch_scrapeatlas_linkedin("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert "date_posted" not in seen[0]
    assert all(post.web_index for post in result.posts)
    assert result.calls[0].outcome == "partial"


def test_youtube_and_reddit_404_are_answered_free():
    def not_found(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url, 404, "not found", {},
            io.BytesIO(b'{"success":false,"status":"failed","failure":{"code":"not_found"}}'),
        )

    youtube = fetch_scrapeatlas_youtube("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=not_found)
    reddit = fetch_scrapeatlas_reddit("barayam", api_key="synthetic",
        collected_at="2026-11-15T00:00:00Z", opener=not_found)
    for result in (youtube, reddit):
        assert result.state == "answered"
        assert result.posts == []
        assert result.calls[0].credits_charged == 0

@pytest.mark.parametrize(("platform", "path", "expected"), [
    ("instagram", "instagram", ("3000000000000000002", "Example caption", 48200, 2100, 40)),
    ("x", "twitter", ("1000000000000000001", "Example text", 321, 2, 0)),
])
def test_indexed_search_contract(platform, path, expected):
    from urllib.parse import parse_qs, urlsplit
    from sentiment_monitor.providers import scrapeatlas_sources as sources

    payload = fixture(f"{platform}_posts.json")
    payload["posts"] = [None, {}, {"owner": []}, *payload["posts"]]
    seen = []

    def opener(request, timeout=0):
        url = urlsplit(request.full_url)
        assert url.netloc == "api.scrapeatlas.com"
        assert url.path == f"/v1/{path}/search/posts"
        seen.append(parse_qs(url.query))
        return Response(payload, headers={"x-credits-charged": "2"})

    fetch = getattr(sources, f"fetch_scrapeatlas_{platform}", None)
    assert callable(fetch)
    kwargs = dict(api_key="fixture", collected_at="2026-11-15T00:00:00Z", opener=opener)
    page = fetch("example", **kwargs)
    post, = page.posts
    assert (post.external_id, post.text, post.views, post.likes, post.replies) == expected
    assert post.web_index and post.published_at and post.author_handle == "example"
    assert post.url.startswith("https://")
    assert page.calls[0].credits_charged == 2 and page.calls[0].outcome == "partial"
    if platform == "instagram":
        assert post.thumbnail_url and post.published_at.startswith("2026-09-")
    else:
        assert post.shares == 0 and post.published_at == "2026-02-03T04:05:06Z"
    assert page.next_cursor == payload["cursor"]
    payload.update(posts=[], cursor=None)
    empty = fetch("example", cursor=page.next_cursor, **kwargs)
    assert empty.state == "answered" and empty.posts == [] and empty.next_cursor is None
    assert seen[0]["query"] == ["example"] and "cursor" not in seen[0]
    assert seen[1]["cursor"] == [page.next_cursor]


@pytest.mark.parametrize(("platform", "sample", "charge"), [
    ("instagram", "instagram_posts.json", 2), ("tiktok", "tiktok_keyword.json", 1),
    ("threads", "threads_recent.json", 1),
])
def test_scheduled_sources_use_one_fresh_atlas_page_with_actual_credits(platform, sample, charge):
    from sentiment_monitor import scheduler
    urls = []
    def opener(request, timeout=0):
        urls.append(request.full_url)
        return Response(fixture(sample), headers={"x-credits-charged": str(charge)})

    fetch = getattr(scheduler, "scheduled_fetch", None)
    assert callable(fetch)
    result = fetch(platform, "example", api_key="fixture", collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert len(urls) == 1 and urls[0].startswith("https://api.scrapeatlas.com/")
    assert "cursor=" not in urls[0] and result.get("next_cursor") is None
    assert result["route_events"][0]["credits_charged"] == charge
    assert result["credits_charged"] == charge


def test_linkedin_uses_a_stable_identity_from_documented_permalink():
    url = "https://www.linkedin.com/posts/member_topic-activity-1234567890-abc"
    result = fetch_scrapeatlas_linkedin("topic", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *a, **k: Response({"success": True, "status": "partial",
            "posts": [{"url": url + "?tracking=sample", "description": "Topic"}]}))
    post, = result.posts
    assert post.external_id == "1234567890"
    assert result.safe_detail == "partial_coverage"


@pytest.mark.parametrize("value", [None, {}, "unparseable"])
def test_missing_or_malformed_post_collection_fails_and_retains_charge(value):
    payload = {"success": True, "status": "success"}
    if value is not None:
        payload["posts"] = value
    result = fetch_scrapeatlas_threads("topic", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *a, **k: Response(payload, headers={"x-credits-charged": "2"}))
    assert result.state == "failed" and result.safe_detail == "malformed_envelope"
    assert result.calls[0].credits_charged == 2


def test_one_malformed_threads_caption_preserves_valid_sibling():
    payload = {"success": True, "status": "success", "posts": [
        {"pk": "bad", "text_post_app_info": {"text_fragments": ["broken"]}},
        {"pk": "ok", "caption": {"text": "example"}}
    ]}
    result = fetch_scrapeatlas_threads("example", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *a, **k: Response(payload))
    assert [post.external_id for post in result.posts] == ["ok"]


@pytest.mark.parametrize("flags", [{"success": "false"}, {"status": []}, {"status": "unexpected"}])
def test_invalid_envelope_flags_fail_with_the_reported_charge(flags):
    payload = {"success": True, "status": "success", "posts": [], **flags}
    result = fetch_scrapeatlas_threads("example", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *a, **k: Response(payload, headers={"x-credits-charged": "2"}))
    assert (result.state, result.safe_detail, result.calls[0].credits_charged) == ("failed", "malformed_envelope", 2)


def test_incomplete_coverage_is_partial_even_with_success_status():
    payload = {"success": True, "status": "success", "posts": [], "coverage": {"complete": False}}
    result = fetch_scrapeatlas_threads("example", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *a, **k: Response(payload))
    assert (result.state, result.safe_detail, result.calls[0].outcome) == ("answered", "partial_coverage", "partial")


def test_threads_drops_mapping_identity_and_keeps_scheduled_hashtags():
    from sentiment_monitor.intent import Keyword
    from sentiment_monitor.scheduler import scheduled_fetch

    payload = {"success": True, "posts": [
        {"pk": {"bogus": "identity"}},
        {"pk": "\u0000"},
        {"pk": "🌶" * 800},
        {"pk": "ok", "hashtags": [{"name": "example"}], "caption": "no literal tag in the excerpt"},
    ]}
    result = scheduled_fetch("threads", Keyword("#example", "hashtag"), api_key="fixture",
        collected_at="2026-11-15T00:00:00Z", opener=lambda *a, **k: Response(payload))
    mention, = result["mentions"]
    assert mention["external_id"] == "ok"
    assert mention["hashtags"] == ("example",)


def test_linkedin_urn_and_permalink_share_a_canonical_identity():
    payload = {"success": True, "posts": [
        {"url": "https://www.linkedin.com/posts/member_topic-activity-1234567890-abc"},
        {"urn": "urn:li:activity:1234567890"},
        {"id": "urn:li:activity:1234567890"},
    ]}
    result = fetch_scrapeatlas_linkedin("topic", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *a, **k: Response(payload))
    assert [post.external_id for post in result.posts] == ["1234567890"] * 3


def test_linkedin_bad_optional_url_does_not_hide_valid_identity():
    payload = {"success": True, "posts": [{"id": "opaque-id", "url": "https://[bad", "description": "Topic"}]}
    result = fetch_scrapeatlas_linkedin("topic", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *a, **k: Response(payload))
    assert [post.external_id for post in result.posts] == ["opaque-id"]


@pytest.mark.parametrize("fetch", [fetch_scrapeatlas_threads, fetch_scrapeatlas_tiktok,
                                  fetch_scrapeatlas_youtube, fetch_scrapeatlas_reddit, fetch_scrapeatlas_linkedin])
def test_native_window_uses_documented_bounds_and_excludes_legacy_filters(fetch):
    from urllib.parse import parse_qs, urlsplit
    seen = []
    def opener(request, timeout=0):
        seen.append(parse_qs(urlsplit(request.full_url).query))
        return Response({"success": True, "posts": [], "videos": [], "item_list": []})
    fetch("topic", api_key="fixture", collected_at="2026-11-15T00:00:00Z", date_window_days=7, opener=opener)
    assert seen[0]["since"] == ["2026-11-08T00:00:00Z"]
    assert seen[0]["until"] == ["2026-11-15T00:00:00Z"]
    assert "date_posted" not in seen[0]


def test_not_found_preserves_explicit_charge():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(request.full_url, 404, "missing", {"x-credits-charged": "2"}, io.BytesIO(b"{}"))
    result = fetch_scrapeatlas_threads("fixture", api_key="fixture", collected_at="2026-11-15T00:00:00Z", opener=opener)
    assert result.calls[0].credits_charged == 2


@pytest.mark.parametrize(("fetch_name", "sample", "expected_url"), [
    ("fetch_scrapeatlas_instagram", "instagram_posts.json", "https://www.instagram.com/reel/ExAmPlE0002/"),
    ("fetch_scrapeatlas_x", "x_posts.json", "https://x.com/i/web/status/1000000000000000001"),
    ("fetch_scrapeatlas_youtube", "youtube.json", "https://www.youtube.com/watch?v=TC6pMy8VT0M"),
    ("fetch_scrapeatlas_linkedin", "linkedin.json", "https://www.linkedin.com/feed/update/urn:li:activity:7511673984338436097/"),
])
def test_recovers_post_permalink_from_provider_identity(fetch_name, sample, expected_url):
    from sentiment_monitor.providers import scrapeatlas_sources as sources

    payload = fixture(sample)
    for item in payload.get("posts", []) + payload.get("videos", []) + payload.get("shorts", []):
        item.pop("url", None)
    result = getattr(sources, fetch_name)(
        "example", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *args, **kwargs: Response(payload),
    )
    assert expected_url in [post.url for post in result.posts]


def test_reddit_prefers_native_permalink_to_submitted_link():
    payload = fixture("reddit.json")
    payload["posts"][0]["url"] = "https://example.invalid/a-story"
    result = fetch_scrapeatlas_reddit(
        "example", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *args, **kwargs: Response(payload),
    )
    assert result.posts[0].url == (
        "https://www.reddit.com/r/SocialfFilmmakers/comments/1p3r0uy/"
        "when_kabaddi_becomes_a_battlefield_bison_caste/"
    )


def test_reddit_recovers_native_permalink_from_id_without_using_submitted_url():
    result = fetch_scrapeatlas_reddit(
        "example", api_key="fixture", collected_at="2026-11-15T00:00:00Z",
        opener=lambda *args, **kwargs: Response({"success": True, "status": "success", "posts": [
            {"id": "t3_abc123", "url": "https://www.reddit.com/comments/other/", "title": "example"},
            {"id": "invalid/id", "url": "https://www.reddit.com/comments/other/", "title": "example"},
        ]}),
    )
    assert [post.url for post in result.posts] == ["https://www.reddit.com/comments/abc123/", None]
