"""Regressions that only reproduce on the production worker connection path.

Production wires ``scheduler._call`` over ``CursorRowAdapter(psycopg(...))``.
The shape differences (cursor rows vs None for writes) are invisible to the
plain RowListConnection used by the older tests.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from typing import Any
import uuid

import pytest

from sentiment_monitor import instant_search
from sentiment_monitor import scheduler
from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import CanonicalComment, CanonicalPost, RouteCall
from sentiment_monitor.providers.capabilities import DEFAULT_SETTINGS, ProviderSetting
from sentiment_monitor.providers.fetch import fetch_platform
from sentiment_monitor.providers.canonical import PlatformFetch


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
    ids = [_queue_search(prod_db, f"barayam {index}", deadline_seconds=20) for index in range(3)]

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
        deadline_seconds=20,
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

    # The cycle budget is 0.2s, under the production launch floor. Drop the
    # floor so this test actually starts the hung fetch and joins it.
    monkeypatch.setattr(instant_search, "MIN_LAUNCH_SECONDS", 0.0)
    monkeypatch.setattr(instant_search, "ROUTE_TIMEOUT_SECONDS", 0.5)
    launched: list[str] = []

    def hung(platform, keyword, settings, **kwargs):
        launched.append(platform)
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
    assert launched, "the cycle returned before any route was launched"
    assert "youtube" in launched
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
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=30)
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


def _eight_platform_fetch(*, poison_date: str | None = None, delay: float = 0.0):
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
    assert view["ledger"] == 8, view
    assert calls == ["threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin", "x"] or (
        sorted(calls) == sorted(["threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin", "x"])
    ), calls
    states = {row["platform"]: row for row in view["sources"]}
    assert len(states) == 8, view
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
    fetcher, calls = _eight_platform_fetch(poison_date="9999-12-31T23:59:59-14:00")

    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=fetcher,
    )
    assert processed == 1
    _assert_isolated_search(prod_db, search_id, calls, youtube_state="answered")
    assert len(calls) == 8

    again = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=fetcher,
    )
    assert again == 0
    assert len(calls) == 8


def test_normalisation_exception_on_one_post_keeps_its_siblings(prod_db, monkeypatch):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=30)
    fetcher, calls = _eight_platform_fetch()

    original = instant_search._normalize

    def exploding_normalize(item, job):
        if item.platform == "youtube" and item.external_id == "youtube-1":
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
    view = prod_db.view(search_id)
    assert view["ledger"] == 8, view
    states = {row["platform"]: row for row in view["sources"]}
    assert len(states) == 8, view
    assert not [row for row in view["sources"] if row["state"] in ("queued", "searching")], view
    for platform in ("threads", "tiktok", "instagram", "reddit", "facebook", "linkedin"):
        assert states[platform]["state"] == "answered", view
        assert states[platform]["result_count"] == 3, view
        assert view["counts"].get(platform) == 3, view
    assert states["youtube"]["state"] == "answered", view
    assert states["youtube"]["result_count"] == 2, view
    assert view["counts"].get("youtube") == 2, view
    assert calls == ["threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin", "x"] or (
        sorted(calls) == sorted(["threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin", "x"])
    ), calls
    assert view["search"]["status"] in ("succeeded", "partial"), view


def test_oversized_external_id_drops_only_that_post(prod_db):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=30)
    oversized = (uuid.uuid4().hex * 400)[:10_000]

    def fetch(platform, keyword, settings, **kwargs):
        posts = [
            _post(platform, f"{platform}-1"),
            _post(platform, oversized),
            _post(platform, f"{platform}-2"),
        ]
        return PlatformFetch(platform, "scrapeatlas", posts, [_call(platform, "")], "answered", "ok", 5)

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
    assert view["ledger"] == 1, view
    assert len(view["sources"]) == 1, view
    source = view["sources"][0]
    assert source["state"] == "answered", view
    assert source["result_count"] == 2, view
    assert view["counts"].get("youtube") == 2, view
    assert source["safe_detail"] in instant_search.SAFE_DETAILS, view
    assert source["safe_detail"] not in ("storage", "other"), view
    stored = prod_db.admin.execute(
        "select external_id from instant_search_results where search_id = %s order by external_id",
        (search_id,),
    ).fetchall()
    assert [row["external_id"] for row in stored] == ["youtube-1", "youtube-2"]


def test_one_failing_row_insert_keeps_its_sibling_posts(prod_db, monkeypatch):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=30)

    def fetch(platform, keyword, settings, **kwargs):
        posts = [
            _post(platform, f"{platform}-1"),
            _post(platform, "boom"),
            _post(platform, f"{platform}-2"),
        ]
        return PlatformFetch(platform, "scrapeatlas", posts, [_call(platform, "")], "answered", "ok", 5)

    original = instant_search._insert_post_row

    def flaky_row(conn, job, item, identity):
        if item.external_id == "boom":
            raise RuntimeError("synthetic row insert failure")
        return original(conn, job, item, identity)

    monkeypatch.setattr(instant_search, "_insert_post_row", flaky_row)
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
    assert view["ledger"] == 1, view
    source = view["sources"][0]
    assert source["state"] == "answered", view
    assert source["result_count"] == 2, view
    assert view["counts"].get("youtube") == 2, view
    assert source["safe_detail"] in instant_search.SAFE_DETAILS, view
    assert source["safe_detail"] not in ("storage", "other"), view


def _poll_once(prod_db, fetcher, *, deadline_seconds=instant_search.SEARCH_DEADLINE_SECONDS, max_workers=8):
    from concurrent.futures import ThreadPoolExecutor

    executor = ThreadPoolExecutor(max_workers=max_workers)
    in_flight: set[Any] = set()
    instant_search.run_instant_search_poll(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        submit=executor.submit,
        in_flight=in_flight,
        settings=dict(DEFAULT_SETTINGS),
        fetcher=fetcher,
        deadline_seconds=deadline_seconds,
    )
    for future in list(in_flight):
        future.result()
    executor.shutdown(wait=False, cancel_futures=True)


def test_eight_platform_routes_run_in_one_wave(prod_db):
    import time

    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=30)
    fetcher, calls = _eight_platform_fetch(delay=0.4)

    started = time.monotonic()
    _poll_once(prod_db, fetcher)
    elapsed = time.monotonic() - started
    assert elapsed < 0.7, elapsed
    assert sorted(calls) == sorted(
        ["threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin", "x"]
    )
    view = prod_db.view(search_id)
    assert view["search"]["status"] == "succeeded", view
    assert view["ledger"] == 8, view
    assert view["counts"] == {
        "threads": 3,
        "tiktok": 3,
        "instagram": 3,
        "youtube": 3,
        "reddit": 3,
        "facebook": 3,
        "linkedin": 3,
        "x": 3,
    }, view


def test_search_finishes_by_its_own_deadline_not_claim_plus_budget(prod_db, monkeypatch):
    import time

    monkeypatch.setattr(instant_search, "ROUTE_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(instant_search, "MIN_LAUNCH_SECONDS", 1.0)
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=1.2)
    calls: list[str] = []

    def slow(platform, keyword, settings, **kwargs):
        calls.append(platform)
        time.sleep(3)
        return PlatformFetch(
            platform, "scrapeatlas", [_post(platform, f"{platform}-1")], [_call(platform, "")], "answered", "ok", 5
        )

    started = time.monotonic()
    _poll_once(prod_db, slow, deadline_seconds=40)
    elapsed = time.monotonic() - started
    assert len(calls) == 8
    assert elapsed < 2.5, elapsed
    view = prod_db.view(search_id)
    assert view["search"]["status"] in ("partial", "failed"), view
    assert view["search"]["error_code"] != "storage_failed", view
    assert not [row for row in view["sources"] if row["state"] in ("queued", "searching")], view


def test_hung_route_does_not_delay_finish_search(prod_db, monkeypatch):
    import time

    # The search's own deadline is 0.5s, under the production launch floor.
    # Drop the floor so the hung fetch starts and the join still bounds the cycle.
    monkeypatch.setattr(instant_search, "MIN_LAUNCH_SECONDS", 0.0)
    monkeypatch.setattr(instant_search, "ROUTE_TIMEOUT_SECONDS", 1.0)
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=0.5)
    finished: list[float] = []
    launched: list[str] = []
    original_finish = instant_search.finish_search

    def recording_finish(conn, job, status, **kwargs):
        finished.append(time.monotonic())
        return original_finish(conn, job, status, **kwargs)

    def fetch(platform, keyword, settings, **kwargs):
        launched.append(platform)
        time.sleep(2)
        return _fast_fetch(platform, keyword, settings, **kwargs)

    monkeypatch.setattr(instant_search, "finish_search", recording_finish)
    started = time.monotonic()
    _poll_once(prod_db, fetch, deadline_seconds=40)
    elapsed = time.monotonic() - started
    assert finished, "finish_search was never called"
    assert launched, "finish ran without launching a route"
    assert finished[0] - started < 0.9, finished[0] - started
    assert elapsed < 2.0, elapsed
    view = prod_db.view(search_id)
    assert view["search"]["status"] in ("partial", "failed"), view
    assert not [row for row in view["sources"] if row["state"] in ("queued", "searching")], view


_N1B_PLATFORMS = ("threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin")
_N1B_SA_PLATFORMS = ("threads", "tiktok", "youtube", "reddit", "facebook", "linkedin")
_N1B_LIST_KEY = {
    "threads": "posts",
    "instagram": "posts",
    "tiktok": "item_list",
    "youtube": "videos",
    "reddit": "posts",
    "facebook": "posts",
    "linkedin": "posts",
}
_N1B_DATES = [
    "0001-01-01",
    "0001-01-01T00:00:00",
    "0001-01-01T03:00:00",
    "9999-12-31T23:59:59",
    "9999-12-31",
    "9999-12-31T23:59:59-14:00",
    "9999-12-31T23:59:59-23:59",
    "0001-01-01T00:00:00+14:00",
    "0001-01-01T00:00:00+23:59",
    "0000-01-01T00:00:00Z",
    "10000-01-01T00:00:00Z",
    1e300,
    "99999999999999999999",
    -62135596801,
    -1e18,
    "NaN",
    "Infinity",
    2**70,
]


class _N1BResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body
        self.status = 200
        self.headers = {"x-credits-charged": "1", "credits-charged": "1"}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size: int = -1) -> bytes:
        return self._body if size is None or size < 0 else self._body[:size]


def _n1b_settings(mode: str) -> dict[str, ProviderSetting]:
    settings = {
        name: ProviderSetting(platform=name, provider="off")
        for name in DEFAULT_SETTINGS
    }
    for platform in _N1B_PLATFORMS:
        settings[platform] = ProviderSetting(platform=platform, provider="scrapeatlas")
    return settings


def _n1b_now_ts() -> int:
    import time

    return int(time.time()) - 3600


def _n1b_recent(platform: str, now_ts: int) -> Any:
    iso = datetime.fromtimestamp(now_ts, timezone.utc).isoformat()
    return {
        "threads": now_ts,
        "instagram": now_ts,
        "tiktok": now_ts,
        "facebook": now_ts,
        "youtube": iso,
        "reddit": iso,
        "linkedin": iso,
    }[platform]


def _n1b_item(platform: str, index: int, date: Any) -> dict[str, Any]:
    ident = f"id{index}"
    text = f"barayam enak {index}"
    if platform == "instagram":
        return {"id": ident, "taken_at_timestamp": date, "edge_media_to_caption": {"edges": [{"node": {"text": text}}]}}
    if platform == "threads":
        return {"pk": ident, "code": f"C{index}", "caption": {"text": text}, "user": {"username": "u"}, "taken_at": date, "like_count": 2}
    if platform == "tiktok":
        return {"id": ident, "desc": text, "createTime": date, "author": {"uniqueId": "u"}, "stats": {"playCount": 5, "diggCount": 2}}
    if platform == "youtube":
        return {"id": ident, "title": text, "url": f"https://example.invalid/youtube/{ident}", "publishedTime": date, "viewCountInt": 5, "channel": {"title": "c"}}
    if platform == "reddit":
        return {"id": ident, "title": text, "permalink": f"/r/x/{ident}", "created_at_iso": date, "score": 2}
    if platform == "facebook":
        return {"id": ident, "text": text, "url": f"https://example.invalid/facebook/{ident}", "publishTime": date, "reactionCount": 2, "videoViewCount": 5}
    return {"id": ident, "description": text, "url": f"https://example.invalid/linkedin/{ident}", "datePublished": date, "likeCount": 2}




def _n1b_payload(platform: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"success": True, "status": "success", _N1B_LIST_KEY[platform]: items}




@contextmanager
def _n1b_tz(name: str):
    import time

    previous = os.environ.get("TZ")
    os.environ["TZ"] = name
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


def _n1b_run(
    prod_db,
    *,
    mode: str,
    window: str,
    poisoned: dict[str, Any],
) -> tuple[dict, int, int, int]:
    from concurrent.futures import ThreadPoolExecutor

    import time

    settings = _n1b_settings(mode)
    now_ts = _n1b_now_ts()
    calls: dict[str, int] = {}

    def opener(request, timeout=None):
        url = request.full_url.split("?")[0]
        platform = next(item for item in _N1B_PLATFORMS if item in url)
        calls[platform] = calls.get(platform, 0) + 1
        date = poisoned.get(platform)
        items = [
            _n1b_item(platform, 1, _n1b_recent(platform, now_ts)),
            _n1b_item(platform, 2, _n1b_recent(platform, now_ts)),
            _n1b_item(
                platform,
                3,
                date if platform in poisoned else _n1b_recent(platform, now_ts),
            ),
        ]
        body = _n1b_payload(platform, items)
        return _N1BResponse(json.dumps(body).encode())

    env = {
        "SCRAPEATLAS_API_KEY": "synthetic-atlas-key",
        "SCRAPECREATORS_API_KEY": "synthetic-creators-key",
        "CARI_PROVIDER_MODE": "live",
    }

    def fetcher(platform, keyword, settings_for_call, **kwargs):
        return fetch_platform(
            platform,
            keyword,
            settings_for_call,
            env=env,
            collected_at=kwargs["collected_at"],
            date_window_days=kwargs.get("date_window_days"),
            opener=opener,
        )

    prod_db.admin.execute(
        "delete from search_credit_ledger where customer_id = %s", (prod_db.customer,)
    )
    prod_db.admin.execute(
        "delete from instant_searches where customer_id = %s", (prod_db.customer,)
    )
    search_id = str(uuid.uuid4())
    prod_db.admin.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, created_at, deadline_at, retention_expires_at)
        values (%s, %s, 'barayam', 'hashtag', %s, 'relevance', 'all', 'queued',
                now(), now() + interval '40 seconds', now() + interval '30 days')
        """,
        (search_id, prod_db.customer, window),
    )
    job = instant_search._Transactions(prod_db.connect).run(
        lambda conn: instant_search.claim_instant_search(conn, "qa")
    )
    assert job is not None
    def comment_fetch(platform, post, **kwargs):
        del platform, kwargs
        from sentiment_monitor.providers.comments import CommentFetch

        # This case proves date handling. Comment pages stay on the fake opener
        # path and must not place a live provider call.
        return CommentFetch(str(getattr(post, "external_id", "") or ""), [], None, "unavailable", "missing_key")

    instant_search._run_job_safely(
        prod_db.connect,
        job,
        {
            "env": env,
            "now": datetime.now(timezone.utc),
            "settings": settings,
            "fetcher": fetcher,
            "comment_fetcher": comment_fetch,
            "deadline_seconds": instant_search.SEARCH_DEADLINE_SECONDS,
        },
    )
    calls_before = sum(calls.values())
    executor = ThreadPoolExecutor(max_workers=2)
    in_flight: set[Any] = set()
    reclaimed = instant_search.run_instant_search_poll(
        prod_db.connect,
        env=env,
        now=datetime.now(timezone.utc),
        limits=None,
        submit=executor.submit,
        in_flight=in_flight,
        settings=settings,
        fetcher=fetcher,
    )
    for future in list(in_flight):
        future.result()
    executor.shutdown(wait=False, cancel_futures=True)
    time.sleep(0)
    return prod_db.view(search_id), calls_before, sum(calls.values()), reclaimed


def _n1b_assert_isolated(
    view: dict,
    *,
    calls_before: int,
    calls_after: int,
    reclaimed: int,
    poisoned: set[str],
    baseline: dict,
    label: str,
) -> None:
    assert view["search"]["status"] in ("succeeded", "partial"), (label, view)
    sources = {row["platform"]: row for row in view["sources"]}
    assert set(sources) == set(_N1B_PLATFORMS), (label, view)
    assert not [
        row for row in view["sources"] if row["state"] in ("queued", "searching")
    ], (label, view)
    assert view["ledger"] == calls_before == calls_after, (label, view, calls_before, calls_after)
    assert reclaimed == 0, (label, reclaimed)
    for platform in _N1B_PLATFORMS:
        source = sources[platform]
        count = view["counts"].get(platform, 0)
        assert source["state"] == "answered", (label, platform, source, view)
        assert source["result_count"] == count, (label, platform, source, view)
        if platform in poisoned:
            assert count >= 2, (label, platform, count, view)
        else:
            assert count == baseline["counts"].get(platform), (label, platform, count, view)


@pytest.mark.parametrize("window", ["7d", "all"])
@pytest.mark.parametrize("tz", ["UTC", "Asia/Jakarta"])
def test_far_dates_never_drop_a_platform_or_its_paid_ledger_row(
    prod_db, window: str, tz: str
):
    with _n1b_tz(tz):
        baseline_sa, sa_before, sa_after, sa_reclaimed = _n1b_run(
            prod_db, mode="SA", window=window, poisoned={}
        )
        _n1b_assert_isolated(
            baseline_sa,
            calls_before=sa_before,
            calls_after=sa_after,
            reclaimed=sa_reclaimed,
            poisoned=set(),
            baseline={**baseline_sa, "counts": {platform: 3 for platform in _N1B_PLATFORMS}},
            label=f"baseline SA {window} {tz}",
        )
        for date in _N1B_DATES:
            label = f"SA {window} {tz} {date!r}"
            sa_poison = {platform: date for platform in _N1B_PLATFORMS}
            view, calls_before, calls_after, reclaimed = _n1b_run(
                prod_db, mode="SA", window=window, poisoned=sa_poison
            )
            _n1b_assert_isolated(
                view,
                calls_before=calls_before,
                calls_after=calls_after,
                reclaimed=reclaimed,
                poisoned=set(_N1B_PLATFORMS),
                baseline=baseline_sa,
                label=label,
            )



def test_no_fetch_is_launched_with_less_than_the_minimum_budget(prod_db):
    import time

    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=5)
    calls: list[str] = []

    def fetch(platform, keyword, settings, **kwargs):
        calls.append(platform)
        time.sleep(10)
        return _fast_fetch(platform, keyword, settings, **kwargs)

    started = time.monotonic()
    _poll_once(prod_db, fetch)
    elapsed = time.monotonic() - started
    assert calls == []
    assert elapsed < 2.0, elapsed
    view = prod_db.view(search_id)
    assert view["ledger"] == 0, view
    assert view["search"]["status"] in ("failed", "partial"), view
    assert not [row for row in view["sources"] if row["state"] in ("queued", "searching")], view
    for row in view["sources"]:
        assert (row["state"], row["safe_detail"]) == ("unavailable", "deadline"), view


def test_straggler_paid_call_reaches_the_ledger_after_the_deadline(prod_db, monkeypatch):
    import time

    monkeypatch.setattr(instant_search, "MIN_LAUNCH_SECONDS", 1.0, raising=False)
    monkeypatch.setattr(instant_search, "ROUTE_TIMEOUT_SECONDS", 5.0)
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=1.5)
    calls: list[str] = []

    def fetch(platform, keyword, settings, **kwargs):
        calls.append(platform)
        time.sleep(2.5 if platform == "youtube" else 0.1)
        return PlatformFetch(
            platform,
            "scrapeatlas",
            [_post(platform, f"{platform}-1")],
            [_call(platform, "")],
            "answered",
            "ok",
            5,
        )

    started = time.monotonic()
    _poll_once(prod_db, fetch, deadline_seconds=40)
    elapsed = time.monotonic() - started
    view = prod_db.view(search_id)
    sources = {row["platform"]: row for row in view["sources"]}
    assert sources["youtube"]["state"] == "unavailable", view
    assert sources["youtube"]["safe_detail"] == "deadline", view
    assert len(calls) == 8, calls
    assert view["ledger"] == len(calls), view
    ledger_platforms = prod_db.admin.execute(
        "select platform, count(*) as n from search_credit_ledger where search_id = %s group by platform",
        (search_id,),
    ).fetchall()
    assert {row["platform"]: row["n"] for row in ledger_platforms}["youtube"] == 1
    finished_after = prod_db.admin.execute(
        "select extract(epoch from finished_at - created_at) as s from instant_searches where id = %s",
        (search_id,),
    ).fetchone()["s"]
    assert finished_after is not None and float(finished_after) < 2.5, finished_after
    assert elapsed < 5.0, elapsed

    again = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=fetch,
        settings=dict(DEFAULT_SETTINGS),
    )
    assert again == 0
    assert len(calls) == 8


def test_queued_search_past_its_deadline_is_ended_without_a_fetch(prod_db):
    prod_db.admin.execute("delete from instant_searches")
    search_id = _queue_search(prod_db, "barayam", deadline_seconds=-1)
    calls: list[str] = []

    def fetch(platform, keyword, settings, **kwargs):
        calls.append(platform)
        raise AssertionError("must not fetch a search past its deadline")

    _poll_once(prod_db, fetch)
    assert calls == []
    view = prod_db.view(search_id)
    assert view["search"]["status"] in ("failed", "partial"), view
    assert not [row for row in view["sources"] if row["state"] in ("queued", "searching")], view
    for row in view["sources"]:
        assert (row["state"], row["safe_detail"]) == ("unavailable", "deadline"), view
