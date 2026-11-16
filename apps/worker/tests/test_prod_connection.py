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

    monkeypatch.setattr(scheduler, "run_instant_search_poll", fake_cycle)
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


def test_retention_purge_keeps_the_credit_ledger(prod_db):
    expired = _queue_search(prod_db, "barayam lama", deadline_seconds=-100)
    prod_db.admin.execute(
        "update instant_searches set status = 'succeeded', retention_expires_at = now() - interval '1 minute' where id = %s",
        (expired,),
    )
    prod_db.admin.execute(
        """
        insert into search_credit_ledger
          (id, search_id, customer_id, provider, platform, route, credits_charged,
           http_status, safe_detail, body_length, latency_ms)
        values (%s, %s, %s, 'scrapeatlas', 'youtube', 'scrapeatlas.youtube.search', 2,
                200, 'ok', 40, 12)
        """,
        (str(uuid.uuid4()), expired, prod_db.customer),
    )
    deleted = scheduler._call(
        prod_db.connect,
        lambda conn: instant_search.expire_old_searches(conn, datetime.now(timezone.utc)),
    )
    assert deleted == 1
    searches = prod_db.admin.execute(
        "select count(*) as n from instant_searches where id = %s", (expired,)
    ).fetchone()["n"]
    ledger = prod_db.admin.execute(
        "select search_id, customer_id, provider, credits_charged from search_credit_ledger"
    ).fetchall()
    assert searches == 0
    assert len(ledger) == 1, ledger
    assert ledger[0]["search_id"] is None
    assert ledger[0]["provider"] == "scrapeatlas"
    assert ledger[0]["credits_charged"] == 2


def test_platform_results_are_capped_after_dedupe(prod_db):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=40)

    def many(platform, keyword, settings, **kwargs):
        return PlatformFetch(
            platform,
            "scrapeatlas",
            [_post(platform, f"{platform}-{index}") for index in range(250)],
            [_call(platform, "")],
            "answered",
            "ok",
            5,
        )

    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=many,
        settings={"youtube": DEFAULT_SETTINGS["youtube"]},
    )
    assert processed == 1
    view = prod_db.view(search_id)
    assert view["counts"].get("youtube") == instant_search.MAX_PLATFORM_RESULTS
    assert view["sources"][0]["result_count"] == instant_search.MAX_PLATFORM_RESULTS


def test_app_user_cannot_attach_a_child_row_to_another_tenants_search(prod_db):
    import psycopg
    import pytest

    other_customer = str(uuid.uuid4())
    other_search = str(uuid.uuid4())
    prod_db.admin.execute(
        "insert into customers (id, customer_id, created_at) values (%s, %s, now())",
        (other_customer, other_customer),
    )
    prod_db.admin.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, deadline_at)
        values (%s, %s, 'barayam', 'phrase', 'all', 'relevance', 'all', 'queued',
                now() + interval '40 seconds')
        """,
        (other_search, other_customer),
    )
    prod_db.observer.execute(
        "select set_config('app.customer_id', %s, false)", (prod_db.customer,)
    )
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        prod_db.observer.execute(
            """
            insert into instant_search_sources
              (search_id, customer_id, platform, provider, state)
            values (%s, %s, 'youtube', 'scrapeatlas', 'queued')
            """,
            (other_search, prod_db.customer),
        )
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        prod_db.observer.execute(
            """
            insert into instant_search_questions
              (id, search_id, customer_id, question, status)
            values (%s, %s, %s, 'kenapa?', 'queued')
            """,
            (str(uuid.uuid4()), other_search, prod_db.customer),
        )


def test_worker_claims_a_search_that_arrives_while_a_slow_batch_is_running(prod_db, monkeypatch):
    import threading
    import time

    prod_db.admin.execute("delete from instant_searches")
    first = _queue_search(prod_db, "barayam slow", deadline_seconds=30)
    started: list[str] = []
    first_started = threading.Event()
    release = threading.Event()

    def fake_run(connect, job, **kwargs):
        started.append(job.id)
        if job.id == first:
            first_started.set()
            release.wait(10)

    monkeypatch.setattr(instant_search, "run_instant_search", fake_run)
    stop = threading.Event()
    thread = scheduler.start_instant_search_worker(
        prod_db.connect, stop, poll_seconds=0.1, log=lambda line: None
    )
    try:
        assert first_started.wait(5), started
        second = _queue_search(prod_db, "barayam tengah", deadline_seconds=30)
        claimed = None
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            row = prod_db.admin.execute(
                "select status, started_at, error_code from instant_searches where id = %s",
                (second,),
            ).fetchone()
            if row["started_at"] is not None:
                claimed = row
                break
            time.sleep(0.05)
        assert claimed is not None, (started, prod_db.admin.execute(
            "select id, status, started_at, error_code from instant_searches order by created_at"
        ).fetchall())
        assert claimed["status"] == "running"
        assert claimed["error_code"] != "deadline"
    finally:
        release.set()
        stop.set()
        thread.join(5)


def test_oversized_credit_headers_are_unknown_and_do_not_leave_the_search_running(prod_db):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam kredit", deadline_seconds=30)
    oversized = 2**31 - 1

    def fetch(platform, keyword, settings, **kwargs):
        calls = [
            RouteCall(
                "scrapeatlas",
                platform,
                "scrapeatlas.search",
                "success",
                200,
                oversized,
                10,
                5,
                "ok",
            )
            for _ in range(2)
        ]
        return PlatformFetch(
            platform,
            "scrapeatlas",
            [_post(platform, f"{platform}-1")],
            calls,
            "answered",
            "ok",
            5,
        )

    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=fetch,
        settings={"youtube": DEFAULT_SETTINGS["youtube"]},
    )
    assert processed == 1
    view = prod_db.view(search_id)
    assert view["search"]["status"] in ("succeeded", "partial"), view
    assert view["search"]["finished_at"] is not None, view
    assert view["search"]["credits_used"] == 0, view
    assert view["sources"][0]["state"] == "answered", view
    assert view["counts"].get("youtube") == 1, view
    ledger = prod_db.admin.execute(
        "select credits_charged from search_credit_ledger where search_id = %s", (search_id,)
    ).fetchall()
    assert [row["credits_charged"] for row in ledger] == [None, None], ledger


def _seven_platform_fetch(*, poison_date: str | None = None, delay: float = 0.0):
    from dataclasses import replace
    import time

    calls: list[str] = []

    def fetch(platform, keyword, settings, **kwargs):
        calls.append(platform)
        if delay:
            time.sleep(delay)
        posts = [_post(platform, f"{platform}-{index}") for index in range(3)]
        if platform == "youtube" and poison_date is not None:
            posts[0] = replace(posts[0], published_at=poison_date)
        return PlatformFetch(
            platform,
            "scrapeatlas",
            posts,
            [_call(platform, "")],
            "answered",
            "ok",
            5,
        )

    return fetch, calls


def _assert_isolated_search(prod_db, search_id: str, calls: list[str], *, youtube_state: str):
    view = prod_db.view(search_id)
    assert view["ledger"] == 7, view
    assert calls == ["threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin"] or (
        sorted(calls) == sorted(["threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin"])
    ), calls
    states = {row["platform"]: row for row in view["sources"]}
    assert len(states) == 7, view
    assert not [row for row in view["sources"] if row["state"] in ("queued", "searching")], view
    for platform in ("threads", "tiktok", "instagram", "reddit", "facebook", "linkedin"):
        assert states[platform]["state"] == "answered", view
        assert states[platform]["result_count"] == 3, view
        assert view["counts"].get(platform) == 3, view
    youtube = states["youtube"]
    if youtube_state == "answered":
        assert youtube["state"] == "answered", view
        assert youtube["result_count"] == 3, view
        assert view["counts"].get("youtube") == 3, view
        assert prod_db.admin.execute(
            "select count(*) as n from instant_search_results "
            "where search_id = %s and platform = 'youtube' and published_at is null",
            (search_id,),
        ).fetchone()["n"] == 1
    else:
        assert youtube["state"] == "failed", view
        assert youtube["safe_detail"] == "storage_failed", view
        assert view["counts"].get("youtube", 0) == 0, view
    assert view["search"]["status"] in ("succeeded", "partial"), view
    assert view["search"]["error_code"] != "storage_failed", view


def test_far_offset_date_on_one_platform_does_not_abort_the_search(prod_db):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=30)
    fetcher, calls = _seven_platform_fetch(poison_date="9999-12-31T23:59:59-14:00")

    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=fetcher,
    )
    assert processed == 1
    _assert_isolated_search(prod_db, search_id, calls, youtube_state="answered")
    assert len(calls) == 7

    again = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=fetcher,
    )
    assert again == 0
    assert len(calls) == 7


def test_normalisation_exception_on_one_platform_is_isolated(prod_db, monkeypatch):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=30)
    fetcher, calls = _seven_platform_fetch()

    original = instant_search._normalize

    def exploding_normalize(item, job):
        if item.platform == "youtube":
            raise RuntimeError("synthetic normalisation failure")
        return original(item, job)

    monkeypatch.setattr(instant_search, "_normalize", exploding_normalize)
    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=fetcher,
    )
    assert processed == 1
    _assert_isolated_search(prod_db, search_id, calls, youtube_state="failed")
    assert len(calls) == 7
