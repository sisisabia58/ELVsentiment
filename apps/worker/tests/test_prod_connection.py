"""Regressions that only reproduce on the production worker connection path.

Production wires ``scheduler._call`` over ``CursorRowAdapter(psycopg(...))``.
The shape differences (cursor rows vs None for writes) are invisible to the
plain RowListConnection used by the older tests.
"""

from datetime import datetime, timezone
import uuid

from sentiment_monitor import instant_search
from sentiment_monitor import scheduler
from sentiment_monitor.providers.canonical import CanonicalComment, CanonicalPost, RouteCall
from sentiment_monitor.providers.capabilities import DEFAULT_SETTINGS
from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch


def _post(platform: str, external_id: str) -> CanonicalPost:
    return CanonicalPost(
        platform=platform,
        external_id=external_id,
        text="barayam enak",
        title=None,
        author_name="ani",
        author_handle="@ani",
        url=f"https://example.invalid/{platform}/{external_id}",
        published_at="2026-11-15T00:00:00Z",
        thumbnail_url=None,
        views=10,
        likes=2,
        replies=1,
        shares=0,
        top_replies=(),
        hashtags=(),
        source_provider="scrapeatlas",
        routes=("scrapeatlas.search",),
        raw_ref=f"scrapeatlas:{platform}:{external_id}",
        collected_at="2026-11-16T00:00:00Z",
    )


def _call(platform: str, external_id: str) -> RouteCall:
    return RouteCall(
        "scrapeatlas",
        platform,
        "scrapeatlas.search",
        "success",
        200,
        1,
        10,
        5,
        "ok",
    )


def test_production_wrapper_reports_result_count_matching_stored_rows(prod_db):
    def fetcher(platform, keyword, settings, **kwargs):
        posts = [_post(platform, f"{platform}-{index}") for index in range(3)]
        if platform == "threads":
            posts = [_post(platform, f"{platform}-1"), _post(platform, f"{platform}-1"), _post(platform, f"{platform}-2")]
        return PlatformFetch(platform, "scrapeatlas", posts, [_call(platform, "")], "answered", "ok", 5)

    def run(conn):
        job = instant_search.claim_instant_search(conn, "worker-1")
        assert job is not None
        instant_search.run_instant_search(
            conn,
            job,
            env={},
            now=datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc),
            settings=dict(DEFAULT_SETTINGS),
            fetcher=fetcher,
        )

    scheduler._call(prod_db.connect, run)
    view = prod_db.view(prod_db.search)
    assert view["search"]["status"] == "succeeded"
    assert view["counts"], view
    for row in view["sources"]:
        platform = row["platform"]
        assert row["state"] == "answered", view
        assert row["result_count"] == view["counts"].get(platform, 0), (row, view["counts"])
    assert view["sources"] and {row["platform"]: row["result_count"] for row in view["sources"]}["threads"] == 2


def test_production_wrapper_counts_inserted_comments(prod_db):
    def run(conn):
        job = instant_search.claim_instant_search(conn, "worker-1")
        assert job is not None
        instant_search.run_instant_search(
            conn,
            job,
            env={},
            now=datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc),
            settings={"youtube": DEFAULT_SETTINGS["youtube"]},
            fetcher=lambda platform, keyword, settings, **kwargs: PlatformFetch(
                platform,
                "scrapeatlas",
                [_post(platform, "vid-1")],
                [_call(platform, "")],
                "answered",
                "ok",
                5,
            ),
        )

    scheduler._call(prod_db.connect, run)
    result_id = prod_db.admin.execute(
        "select id from instant_search_results where search_id = %s", (prod_db.search,)
    ).fetchone()["id"]
    comment = CanonicalComment(
        external_id="c-1",
        text="enak",
        author_name="budi",
        author_handle="@budi",
        published_at=None,
        likes=3,
        replies=None,
        source_provider="scrapeatlas",
        raw_ref="scrapeatlas:comment:c-1",
    )

    def store(conn):
        from sentiment_monitor.instant_search import InstantSearchJob

        job = InstantSearchJob(
            id=prod_db.search,
            customer_id=prod_db.customer,
            query="barayam",
        )
        return instant_search.insert_comments(conn, job, result_id, [comment, comment])

    assert scheduler._call(prod_db.connect, store) == 1


def test_production_wrapper_counts_expired_searches(prod_db):
    expired = str(uuid.uuid4())
    prod_db.admin.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, deadline_at, retention_expires_at)
        values (%s, %s, 'lama', 'phrase', 'all', 'relevance', 'all', 'succeeded',
                now() - interval '2 days', now() - interval '1 day')
        """,
        (expired, prod_db.customer),
    )
    deleted = scheduler._call(
        prod_db.connect,
        lambda conn: instant_search.expire_old_searches(conn, datetime.now(timezone.utc)),
    )
    assert deleted == 1


def _queue_search(prod_db, query: str, deadline_seconds: int = 40) -> str:
    search_id = str(uuid.uuid4())
    prod_db.admin.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, created_at, deadline_at, retention_expires_at)
        values (%s, %s, %s, 'phrase', 'all', 'relevance', 'all', 'queued',
                now(), now() + make_interval(secs => %s), now() + interval '30 days')
        """,
        (search_id, prod_db.customer, query, deadline_seconds),
    )
    return search_id


def _fast_fetch(platform, keyword, settings, **kwargs):
    return PlatformFetch(
        platform,
        "scrapeatlas",
        [_post(platform, f"{platform}-1")],
        [_call(platform, "")],
        "answered",
        "ok",
        5,
    )


def test_cycle_commits_running_progress_while_a_slow_fetch_is_in_flight(prod_db, monkeypatch):
    import threading
    import time

    def slow(platform, keyword, settings, **kwargs):
        time.sleep(3 if platform == "tiktok" else 0.05)
        return _fast_fetch(platform, keyword, settings, **kwargs)

    observed = []
    result = {}

    def run():
        result["processed"] = instant_search.run_instant_search_cycle(
            prod_db.connect,
            env={},
            now=datetime.now(timezone.utc),
            limits=None,
            fetcher=slow,
        )

    thread = threading.Thread(target=run)
    thread.start()
    deadline = time.monotonic() + 2
    while thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.05)
        view = prod_db.view(prod_db.search)
        observed.append((view["search"]["status"], sorted({row["state"] for row in view["sources"]})))
    thread.join(10)
    assert result["processed"] == 1
    assert any(
        status == "running" or "answered" in states for status, states in observed
    ), observed
    view = prod_db.view(prod_db.search)
    assert view["search"]["status"] == "succeeded"
    assert view["search"]["started_at"] < view["search"]["finished_at"]


def test_cycle_runs_three_queued_searches_concurrently(prod_db):
    import time

    prod_db.admin.execute("delete from instant_searches")
    ids = [_queue_search(prod_db, f"barayam {index}", deadline_seconds=8) for index in range(3)]

    def slow(platform, keyword, settings, **kwargs):
        time.sleep(1)
        return PlatformFetch(
            platform,
            "scrapeatlas",
            [_post(platform, f"{platform}-{keyword}")],
            [_call(platform, "")],
            "answered",
            "ok",
            5,
        )

    started = time.monotonic()
    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=slow,
        deadline_seconds=6,
        max_searches=4,
    )
    elapsed = time.monotonic() - started
    assert processed == 3
    assert elapsed < 5, elapsed
    for search_id in ids:
        view = prod_db.view(search_id)
        assert view["search"]["status"] in ("succeeded", "partial"), view
        assert view["search"]["started_at"] is not None
        assert view["search"]["error_code"] != "deadline"


def test_instant_search_worker_thread_starts_and_stops(monkeypatch):
    import threading

    from sentiment_monitor import scheduler

    ran = threading.Event()
    calls = []

    def fake_cycle(connect, **kwargs):
        calls.append(connect)
        ran.set()
        return 0

    monkeypatch.setattr(scheduler, "run_instant_search_cycle", fake_cycle)
    stop = threading.Event()
    thread = scheduler.start_instant_search_worker(
        lambda: object(), stop, poll_seconds=0.01, log=lambda line: None
    )
    assert ran.wait(2)
    stop.set()
    thread.join(2)
    assert not thread.is_alive()
    assert calls


def test_hung_route_thread_does_not_extend_the_cycle(prod_db, monkeypatch):
    import time

    monkeypatch.setattr(instant_search, "ROUTE_TIMEOUT_SECONDS", 0.5)

    def hung(platform, keyword, settings, **kwargs):
        if platform == "youtube":
            time.sleep(3)
        return _fast_fetch(platform, keyword, settings, **kwargs)

    started = time.monotonic()
    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=hung,
        deadline_seconds=0.2,
    )
    elapsed = time.monotonic() - started
    assert processed == 1
    assert elapsed < 0.2 + 0.5 + 0.5, elapsed
    view = prod_db.view(prod_db.search)
    assert view["search"]["status"] in ("partial", "failed"), view
    assert "youtube" not in view["counts"], view
