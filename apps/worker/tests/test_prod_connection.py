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
