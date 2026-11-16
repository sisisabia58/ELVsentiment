from dataclasses import replace
from datetime import datetime, timedelta, timezone
import threading
import time
import uuid

import pytest

from sentiment_monitor import instant_search
from sentiment_monitor.intent import Keyword
from sentiment_monitor.instant_search import (
    ROUTE_TIMEOUT_SECONDS,
    claim_instant_search,
    expire_old_searches,
    finish_search,
    insert_comments,
    insert_posts,
    record_call,
    run_instant_search,
    run_instant_search_cycle,
    search_status,
    set_source_state,
)
from sentiment_monitor.providers.canonical import CanonicalComment, CanonicalPost, RouteCall
from sentiment_monitor.providers.capabilities import DEFAULT_SETTINGS
from sentiment_monitor.providers.fetch import fetch_platform
from sentiment_monitor.providers.fixtures import fixture_comment_fetch, fixture_platform_fetch

CUSTOMER = "11111111-1111-4111-8111-111111111111"
SEARCH = "22222222-2222-4222-8222-222222222222"


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


def test_cycle_fails_deadline_missed_rows_before_claiming():
    conn = RecordingConn(rows=[])
    processed = run_instant_search_cycle(
        conn, env={}, now=datetime.now(timezone.utc), limits=None
    )
    assert processed == 0
    first_sql = " ".join(conn.statements[0][0].lower().split())
    assert "update instant_searches" in first_sql
    assert "('failed', 'deadline'" in first_sql
    assert "deadline_at" in first_sql
    assert "for update skip locked" not in first_sql


def test_cycle_fails_a_queued_search_past_deadline_and_its_pending_sources(db):
    db.execute(
        "update instant_searches set deadline_at = now() - interval '5 seconds' where id = %s",
        (SEARCH,),
    )
    db.execute(
        "insert into instant_search_sources (search_id, customer_id, platform, provider, state) "
        "values (%s, %s, 'threads', 'scrapecreators', 'queued')",
        (SEARCH, CUSTOMER),
    )
    processed = run_instant_search_cycle(
        db, env={}, now=datetime.now(timezone.utc), limits=None
    )
    assert processed == 0
    search = db.execute(
        "select status, error_code, finished_at from instant_searches where id = %s", (SEARCH,)
    )[0]
    assert search["status"] == "failed"
    assert search["error_code"] == "deadline"
    assert search["finished_at"] is not None
    source = db.execute(
        "select state, safe_detail from instant_search_sources "
        "where search_id = %s and platform = 'threads'",
        (SEARCH,),
    )[0]
    assert source["state"] == "unavailable"
    assert source["safe_detail"] == "deadline"


def test_cycle_does_not_race_a_running_search_within_the_grace_window(db):
    db.execute(
        "update instant_searches set status = 'running', started_at = now(), "
        "deadline_at = now() - interval '10 seconds' where id = %s",
        (SEARCH,),
    )
    processed = run_instant_search_cycle(
        db, env={}, now=datetime.now(timezone.utc), limits=None
    )
    assert processed == 0
    search = db.execute(
        "select status, error_code from instant_searches where id = %s", (SEARCH,)
    )[0]
    assert search["status"] == "running"
    assert search["error_code"] is None


def test_cycle_fails_a_running_search_well_past_the_grace_window(db):
    db.execute(
        "update instant_searches set status = 'running', started_at = now(), "
        "deadline_at = now() - interval '90 seconds' where id = %s",
        (SEARCH,),
    )
    run_instant_search_cycle(db, env={}, now=datetime.now(timezone.utc), limits=None)
    search = db.execute(
        "select status, error_code from instant_searches where id = %s", (SEARCH,)
    )[0]
    assert search["status"] == "failed"
    assert search["error_code"] == "deadline"


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


def all_platform_settings():
    return dict(DEFAULT_SETTINGS)


def test_runner_marks_slow_source_unavailable_at_deadline(db):
    def slow(*args, **kwargs):
        time.sleep(0.2)
        return __import__(
            "sentiment_monitor.providers.scrapecreators_adapter", fromlist=["PlatformFetch"]
        ).PlatformFetch("reddit", "scrapeatlas", [post("reddit")], [], "answered", "ok", 200)

    job = claim_instant_search(db, "worker-1")
    started = time.monotonic()
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(), fetcher=slow, deadline_seconds=0.05,
    )
    assert time.monotonic() - started < 1.0
    source = db.execute(
        "select state, safe_detail from instant_search_sources where search_id=%s and platform='reddit'",
        (job.id,),
    )[0]
    assert source["state"] == "unavailable"
    assert source["safe_detail"] == "deadline"
    search = db.execute("select status, finished_at from instant_searches where id=%s", (job.id,))[0]
    assert search["status"] in ("partial", "failed")
    assert search["finished_at"] is not None
    assert db.execute("select count(*) as n from instant_search_results where search_id=%s", (job.id,))[0]["n"] == 0


def test_deadline_path_joins_started_route_threads_with_a_bound(db, monkeypatch):
    from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch

    monkeypatch.setattr(instant_search, "MIN_LAUNCH_SECONDS", 0.0)
    started = threading.Event()
    release = threading.Event()

    def blocked(*args, **kwargs):
        started.set()
        release.wait(5)
        return PlatformFetch("reddit", "scrapeatlas", [], [], "answered", "ok", 200)

    timer = threading.Timer(0.4, release.set)
    timer.start()
    before = {thread.ident for thread in threading.enumerate()}
    try:
        job = claim_instant_search(db, "worker-1")
        began = time.monotonic()
        run_instant_search(
            db,
            job,
            env={},
            now=datetime.now(timezone.utc),
            settings={"reddit": DEFAULT_SETTINGS["reddit"]},
            fetcher=blocked,
            deadline_seconds=0.05,
        )
        elapsed = time.monotonic() - began
        assert started.is_set()
        assert elapsed < 1.5
        leftovers = [
            thread
            for thread in threading.enumerate()
            if thread.ident not in before and thread.name.startswith("ThreadPoolExecutor")
        ]
        assert leftovers == []
    finally:
        release.set()
        timer.cancel()
        timer.join()


def test_runner_keeps_answered_sources_when_another_fails(db):
    from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch

    def mixed(platform, *args, **kwargs):
        if platform == "youtube":
            return PlatformFetch("youtube", "scrapeatlas", [post()], [], "answered", "ok", 10)
        return PlatformFetch(platform, "scrapeatlas", [], [], "failed", "http_500", 10)

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(), fetcher=mixed,
    )
    assert db.execute(
        "select count(*) as n from instant_search_results where search_id=%s", (job.id,)
    )[0]["n"] == 1
    assert db.execute("select status from instant_searches where id=%s", (job.id,))[0]["status"] == "partial"
    assert db.execute(
        "select count(*) as n from instant_search_sources where search_id=%s and state='answered'", (job.id,)
    )[0]["n"] == 1
    assert db.execute(
        "select count(*) as n from instant_search_sources where search_id=%s and state='failed'", (job.id,)
    )[0]["n"] == 6


def test_runner_all_failed_is_failed_and_inserts_no_results(db):
    from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch

    def failed(platform, *args, **kwargs):
        return PlatformFetch(platform, "scrapeatlas", [], [], "failed", "http_500", 10)

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(), fetcher=failed,
    )
    assert db.execute("select status from instant_searches where id=%s", (job.id,))[0]["status"] == "failed"
    assert db.execute("select count(*) as n from instant_search_results where search_id=%s", (job.id,))[0]["n"] == 0


def test_runner_fixture_mode_end_to_end_ranks_and_records_zero_credits(db, monkeypatch):
    monkeypatch.setenv("CARI_PROVIDER_MODE", "fixture")
    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc), settings=all_platform_settings(),
    )
    search = db.execute("select status, credits_used from instant_searches where id=%s", (job.id,))[0]
    assert search["status"] == "succeeded"
    assert search["credits_used"] == 0
    sources = db.execute(
        "select state, result_count, credits_charged, safe_detail from instant_search_sources where search_id=%s",
        (job.id,),
    )
    assert len(sources) == 7
    assert all(row["state"] == "answered" for row in sources)
    assert all(row["result_count"] > 0 for row in sources)
    assert all(row["credits_charged"] == 0 for row in sources)
    ranks = db.execute(
        "select rank from instant_search_results where search_id=%s order by rank", (job.id,)
    )
    assert [row["rank"] for row in ranks] == list(range(1, len(ranks) + 1))
    ledger = db.execute("select count(*) as n from search_credit_ledger where search_id=%s", (job.id,))[0]["n"]
    assert ledger == 7


def test_runner_applies_date_window_and_keeps_undated_last(db):
    from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch

    now = datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc)

    def dated(platform, *args, **kwargs):
        if platform == "youtube":
            return PlatformFetch(
                "youtube",
                "scrapeatlas",
                [
                    replace(post("youtube", "old"), published_at="2026-10-01T00:00:00Z"),
                    replace(post("youtube", "new"), published_at="2026-11-15T00:00:00Z"),
                    replace(post("youtube", "undated"), published_at=None),
                ],
                [],
                "answered",
                "ok",
                10,
            )
        return PlatformFetch(platform, "scrapeatlas", [], [], "answered", "ok", 10)

    job = replace(claim_instant_search(db, "worker-1"), date_window="7d")
    run_instant_search(
        db, job, env={}, now=now, settings=all_platform_settings(), fetcher=dated,
    )
    rows = db.execute(
        "select external_id, rank from instant_search_results where search_id=%s order by rank", (job.id,)
    )
    assert [row["external_id"] for row in rows] == ["new", "undated"]
    assert [row["rank"] for row in rows] == [1, 2]


def test_runner_passes_the_route_timeout_to_each_fetch(db):
    from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch

    seen = []

    def capture(platform, *args, **kwargs):
        seen.append(kwargs.get("timeout"))
        return PlatformFetch(platform, "scrapeatlas", [], [], "answered", "ok", 10)

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(), fetcher=capture,
    )
    assert seen and all(value == ROUTE_TIMEOUT_SECONDS for value in seen)
