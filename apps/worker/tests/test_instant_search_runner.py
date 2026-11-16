from dataclasses import replace
from datetime import datetime, timedelta, timezone
import uuid

import pytest

from sentiment_monitor.intent import Keyword
from sentiment_monitor.instant_search import (
    claim_instant_search,
    expire_old_searches,
    finish_search,
    insert_comments,
    insert_posts,
    record_call,
    search_status,
    set_source_state,
)
from sentiment_monitor.providers.canonical import CanonicalComment, CanonicalPost, RouteCall
from sentiment_monitor.providers.capabilities import DEFAULT_SETTINGS
from sentiment_monitor.providers.fetch import fetch_platform
from sentiment_monitor.providers.fixtures import fixture_comment_fetch, fixture_platform_fetch

CUSTOMER = "11111111-1111-4111-8111-111111111111"


def post(platform: str = "youtube", external_id: str = "vid-1") -> CanonicalPost:
    return CanonicalPost(
        platform=platform,
        external_id=external_id,
        text="barayam enak",
        title=None,
        author_name="ani",
        author_handle="@ani",
        url=f"https://example.invalid/{external_id}",
        published_at="2026-11-14T00:00:00Z",
        thumbnail_url=None,
        views=10,
        likes=2,
        replies=1,
        shares=0,
        top_replies=(),
        hashtags=(),
        source_provider="fixture",
        routes=("fixture.youtube.search",),
        raw_ref=f"fixture:{external_id}",
        collected_at="2026-11-15T00:00:00Z",
        language="id",
        relevance="literal_match",
        web_index=False,
    )


def test_search_status_counts_answered_and_failed_sources():
    assert search_status(["answered", "answered"]) == "succeeded"
    assert search_status(["answered", "failed"]) == "partial"
    assert search_status(["answered", "unavailable"]) == "partial"
    assert search_status(["failed", "unavailable"]) == "failed"
    assert search_status([]) == "failed"
    assert search_status(["queued", "answered"]) == "partial"


class RecordingConn:
    def __init__(self, rows=None):
        self.statements: list[tuple[str, object]] = []
        self.rows = rows

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        return self.rows


def test_claim_sql_is_skip_locked_and_rejects_expired_rows():
    conn = RecordingConn(rows=[])
    assert claim_instant_search(conn, "worker-1") is None
    sql = " ".join(conn.statements[0][0].lower().split())
    assert "from instant_searches" in sql
    assert "status = 'queued'" in sql
    assert "deadline_at > now()" in sql
    assert "for update skip locked" in sql


def test_claim_skips_nonqueued_and_marks_running(db):
    job = claim_instant_search(db, "worker-1")
    assert job is not None
    row = db.execute("select status, started_at from instant_searches where id=%s", (job.id,))[0]
    assert row["status"] == "running"
    assert row["started_at"] is not None
    assert claim_instant_search(db, "worker-2") is None


def test_set_source_state_upserts_a_missing_row_and_updates_it(db):
    job = claim_instant_search(db, "worker-1")
    set_source_state(db, job, "youtube", "answered", provider="scrapeatlas", result_count=2)
    set_source_state(db, job, "youtube", "failed", provider="scrapeatlas", safe_detail="http_5xx")
    row = db.execute(
        "select state, result_count, safe_detail from instant_search_sources "
        "where search_id=%s and platform='youtube'",
        (job.id,),
    )[0]
    assert row == {"state": "failed", "result_count": 0, "safe_detail": "http_5xx"}


def test_finish_search_sets_partial_when_some_sources_answered(db):
    job = claim_instant_search(db, "worker-1")
    set_source_state(db, job, "youtube", "answered", result_count=2, credits_charged=1, latency_ms=900)
    set_source_state(db, job, "reddit", "unavailable", safe_detail="missing_key")
    finish_search(db, job, "partial")
    row = db.execute("select status from instant_searches where id=%s", (job.id,))[0]
    assert row["status"] == "partial"


def test_finish_search_computes_status_and_ledger_total(db):
    job = claim_instant_search(db, "worker-1")
    set_source_state(db, job, "youtube", "answered", result_count=1)
    set_source_state(db, job, "reddit", "answered", result_count=0)
    record_call(
        db,
        job,
        RouteCall("scrapeatlas", "youtube", "scrapeatlas.youtube.search", "success", 200, 2, 10, 5, "ok"),
    )
    record_call(
        db,
        job,
        RouteCall("scrapeatlas", "reddit", "scrapeatlas.reddit.search", "success", 200, 3, 10, 5, "ok"),
    )
    assert finish_search(db, job, "failed", error_code="summary_failed") == "succeeded"
    row = db.execute(
        "select status, credits_used, error_code, finished_at from instant_searches where id=%s",
        (job.id,),
    )[0]
    assert row["status"] == "succeeded"
    assert row["credits_used"] == 5
    assert row["error_code"] == "summary_failed"
    assert row["finished_at"] is not None


def test_insert_posts_and_comments_drop_collisions_and_keep_canonical_fields(db):
    job = claim_instant_search(db, "worker-1")
    assert insert_posts(db, job, [post(), post()]) == 1
    row = db.execute(
        "select platform, external_id, url, relevance, language, raw_ref, routes "
        "from instant_search_results where search_id=%s",
        (job.id,),
    )[0]
    assert row["platform"] == "youtube"
    assert row["external_id"] == "vid-1"
    assert row["url"] == "https://example.invalid/vid-1"
    assert row["relevance"] == "literal_match"
    assert row["language"] == "id"
    assert row["raw_ref"] == "fixture:vid-1"
    assert row["routes"] == ["fixture.youtube.search"]

    no_identity = replace(post(), external_id="", url=None)
    assert insert_posts(db, job, [no_identity]) == 0

    result_id = db.execute("select id from instant_search_results where search_id=%s", (job.id,))[0]["id"]
    comment = CanonicalComment(
        external_id="c-1",
        text="enak",
        author_name="budi",
        author_handle="@budi",
        published_at=None,
        likes=3,
        replies=None,
        source_provider="fixture",
        raw_ref="fixture:c-1",
    )
    assert insert_comments(db, job, result_id, [comment, comment]) == 1


def test_expire_old_searches_deletes_expired_and_cascades(db):
    job = claim_instant_search(db, "worker-1")
    set_source_state(db, job, "youtube", "answered", result_count=1)
    expired = str(uuid.uuid4())
    db.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, deadline_at, retention_expires_at)
        values (%s, %s, 'lama', 'phrase', 'all', 'relevance', 'all', 'succeeded',
                now() - interval '2 days', now() - interval '1 day')
        """,
        (expired, CUSTOMER),
    )
    set_source_state_for_id = (
        "insert into instant_search_sources (search_id, customer_id, platform, provider, state) "
        "values (%s, %s, 'youtube', 'fixture', 'answered')"
    )
    db.execute(set_source_state_for_id, (expired, CUSTOMER))
    expire_old_searches(db, datetime.now(timezone.utc) + timedelta(seconds=1))
    left = db.execute("select count(*) as n from instant_searches")[0]["n"]
    left_sources = db.execute("select count(*) as n from instant_search_sources where search_id=%s", (expired,))[0]["n"]
    assert left == 1
    assert left_sources == 0


def test_fixture_mode_returns_deterministic_posts_without_network(monkeypatch):
    monkeypatch.setenv("CARI_PROVIDER_MODE", "fixture")
    result = fetch_platform(
        "youtube", Keyword("barayam"), {}, env={},
        collected_at="2026-11-15T00:00:00Z", date_window_days=7,
    )
    assert result.provider == "fixture"
    assert result.state == "answered"
    assert result.posts[0].platform == "youtube"
    assert result.posts[0].external_id.startswith("fixture-youtube-")
    assert result.calls[0].credits_charged == 0
    repeated = fetch_platform(
        "youtube", Keyword("barayam"), {}, env={},
        collected_at="2026-11-15T00:00:00Z", date_window_days=7,
    )
    assert [item.external_id for item in repeated.posts] == [item.external_id for item in result.posts]


def test_fixture_mode_is_explicit_and_never_implicit(monkeypatch):
    monkeypatch.delenv("CARI_PROVIDER_MODE", raising=False)
    result = fetch_platform(
        "youtube", Keyword("barayam"), DEFAULT_SETTINGS, env={},
        collected_at="2026-11-15T00:00:00Z", date_window_days=7,
    )
    assert result.provider != "fixture"
    assert result.state == "unavailable"
    assert result.safe_detail == "missing_key"


def test_fixture_posts_cover_platforms_and_undated_youtube(monkeypatch):
    monkeypatch.setenv("CARI_PROVIDER_MODE", "fixture")
    for platform in ("threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin"):
        result = fixture_platform_fetch(
            platform, Keyword("barayam"), collected_at="2026-11-15T00:00:00Z", date_window_days=7
        )
        assert result.platform == platform
        assert 2 <= len(result.posts) <= 3
        assert all(item.external_id.startswith(f"fixture-{platform}-") for item in result.posts)
        assert all(item.routes for item in result.posts)
        assert result.calls and all(call.credits_charged == 0 for call in result.calls)
    youtube = fixture_platform_fetch(
        "youtube", Keyword("barayam"), collected_at="2026-11-15T00:00:00Z", date_window_days=7
    )
    assert any(item.published_at is None for item in youtube.posts)
    assert any(item.thumbnail_url for item in youtube.posts)
    assert any(item.likes for item in youtube.posts)


def test_fixture_comments_return_two_synthetic_comments(monkeypatch):
    monkeypatch.setenv("CARI_PROVIDER_MODE", "fixture")
    fetched = fixture_platform_fetch(
        "youtube", Keyword("barayam"), collected_at="2026-11-15T00:00:00Z", date_window_days=7
    )
    result = fixture_comment_fetch("youtube", fetched.posts[0])
    assert result.state == "answered"
    assert len(result.comments) == 2
    assert result.call is not None
    assert result.call.credits_charged == 0
