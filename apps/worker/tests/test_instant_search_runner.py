from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import logging
import threading
import time
import uuid

import pytest

from sentiment_monitor import instant_search
from sentiment_monitor.intent import Keyword
from sentiment_monitor.gemini import GeminiError, GeminiResult, ScriptedGemini
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
    run_instant_search_poll,
    run_question_cycle,
    summarize_search,
)
from sentiment_monitor.providers.canonical import CanonicalComment, CanonicalPost, PlatformFetch, RouteCall
from sentiment_monitor.providers.comments import CommentFetch
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
    blank = replace(comment, external_id="c-blank", text="  ", raw_ref="fixture:c-blank")
    invisible = replace(comment, external_id="c-zwsp", text="\u200b\ufffc", raw_ref="fixture:c-zwsp")
    assert insert_comments(db, job, result_id, [blank, invisible]) == 0


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
        "youtube", Keyword("barayam"), DEFAULT_SETTINGS, env={},
        collected_at="2026-11-15T00:00:00Z", date_window_days=7,
    )
    assert result.provider == "fixture"
    assert result.state == "answered"
    assert result.posts[0].platform == "youtube"
    assert result.posts[0].external_id.startswith("fixture-youtube-")
    assert result.calls[0].credits_charged == 0
    repeated = fetch_platform(
        "youtube", Keyword("barayam"), DEFAULT_SETTINGS, env={},
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
            "sentiment_monitor.providers.canonical", fromlist=["PlatformFetch"]
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
    from sentiment_monitor.providers.canonical import PlatformFetch

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
    from sentiment_monitor.providers.canonical import PlatformFetch

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
    )[0]["n"] == 7


def test_runner_all_failed_is_failed_and_inserts_no_results(db):
    from sentiment_monitor.providers.canonical import PlatformFetch

    def failed(platform, *args, **kwargs):
        return PlatformFetch(platform, "scrapeatlas", [], [], "failed", "http_500", 10)

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(), fetcher=failed,
    )
    assert db.execute("select status from instant_searches where id=%s", (job.id,))[0]["status"] == "failed"
    assert db.execute("select count(*) as n from instant_search_results where search_id=%s", (job.id,))[0]["n"] == 0


@pytest.mark.parametrize(
    ("mode", "expected"),
    [("relevance", ["exact", "anchor"]), ("newest", ["anchor", "exact"]), ("popular", ["anchor", "exact"])],
)
def test_runner_rejects_weak_posts_before_the_cap_rank_and_comment_budget(db, monkeypatch, mode, expected):
    monkeypatch.setattr(instant_search, "MAX_PLATFORM_RESULTS", 2)
    job = replace(claim_instant_search(db, "worker-1"), query="tukuliling kopi", sort_mode=mode)
    db.execute("update instant_searches set query_text = %s, sort_mode = %s where id = %s", (job.query, mode, job.id))
    posts = [
        replace(post("threads", "exact"), text="Tukuliling kopi di MRT."),
        replace(post("threads", "anchor"), text="Mesin Tukuliling mati.", views=100, published_at="2026-11-15T00:00:00Z"),
        replace(post("threads", "recent_anchor"), text="Tukuliling sudah pindah lokasi.",
                views=20, published_at="2026-11-16T00:00:00Z"),
        replace(post("threads", "weak"), text="Kopi keliling.", views=10_000, published_at="2026-11-16T00:00:00Z"),
        replace(post("threads", "old"), text="Tukuliling kopi dulu.", views=9000, published_at="2026-10-01T00:00:00Z"),
    ]
    seen = []

    def comment_fetch(platform, item, **kwargs):
        seen.append(item.external_id)
        return CommentFetch(item.external_id, [canonical_comment(item.external_id)], None, "answered", "ok")

    run_instant_search(
        db, job, env={"CARI_AI_PROVIDER": "off"}, now=datetime(2026, 11, 16, tzinfo=timezone.utc),
        settings={"threads": DEFAULT_SETTINGS["threads"], "comments": DEFAULT_SETTINGS["comments"]},
        fetcher=lambda *args, **kwargs: PlatformFetch("threads", posts=posts, state="answered"),
        comment_fetcher=comment_fetch,
    )

    assert [row["external_id"] for row in db.execute(
        "select external_id from instant_search_results where search_id = %s order by rank", (job.id,),
    )] == expected
    assert db.execute("select result_count from instant_search_sources where search_id = %s", (job.id,)) == [
        {"result_count": 2},
    ]
    assert seen == ["exact", "anchor"]


def test_runner_finishes_zero_matches_without_comment_or_model_calls(db):
    job = replace(claim_instant_search(db, "worker-1"), query="tukuliling kopi")
    db.execute("update instant_searches set query_text = %s where id = %s", (job.query, job.id))
    spent = []

    def comment_fetch(*args, **kwargs):
        spent.append("comment")
        raise AssertionError("weak posts must not be sent to comment fetch")

    class Model:
        def generate_json(self, **kwargs):
            spent.append("model")
            raise AssertionError("no eligible evidence must skip AI")

    run_instant_search(
        db, job, env={"CARI_AI_PROVIDER": "gemini"}, now=datetime(2026, 11, 16, tzinfo=timezone.utc),
        settings={"threads": DEFAULT_SETTINGS["threads"], "comments": DEFAULT_SETTINGS["comments"]},
        fetcher=lambda *args, **kwargs: PlatformFetch(
            "threads", posts=[replace(post("threads"), text="Kopi keliling dekat kantor")],
            calls=[RouteCall("scrapeatlas", "threads", "search", "success", credits_charged=1)], state="answered",
        ),
        comment_fetcher=comment_fetch, llm=Model(),
    )

    assert db.execute(
        "select status, summary_status, comment_status, comment_detail, credits_used from instant_searches where id = %s",
        (job.id,),
    )[0] == {
        "status": "succeeded", "summary_status": "skipped", "comment_status": "skipped",
        "comment_detail": "no_posts", "credits_used": 1,
    }
    assert db.execute("select state, result_count from instant_search_sources where search_id = %s", (job.id,)) == [
        {"state": "answered", "result_count": 0},
    ]
    assert db.execute("select route from search_credit_ledger where search_id = %s", (job.id,)) == [{"route": "search"}]
    assert db.execute("select id from instant_search_results where search_id = %s", (job.id,)) == []
    assert spent == []


def test_runner_fixture_mode_end_to_end_ranks_and_records_zero_credits(db, monkeypatch):
    monkeypatch.setenv("CARI_PROVIDER_MODE", "fixture")
    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc), settings=all_platform_settings(),
    )
    search = db.execute("select status, credits_used from instant_searches where id=%s", (job.id,))[0]
    assert search["status"] == "partial"
    assert search["credits_used"] == 0
    sources = db.execute(
        "select state, result_count, credits_charged, safe_detail from instant_search_sources where search_id=%s",
        (job.id,),
    )
    assert len(sources) == 8
    assert [row["safe_detail"] for row in sources if row["state"] == "unavailable"] == ["hashtag_only"]
    sources = [row for row in sources if row["state"] == "answered"]
    assert len(sources) == 7
    assert all(row["result_count"] == 3 for row in sources)
    assert all(row["credits_charged"] == 0 for row in sources)
    ranks = db.execute(
        "select rank from instant_search_results where search_id=%s order by rank", (job.id,)
    )
    assert [row["rank"] for row in ranks] == list(range(1, len(ranks) + 1))
    ledger = db.execute("select count(*) as n from search_credit_ledger where search_id=%s", (job.id,))[0]["n"]
    # Seven search routes, plus one comment page for each of the top three posts
    # on the five responding comment-capable platforms. Fixture calls charge nothing, and
    # comment rows are not part of result_count.
    assert ledger == 22
    assert db.execute(
        "select count(*) as n from instant_search_comments where search_id=%s", (job.id,)
    )[0]["n"] == 30


def test_runner_applies_date_window_and_keeps_undated_last(db):
    from sentiment_monitor.providers.canonical import PlatformFetch

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


def canonical_comment(external_id: str) -> CanonicalComment:
    return CanonicalComment(
        external_id=f"c-{external_id}",
        text="kriuk",
        author_name="rina",
        author_handle="@rina",
        published_at=None,
        likes=1,
        replies=0,
        source_provider="scrapeatlas",
        raw_ref=f"fixture:comment:{external_id}",
    )


def fixture_fetcher(platform, keyword, settings, **kwargs):
    del settings
    return fixture_platform_fetch(
        platform,
        keyword,
        collected_at=kwargs["collected_at"],
        date_window_days=kwargs.get("date_window_days"),
    )


def test_runner_fetches_comments_for_at_most_three_posts_per_platform(db):
    calls: list[str] = []

    def comment_fetch(platform, post, **kwargs):
        del kwargs
        calls.append(platform)
        return CommentFetch(
            post_id=post.external_id,
            comments=[canonical_comment(post.external_id)],
            call=RouteCall("scrapeatlas", platform, "comments", "success", 200, 1, 100, 10, "ok"),
            state="answered",
            safe_detail="ok",
        )

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(),
        fetcher=fixture_fetcher,
        comment_fetcher=comment_fetch,
    )
    rows = db.execute(
        "select platform, count(*) as n from instant_search_comments group by platform"
    )
    assert rows
    assert all(row["n"] <= 3 for row in rows)
    assert len(calls) <= 18
    assert len(calls) == 18
    assert "linkedin" not in calls
    posts = db.execute(
        "select count(*) as n from instant_search_results where search_id=%s", (job.id,)
    )[0]["n"]
    assert posts == 24
    ledger = db.execute(
        "select count(*) as n from search_credit_ledger where search_id=%s and route='comments'",
        (job.id,),
    )[0]["n"]
    assert ledger == 18


def test_comments_follow_the_visible_order_and_skip_posts_with_no_replies(db):
    from sentiment_monitor.providers.canonical import PlatformFetch

    calls: list[str] = []
    viral = replace(
        post("threads", "viral"),
        text="minuman lain",
        views=1_000_000,
        replies=50,
    )
    quiet = replace(post("threads", "quiet"), text="barayam sepi", views=1, replies=0)
    shown = replace(post("threads", "shown"), text="barayam enak", views=2, replies=4)
    unknown = replace(post("threads", "unknown"), text="barayam juga", views=0, replies=None)

    def fetcher(platform, *args, **kwargs):
        del args, kwargs
        if platform != "threads":
            return PlatformFetch(platform, "scrapeatlas", [], [], "unavailable", "unavailable", 10)
        return PlatformFetch(
            platform, "scrapeatlas", [viral, quiet, shown, unknown], [], "answered", "ok", 10
        )

    def comment_fetch(platform, item, **kwargs):
        del platform, kwargs
        calls.append(item.external_id)
        return CommentFetch(
            post_id=item.external_id,
            comments=[canonical_comment(item.external_id)],
            call=RouteCall("scrapeatlas", "threads", "comments", "success", 200, 1, 40, 5, "ok"),
            state="answered",
            safe_detail="ok",
        )

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db,
        job,
        env={},
        now=datetime.now(timezone.utc),
        settings={
            "threads": DEFAULT_SETTINGS["threads"],
            "comments": DEFAULT_SETTINGS["comments"],
        },
        fetcher=fetcher,
        comment_fetcher=comment_fetch,
    )
    assert calls == ["shown", "unknown"]
    attached = db.execute(
        """
        select r.external_id
        from instant_search_comments c
        join instant_search_results r on r.id = c.result_id
        where c.search_id = %s
        order by r.rank
        """,
        (job.id,),
    )
    assert [row["external_id"] for row in attached] == ["shown", "unknown"]
    ranks = db.execute(
        """
        select external_id, rank from instant_search_results
        where search_id = %s order by rank
        """,
        (job.id,),
    )
    assert [row["external_id"] for row in ranks] == ["shown", "quiet", "unknown"]


def test_comment_failure_keeps_the_posts_and_the_search_status(db):
    def comment_fetch(platform, post, **kwargs):
        del kwargs
        if platform == "youtube":
            raise RuntimeError("comments down")
        return CommentFetch(
            post_id=post.external_id,
            comments=[],
            call=RouteCall("scrapeatlas", platform, "comments", "failed", 500, 1, 10, 5, "http_500"),
            state="failed",
            safe_detail="http_500",
        )

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(),
        fetcher=fixture_fetcher,
        comment_fetcher=comment_fetch,
    )
    status = db.execute("select status from instant_searches where id=%s", (job.id,))[0]["status"]
    assert status == "succeeded"
    youtube = db.execute(
        "select count(*) as n from instant_search_results where search_id=%s and platform='youtube'",
        (job.id,),
    )[0]["n"]
    assert youtube == 3
    charged = db.execute(
        "select coalesce(sum(credits_charged), 0) as n from search_credit_ledger "
        "where search_id=%s and route='comments'",
        (job.id,),
    )[0]["n"]
    assert charged == 15


def test_slow_source_does_not_block_comments_for_fast_platforms(db, monkeypatch, caplog):
    from sentiment_monitor.providers.canonical import PlatformFetch

    monkeypatch.setattr(instant_search, "MIN_LAUNCH_SECONDS", 0.0)
    caplog.set_level(logging.INFO, logger="sentiment_monitor.instant_search")
    calls: list[str] = []

    def fetcher(platform, *args, **kwargs):
        del args, kwargs
        if platform == "reddit":
            time.sleep(0.35)
        return PlatformFetch(platform, "scrapeatlas", [post(platform, f"{platform}-1")], [], "answered", "ok", 10)

    def comment_fetch(platform, item, **kwargs):
        del item, kwargs
        calls.append(platform)
        return CommentFetch(
            post_id=platform,
            comments=[canonical_comment(platform)],
            call=RouteCall("scrapeatlas", platform, "comments", "success", 200, 1, 20, 5, "ok"),
            state="answered",
            safe_detail="ok",
        )

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings={
            "threads": DEFAULT_SETTINGS["threads"],
            "reddit": DEFAULT_SETTINGS["reddit"],
            "comments": DEFAULT_SETTINGS["comments"],
        },
        fetcher=fetcher,
        comment_fetcher=comment_fetch,
        deadline_seconds=0.12,
    )
    assert calls == ["threads"]
    threads = db.execute(
        "select state, result_count from instant_search_sources where search_id=%s and platform='threads'",
        (job.id,),
    )[0]
    reddit = db.execute(
        "select state, safe_detail, result_count from instant_search_sources where search_id=%s and platform='reddit'",
        (job.id,),
    )[0]
    assert threads["state"] == "answered"
    assert threads["result_count"] == 1
    assert reddit["state"] == "unavailable"
    assert reddit["safe_detail"] == "deadline"
    assert reddit["result_count"] == 0
    assert db.execute(
        "select count(*) as n from instant_search_comments where search_id=%s", (job.id,)
    )[0]["n"] == 1
    search = db.execute(
        "select status, error_code, comment_status from instant_searches where id=%s", (job.id,)
    )[0]
    assert search["status"] == "partial"
    assert search["error_code"] is None
    assert search["comment_status"] == "done"
    text = caplog.text
    assert "platform=threads" in text
    assert "state=answered" in text
    assert "platform=reddit" in text
    assert "detail=deadline" in text
    assert "comments_calls=1" in text
    assert "comment_status=done" in text
    assert "barayam" not in text


def test_comment_calls_do_not_start_after_the_comment_budget(db, monkeypatch):
    monkeypatch.setattr(instant_search, "MIN_LAUNCH_SECONDS", 0.0)
    reads = {"n": 0}
    calls: list[str] = []

    def clock() -> float:
        reads["n"] += 1
        # The first reads capture the source deadline and drain the post routes.
        # Later reads are past the comment budget as well, so no comment call starts.
        return 0.0 if reads["n"] <= 2 else 100.0

    def comment_fetch(platform, post, **kwargs):
        del post, kwargs
        calls.append(platform)
        raise AssertionError("comment call started after the deadline")

    job = claim_instant_search(db, "worker-1")
    run_instant_search(
        db, job, env={}, now=datetime.now(timezone.utc),
        settings=all_platform_settings(),
        fetcher=fixture_fetcher,
        comment_fetcher=comment_fetch,
        clock=clock,
        deadline_seconds=1,
    )
    assert calls == []
    stored = db.execute(
        "select count(*) as n from instant_search_results where search_id=%s", (job.id,)
    )[0]["n"]
    comments = db.execute(
        "select count(*) as n from instant_search_comments where search_id=%s", (job.id,)
    )[0]["n"]
    assert stored >= 1
    assert comments == 0


class FailingGemini:
    def generate_json(self, **kwargs):
        raise GeminiError("http_500")


def test_summary_is_attempted_once_and_a_failed_one_is_not_retried(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post(), replace(post(external_id="vid-2"), text="barayam ramai")])
    finish_search(db, job, "succeeded")
    calls = []

    class Once:
        def generate_json(self, **kwargs):
            calls.append(kwargs.get("search_id"))
            raise GeminiError("http_500")

    now = datetime.now(timezone.utc)
    summarize_search(db, job, llm=Once(), now=now)
    summarize_search(db, job, llm=Once(), now=now)
    assert calls == [job.id]
    assert db.execute(
        "select summary_status from instant_searches where id=%s", (job.id,)
    )[0]["summary_status"] == "failed"


def test_poll_does_not_backfill_an_old_pending_summary(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    finish_search(db, job, "succeeded")
    db.commit()

    def fetcher(*args, **kwargs):
        del args, kwargs
        raise AssertionError("a finished search must not be claimed again")

    def submit(*args, **kwargs):
        del args, kwargs
        raise AssertionError("a finished search must not be submitted")

    started = run_instant_search_poll(
        db,
        env={"CARI_AI_PROVIDER": "gemini", "GEMINI_API_KEY": "synthetic-key"},
        now=datetime.now(timezone.utc),
        limits=None,
        submit=submit,
        in_flight=set(),
        fetcher=fetcher,
    )
    assert started == 0
    assert db.execute(
        "select status, summary_status from instant_searches where id=%s", (job.id,)
    )[0] == {"status": "succeeded", "summary_status": "pending"}


def test_summary_failure_leaves_search_succeeded_but_marks_summary_failed(db):
    job = claim_instant_search(db, "worker-1")
    set_source_state(db, job, "youtube", "answered", result_count=1, credits_charged=1, latency_ms=10)
    insert_posts(db, job, [post(), replace(post(external_id="vid-2"), text="barayam ramai")])
    finish_search(db, job, "succeeded")
    summarize_search(db, job, llm=FailingGemini(), now=datetime.now(timezone.utc))
    search = db.execute("select status, summary_status, error_code from instant_searches where id=%s", (job.id,))[0]
    assert search["status"] == "succeeded"
    assert search["summary_status"] == "failed"
    assert search["error_code"] is None


def test_summary_is_skipped_without_results_or_when_ai_is_off(db):
    job = claim_instant_search(db, "worker-1")
    finish_search(db, job, "succeeded")
    called = []

    class Spy:
        def generate_json(self, **kwargs):
            called.append(1)
            return GeminiResult({"overall_summary": "x"}, "scripted", 0, 0, 0)

    summarize_search(db, job, llm=Spy(), now=datetime.now(timezone.utc))
    assert called == []
    assert db.execute("select summary_status from instant_searches where id=%s", (job.id,))[0]["summary_status"] == "skipped"


def test_summary_is_skipped_when_the_provider_is_off(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    called = []

    class Spy:
        def generate_json(self, **kwargs):
            called.append(1)
            raise AssertionError("off must not call the model")

    summarize_search(
        db, job, llm=Spy(), now=datetime.now(timezone.utc), env={"CARI_AI_PROVIDER": "off"},
    )
    assert called == []
    search = db.execute("select status, summary_status from instant_searches where id=%s", (job.id,))[0]
    assert search["summary_status"] == "skipped"


def test_summary_stores_exact_tukuliling_fixture_evidence(db):
    db.execute("update instant_searches set query_text = 'tukuliling kopi' where id = %s", (SEARCH,))
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [
        replace(post("threads", "convenience"), text="Tukuliling di MRT ASEAN memudahkan beli tanpa antre."),
        replace(post("tiktok", "machine"), text="Kopi Tuku #tukuliling di MRT Lebak Bulus. Mesin sempat kosong."),
        replace(post("youtube", "noise"), text="Kopi keliling independen.", relevance="no_match"),
    ])
    finish_search(db, job, "succeeded")
    refs = {
        row["external_id"]: f"result:{row['id']}"
        for row in db.execute("select id, external_id from instant_search_results where search_id=%s", (job.id,))
    }
    client = ScriptedGemini([
        GeminiResult(
            data={
                "overall_summary": "Tukuliling memudahkan orang membeli kopi di MRT. Ada laporan mesin sempat kosong.",
                "overall_stance": "campuran",
                "overall_supporting_ids": [refs["convenience"], refs["machine"], refs["noise"]],
                "platforms": [{
                    "platform": "threads", "stance": "positif",
                    "summary": "Beli tanpa antre.", "supporting_ids": [refs["convenience"]],
                }],
                "quotes": [
                    {"type": "pujian", "text": "beli tanpa antre", "ref_id": refs["convenience"],
                     "platform": "youtube", "author": "rina"},
                    {"type": "keluhan", "text": "antrean panjang", "ref_id": refs["convenience"]},
                    {"type": "pengamatan", "text": "Kopi keliling independen.", "ref_id": refs["noise"]},
                ],
                "themes": [
                    {"title": "Mesin kosong", "stance": "negatif", "description": "Mesin sempat kosong.",
                     "supporting_ids": [refs["machine"]]},
                    {"title": "Kopi keliling", "stance": "netral", "description": "Iklan yang tidak relevan.",
                     "supporting_ids": [refs["noise"]]},
                ],
            },
            model="scripted",
            input_tokens=3,
            output_tokens=2,
            cost_usd=0,
        )
    ])
    summarize_search(db, job, llm=client, now=datetime.now(timezone.utc))
    search = db.execute("select status, summary_status, overall_stance from instant_searches where id=%s", (job.id,))[0]
    assert search == {"status": "succeeded", "summary_status": "done", "overall_stance": "campuran"}
    stored = db.execute(
        "select overall_summary, quotes, themes, cost_usd, evidence_ids, overall_supporting_ids"
        " from instant_search_ai where search_id=%s", (job.id,),
    )[0]
    assert stored["overall_summary"] == "Tukuliling memudahkan orang membeli kopi di MRT. Ada laporan mesin sempat kosong."
    assert stored["quotes"] == [{
        "type": "pujian", "text": "beli tanpa antre", "ref_id": refs["convenience"],
        "platform": "threads", "author": "@ani",
    }]
    assert set(stored["evidence_ids"]) == {refs["convenience"], refs["machine"]}
    assert stored["overall_supporting_ids"] == [refs["convenience"], refs["machine"]]
    assert stored["themes"] == [{
        "title": "Mesin kosong", "stance": "negatif", "description": "Mesin sempat kosong.",
        "supporting_ids": [refs["machine"]], "platforms": ["tiktok"],
    }]
    assert stored["cost_usd"] == 0


def _queue_question(db, question: str, question_id: str) -> None:
    db.execute(
        """
        insert into instant_search_questions
          (id, search_id, customer_id, question, status, user_credits)
        values (%s, %s, %s, %s, 'queued', 1)
        """,
        (question_id, SEARCH, CUSTOMER, question),
    )


def test_question_cycle_claims_at_most_two_and_does_not_reclaim_a_failure(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    finish_search(db, job, "succeeded")
    ids = [
        "33333333-3333-4333-8333-333333333341",
        "33333333-3333-4333-8333-333333333342",
        "33333333-3333-4333-8333-333333333343",
        "33333333-3333-4333-8333-333333333344",
        "33333333-3333-4333-8333-333333333345",
    ]
    for question_id in ids:
        _queue_question(db, "Apa keluhan utama?", question_id)
    calls = []

    class Boom:
        def generate_json(self, **kwargs):
            calls.append(kwargs.get("search_id"))
            raise GeminiError("http_500")

    now = datetime.now(timezone.utc)
    claimed = run_question_cycle(db, env={"CARI_AI_PROVIDER": "gemini"}, now=now, llm=Boom(), limit=9)
    assert claimed == 2
    assert calls == [job.id, job.id]
    again = run_question_cycle(db, env={"CARI_AI_PROVIDER": "gemini"}, now=now, llm=Boom(), limit=9)
    assert again == 2
    assert len(calls) == 4
    failed = db.execute(
        "select count(*) as n from instant_search_questions where status = 'failed'"
    )[0]["n"]
    queued = db.execute(
        "select count(*) as n from instant_search_questions where status = 'queued'"
    )[0]["n"]
    assert failed == 4
    assert queued == 1
    third = run_question_cycle(db, env={"CARI_AI_PROVIDER": "gemini"}, now=now, llm=Boom())
    assert third == 1
    assert len(calls) == 5
    parked = run_question_cycle(db, env={"CARI_AI_PROVIDER": "gemini"}, now=now, llm=Boom())
    assert parked == 0
    assert len(calls) == 5


def test_a_store_error_after_the_claim_does_not_requeue_the_question(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    finish_search(db, job, "succeeded")
    question_id = "33333333-3333-4333-8333-333333333346"
    _queue_question(db, "Apa keluhan utama?", question_id)

    class Guard:
        def execute(self, sql, params=None):
            text = " ".join(sql.split())
            # The deadline sweep also writes status = 'failed'. Only the answer
            # update, which clears the answer, is the store this test breaks.
            if "answer = null" in text or "status = 'done'" in text:
                raise RuntimeError("store failed")
            return db.execute(sql, params)

        def commit(self):
            return db.commit()

        def rollback(self):
            return db.rollback()

    class Boom:
        def generate_json(self, **kwargs):
            raise GeminiError("http_500")

    with pytest.raises(RuntimeError, match="store failed"):
        run_question_cycle(
            Guard(), env={"CARI_AI_PROVIDER": "gemini"}, now=datetime.now(timezone.utc), llm=Boom(),
        )
    row = db.execute(
        "select status from instant_search_questions where id=%s", (question_id,)
    )[0]
    assert row["status"] == "running"
    calls = []

    class Counting:
        def generate_json(self, **kwargs):
            calls.append(1)
            raise GeminiError("http_500")

    assert run_question_cycle(
        db, env={"CARI_AI_PROVIDER": "gemini"}, now=datetime.now(timezone.utc), llm=Counting(),
    ) == 0
    assert calls == []


def test_question_failure_does_not_change_the_search(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    finish_search(db, job, "succeeded")
    _queue_question(db, "Apa keluhan utama?", "33333333-3333-4333-8333-333333333333")

    class Boom:
        def generate_json(self, **kwargs):
            raise GeminiError("http_500")

    claimed = run_question_cycle(
        db, env={"CARI_AI_PROVIDER": "gemini"}, now=datetime.now(timezone.utc), llm=Boom(),
    )
    assert claimed == 1
    search = db.execute(
        "select status, error_code from instant_searches where id=%s", (job.id,)
    )[0]
    assert search["status"] == "succeeded"
    assert search["error_code"] is None
    row = db.execute(
        "select status, answer, safe_detail from instant_search_questions where id=%s",
        ("33333333-3333-4333-8333-333333333333",),
    )[0]
    assert row["status"] == "failed"
    assert row["answer"] is None
    assert row["safe_detail"] == "http_500"


@pytest.mark.parametrize(
    ("status", "version", "failure"),
    [("succeeded", 0, "no_evidence"), ("running", 1, "not_found")],
)
def test_questions_need_completed_current_search_evidence(db, status, version, failure):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    db.execute("update instant_searches set status = %s, relevance_version = %s where id = %s", (status, version, job.id))
    question_id = "33333333-3333-4333-8333-333333333333"
    _queue_question(db, "Apa keluhan utama?", question_id)
    called = []

    class Model:
        def generate_json(self, **kwargs):
            called.append(kwargs)
            raise AssertionError("questions require completed current search evidence")

    run_question_cycle(db, env={"CARI_AI_PROVIDER": "gemini"}, now=datetime.now(timezone.utc), llm=Model())
    assert called == []
    assert db.execute(
        "select status, safe_detail from instant_search_questions where id = %s", (question_id,),
    ) == [{"status": "failed", "safe_detail": failure}]


def test_question_stores_known_citations_and_drops_the_rest(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [replace(post("threads", "th-1"), text="Barayam antrean panjang")])
    finish_search(db, job, "succeeded")
    result_id = db.execute(
        "select id from instant_search_results where search_id=%s", (job.id,)
    )[0]["id"]
    _queue_question(db, "Apa keluhan utama?", "33333333-3333-4333-8333-333333333334")
    client = ScriptedGemini([
        GeminiResult(
            data={
                "answer": "Keluhan utama adalah antrean.",
                "citations": [f"result:{result_id}", "result:missing"],
            },
            model="scripted",
            input_tokens=4,
            output_tokens=2,
            cost_usd=0.001,
        )
    ])
    run_question_cycle(
        db, env={"CARI_AI_PROVIDER": "gemini"}, now=datetime.now(timezone.utc), llm=client,
    )
    row = db.execute(
        "select status, answer, citations, evidence_ids, model, cost_usd from instant_search_questions"
    )[0]
    citations = row["citations"]
    if isinstance(citations, str):
        citations = json.loads(citations)
    assert row["status"] == "done"
    assert row["answer"] == "Keluhan utama adalah antrean."
    assert citations == [f"result:{result_id}"]
    assert row["evidence_ids"] == citations
    assert row["model"] == "scripted"
    assert float(row["cost_usd"]) == 0.001
    search = db.execute("select status, error_code from instant_searches where id=%s", (job.id,))[0]
    assert search["status"] == "succeeded"
    assert search["error_code"] is None


def test_question_keeps_http_4xx_and_paused_and_logs_the_code(db, caplog):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    finish_search(db, job, "succeeded")
    codes = (
        ("http_4xx", "33333333-3333-4333-8333-333333333335"),
        ("paused", "33333333-3333-4333-8333-333333333336"),
    )
    for code, question_id in codes:
        _queue_question(db, "Apa keluhan utama?", question_id)

        class Boom:
            def generate_json(self, **kwargs):
                raise GeminiError(code)

        with caplog.at_level(logging.INFO):
            run_question_cycle(
                db, env={"CARI_AI_PROVIDER": "gemini"}, now=datetime.now(timezone.utc), llm=Boom(),
            )
        row = db.execute(
            "select status, safe_detail from instant_search_questions where id=%s",
            (question_id,),
        )[0]
        assert row["status"] == "failed"
        assert row["safe_detail"] == code
        assert f"question_detail={code}" in caplog.text


def test_question_passes_the_connect_factory_to_gemini(db, monkeypatch):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    finish_search(db, job, "succeeded")
    _queue_question(db, "Apa keluhan utama?", "33333333-3333-4333-8333-333333333337")
    seen = []

    def fake_create(env, conn=None):
        seen.append(conn)
        return ScriptedGemini([
            GeminiResult(
                data={"answer": "Ada.", "citations": []},
                model="scripted",
                input_tokens=1,
                output_tokens=1,
                cost_usd=0,
            )
        ])

    monkeypatch.setattr(instant_search, "create_gemini", fake_create)
    factory = object()
    run_question_cycle(
        db,
        env={"CARI_AI_PROVIDER": "gemini"},
        now=datetime.now(timezone.utc),
        connect=factory,
    )
    assert seen == [factory]


def test_runner_passes_the_route_timeout_to_each_fetch(db):
    from sentiment_monitor.providers.canonical import PlatformFetch

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


def test_grounded_sample_keeps_contextual_replies_and_balances_platforms(db):
    db.execute("update instant_searches set query_text = 'tukuliling kopi' where id = %s", (SEARCH,))
    job = claim_instant_search(db, "worker-1")
    parent = "Tukuliling di MRT ASEAN memudahkan beli tanpa antre."
    empty = "Kopi Tuku #tukuliling di MRT Lebak Bulus. Mesin sempat kosong."
    unrelated = "Kopi keliling independen, pesan sekarang."
    insert_posts(db, job, [
        replace(post("threads", "th-1"), text=parent),
        replace(post("threads", "th-2"), text=empty),
        replace(post("tiktok", "tk-1"), text="Kopi Tukuliling ada di stasiun MRT."),
        replace(post("youtube", "noisy"), text=unrelated, relevance="no_match"),
    ])
    result_rows = db.execute("select id, text from instant_search_results where search_id = %s", (job.id,))
    by_text = {row["text"]: str(row["id"]) for row in result_rows}
    for parent_text, replies in [
        (parent, ["Praktis buat mengejar kereta.", "Jual akun game murah.", "Kafe kopi lain segera buka."]),
        (empty, ["Mesin kosong tadi pagi.", "🔥🔥"]),
    ]:
        for index, reply in enumerate(replies):
            db.execute(
                """insert into instant_search_comments
                   (id, search_id, result_id, customer_id, platform, external_id, author_name, text, source_provider, raw_ref)
                   values (gen_random_uuid(), %s, %s, %s, 'threads', %s, 'rina', %s, 'fixture', 'fixture:reply')""",
                (job.id, by_text[parent_text], job.customer_id, str(index), reply),
            )

    db.execute(
        "update instant_search_results set rank = case external_id when 'th-1' then 99 when 'th-2' then 1 else 30 end"
        " where search_id = %s", (job.id,),
    )
    sample = instant_search._load_summary_input(db, job)
    _, user = instant_search.build_summary_prompt(sample)
    items = json.loads(user.split("<<<DATA>>>\n")[1].split("\n<<<END DATA>>>")[0])
    assert {item["text"] for item in items} == {parent, empty, "Kopi Tukuliling ada di stasiun MRT."}
    assert len({item["platform"] for item in items[:2]}) == 2
    assert {item["text"]: [reply["text"] for reply in item["comments"]] for item in items if item["comments"]} == {
        parent: ["Praktis buat mengejar kereta."], empty: ["Mesin kosong tadi pagi."],
    }
    db.execute("update instant_search_results set rank = 100 - rank where search_id = %s", (job.id,))
    assert instant_search._load_summary_input(db, replace(job, sort_mode="newest")) == sample


def test_one_retained_post_skips_the_model_and_marks_summary_insufficient(db):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [post()])
    finish_search(db, job, "succeeded")
    summarize_search(db, job, llm=FailingGemini(), now=datetime.now(timezone.utc))
    assert db.execute("select summary_status from instant_searches where id = %s", (job.id,))[0] == {
        "summary_status": "insufficient",
    }


@pytest.mark.parametrize(("captions", "first_summary_status"), [
    (["Barayam banyak antrean."], "insufficient"),
    (["Barayam banyak antrean.", "Barayam ramai saat makan siang."], "running"),
])
def test_runner_publishes_a_terminal_search_with_summary_state(db, monkeypatch, captions, first_summary_status):
    job = claim_instant_search(db, "worker-1")
    seen = []
    run = instant_search._Transactions.run

    def observe(tx, operation):
        value = run(tx, operation)
        state = db.execute(
            "select status, summary_status from instant_searches where id = %s", (job.id,),
        )[0]
        if state["status"] == "succeeded":
            seen.append(state["summary_status"])
        return value

    monkeypatch.setattr(instant_search._Transactions, "run", observe)

    def fetcher(platform, *args, **kwargs):
        posts = [
            replace(post(platform, f"fixture-{index}"), text=text, replies=0)
            for index, text in enumerate(captions)
        ]
        return PlatformFetch(platform, posts=posts, state="answered")

    run_instant_search(
        db, job, env={"CARI_AI_PROVIDER": "gemini"}, now=datetime(2026, 11, 16, tzinfo=timezone.utc),
        settings={"youtube": DEFAULT_SETTINGS["youtube"]}, fetcher=fetcher, llm=FailingGemini(),
    )

    assert seen and seen[0] == first_summary_status
    assert "pending" not in seen
