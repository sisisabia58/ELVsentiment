"""Fetch and merge one retained ScrapeAtlas continuation into its Cari search."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from hashlib import sha256
import json
from typing import Any, Mapping

from sentiment_monitor.instant_search import (
    RELEVANCE_VERSION,
    InstantSearchJob,
    ROUTE_TIMEOUT_SECONDS,
    _DATE_WINDOW_DAYS,
    _Transactions,
    _cutoff,
    _iso_db,
    _job_from_row,
    _matching_posts,
    _row_value,
    _safe_detail,
    cari_more_enabled,
    credit_total,
    insert_posts,
    record_call,
)
from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import CanonicalPost, PlatformFetch, RouteCall
from sentiment_monitor.providers.fetch import fetch_platform, supports_continuation_route
from sentiment_monitor.providers.scrapeatlas_sources import continuation_values
from sentiment_monitor.providers.settings import load_provider_settings

MAX_GENERATION = 3


@dataclass(frozen=True)
class MoreJob:
    id: str
    search: InstantSearchJob
    platform: str
    generation: int
    route: str
    cursor: str = field(repr=False)
    companion: str | None = field(repr=False)
    anchor: datetime
    dispatch_expires_at: datetime


def _cursor_hash(route: str, cursor: str, companion: str | None) -> str:
    return sha256(json.dumps([route, cursor, companion], ensure_ascii=False).encode("utf-8")).hexdigest()


def _expire(conn: Any) -> None:
    # A running job may already have spent provider credits. Expire it
    # without reclaiming its cursor or redispatching that generation.
    conn.execute(
        """
        update instant_search_more_jobs j
        set status = 'failed', safe_detail = 'deadline', finished_at = now()
        from instant_search_continuations c
        where c.search_id = j.search_id and c.platform = j.platform
          and j.status in ('queued','running')
          and (j.created_at <= now() - interval '45 seconds' or c.expires_at <= now())
        """
    )
    conn.execute(
        """
        update instant_search_continuations set cursor = null, companion = null
        where available and expires_at <= now()
        """
    )


def _claim(conn: Any) -> MoreJob | None:
    rows = conn.execute(
        """
        select s.id, s.customer_id, s.query_text, s.keyword_intent, s.date_window, s.sort_mode,
               s.language_filter, s.deadline_at, j.id as page_id, j.platform, j.generation,
               c.route, c.cursor, c.companion, c.collected_at,
               least(c.expires_at, j.created_at + interval '45 seconds') as dispatch_expires_at
        from instant_search_more_jobs j
        join instant_searches s on s.id = j.search_id and s.customer_id = j.customer_id
        join instant_search_continuations c on c.search_id = j.search_id and c.platform = j.platform
                                           and c.customer_id = j.customer_id
        join instant_search_sources p on p.search_id = j.search_id and p.platform = j.platform
                                      and p.customer_id = j.customer_id
        where j.status = 'queued' and c.generation = j.generation and c.available and c.expires_at > now()
          and s.retention_expires_at > now() and s.finished_at is not null and s.status in ('succeeded','partial')
          and s.relevance_version = %s
          and p.provider = 'scrapeatlas' and p.state = 'answered'
        order by j.created_at, j.id
        limit 1 for update of j skip locked
        """,
        (RELEVANCE_VERSION,),
    ) or []
    if not rows:
        return None
    row = rows[0]
    search = _job_from_row(row)
    if search is None:
        return None
    job = MoreJob(
        id=str(_row_value(row, "page_id", 8)), search=search,
        platform=_row_value(row, "platform", 9), generation=_row_value(row, "generation", 10),
        route=_row_value(row, "route", 11), cursor=_row_value(row, "cursor", 12),
        companion=_row_value(row, "companion", 13), anchor=_row_value(row, "collected_at", 14),
        dispatch_expires_at=_row_value(row, "dispatch_expires_at", 15),
    )
    cursor, _ = continuation_values(job.platform, job.cursor, job.companion)
    keyword = Keyword(job.search.query, job.search.intent)
    if cursor is None or not supports_continuation_route(job.platform, keyword, job.route):
        conn.execute(
            """
            update instant_search_more_jobs
            set status = 'failed', safe_detail = 'unsupported_provider', finished_at = now()
            where id = %s
            """,
            (job.id,),
        )
        return None
    conn.execute(
        """
        update instant_search_more_jobs
        set status = 'running', started_at = now(), cursor_hash = %s
        where id = %s
        """,
        (_cursor_hash(job.route, job.cursor, job.companion), job.id),
    )
    return job


def _refresh_ranks(conn: Any, job: MoreJob) -> None:
    # Matches sort_posts: undated rows last, then the saved sort mode, then
    # canonical identity as a stable tie-breaker. Use numeric for engagement
    # because normalized counts individually fit bigint but their sum may not.
    conn.execute(
        """
        with settings as (select %s::text as sort_mode), ranked as (
          select id, row_number() over (
            order by (published_at is null),
              case when sort_mode = 'newest' then published_at end desc nulls last,
              case when published_at is not null and sort_mode = 'relevance'
                then case relevance when 'literal_match' then 0 when 'all_words_match' then 1 else 2 end
              end,
              case when published_at is not null and sort_mode in ('relevance','popular')
                then coalesce(views,0)::numeric + coalesce(likes,0)::numeric * 3
                    + coalesce(replies,0)::numeric * 2 + coalesce(shares,0)::numeric * 2
              end desc nulls last,
              external_id collate "C", platform
          ) as new_rank
          from instant_search_results cross join settings
          where search_id = %s and customer_id = %s
        )
        update instant_search_results r set rank = ranked.new_rank
        from ranked where r.id = ranked.id and r.rank is distinct from ranked.new_rank
        """,
        (job.search.sort_mode, job.search.id, job.search.customer_id),
    )


def _fail(conn: Any, job: MoreJob, detail: str) -> None:
    conn.execute(
        """
        update instant_search_more_jobs
        set status = 'failed', finished_at = now(), safe_detail = %s
        where id = %s and status = 'running'
        """,
        (_safe_detail(detail), job.id),
    )


def _settle(conn: Any, job: MoreJob, result: PlatformFetch | None, posts: list[CanonicalPost]) -> None:
    # Serialize merges from different platforms for this search. Each merge
    # ranks the complete set, preserving existing row IDs and AI evidence.
    retained = conn.execute(
        """
        select id from instant_searches
        where id = %s and customer_id = %s and retention_expires_at > clock_timestamp()
        for no key update
        """,
        (job.search.id, job.search.customer_id),
    )
    if not retained:
        _fail(conn, job, "deadline")
        return
    conn.execute(
        "update instant_searches set credits_used = %s where id = %s",
        (credit_total(conn, job.search.id), job.search.id),
    )
    active = conn.execute(
        """
        with locked as materialized (
          select least(c.expires_at, j.created_at + interval '45 seconds') as deadline
          from instant_search_more_jobs j
          join instant_search_continuations c on c.search_id = j.search_id and c.platform = j.platform
          where j.id = %s and j.status = 'running' and c.generation = j.generation
          for update of j
        )
        select 1 from locked where deadline > clock_timestamp()
        """,
        (job.id,),
    )
    if not active:
        _fail(conn, job, "deadline")
        return
    if result is None or result.state != "answered":
        _fail(conn, job, result.safe_detail if result is not None else "unknown_error")
        return

    added = insert_posts(conn, job.search, posts)
    if added:
        _refresh_ranks(conn, job)
        conn.execute(
            """
            update instant_search_sources set result_count = result_count + %s, updated_at = now()
            where search_id = %s and platform = %s and customer_id = %s
            """,
            (added, job.search.id, job.platform, job.search.customer_id),
        )
    cursor, companion = continuation_values(job.platform, result.next_cursor, result.next_companion)
    if cursor and job.generation + 1 < MAX_GENERATION:
        repeated = conn.execute(
            """
            select 1 from instant_search_more_jobs
            where search_id = %s and platform = %s and cursor_hash = %s
            limit 1
            """,
            (job.search.id, job.platform, _cursor_hash(job.route, cursor, companion)),
        )
        if repeated:
            cursor = None
    else:
        cursor = None
    conn.execute(
        """
        update instant_search_continuations
        set cursor = %s, companion = %s, generation = generation + 1
        where search_id = %s and customer_id = %s and platform = %s
        """,
        (cursor, companion if cursor else None, job.search.id, job.search.customer_id, job.platform),
    )
    conn.execute(
        """
        update instant_search_more_jobs set status = 'succeeded', new_result_count = %s,
          finished_at = now(), safe_detail = %s
        where id = %s
        """,
        (added, _safe_detail(result.safe_detail), job.id),
    )


def _run(
    tx: _Transactions, job: MoreJob, env: Mapping[str, Any], fetcher: Any,
) -> None:
    if not cari_more_enabled(env, job.platform):
        tx.run(lambda conn: _fail(conn, job, "unsupported_provider"))
        return
    try:
        settings = tx.run(load_provider_settings)
    except Exception:
        tx.run(lambda conn: _fail(conn, job, "config_error"))
        return
    dispatch = datetime.now(timezone.utc)
    seconds_left = int((job.dispatch_expires_at - dispatch).total_seconds())
    if seconds_left < 1:
        tx.run(lambda conn: _fail(conn, job, "deadline"))
        return
    collected_at = dispatch.strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        result = fetcher(
            job.platform, Keyword(job.search.query, job.search.intent), settings,
            env=env, collected_at=_iso_db(job.anchor),
            date_window_days=_DATE_WINDOW_DAYS.get(job.search.date_window),
            timeout=min(ROUTE_TIMEOUT_SECONDS, seconds_left),
            continuation_route=job.route, cursor=job.cursor, companion=job.companion,
        )
        call, = result.calls if len(result.calls) == 1 else (None,)
        if call is not None and (call.provider, call.platform, call.route) != ("scrapeatlas", job.platform, job.route):
            raise ValueError("unexpected provider route")
        if result.state == "answered" and (call is None or call.outcome not in ("success", "partial")):
            raise ValueError("missing provider receipt")
    except Exception:
        # The request may have been dispatched. Record unknown usage and do
        # not replay it, even if the provider never returned a receipt.
        result = None
        call = RouteCall("scrapeatlas", job.platform, job.route, "failed", safe_detail="unknown_error")

    try:
        if call is not None:
            def persist_receipt(conn):
                record_call(conn, job.search, call, more_job_id=job.id)

            try:
                tx.run(persist_receipt)
            except Exception:
                # A commit may have succeeded before the client lost its
                # connection. The job ID makes this ledger-only retry safe.
                tx.run(persist_receipt)
        stored = []
        if result is not None and result.state == "answered":
            cutoff = _cutoff(job.anchor, job.search.date_window)
            stored = [
                replace(post, collected_at=collected_at)
                for post in _matching_posts(result.posts, job.search, cutoff, job.platform)
            ]
        tx.run(lambda conn: _settle(conn, job, result, stored))
    except Exception:
        # The receipt has its own transaction and survives a bad result merge.
        tx.run(lambda conn: _fail(conn, job, "storage_failed"))


def run_instant_search_more_poll(
    connect: Any, *, env: Mapping[str, Any], fetcher: Any = fetch_platform,
    submit: Any = None, claim: bool = True,
) -> Any:
    """Claim one page. Production may submit the remote work to a bounded pool."""
    if not cari_more_enabled(env):
        return None
    tx = _Transactions(connect)
    with tx.begin() as conn:
        _expire(conn)
        job = _claim(conn) if claim else None
    if job is None:
        return None
    if submit is not None:
        return submit(_run, tx, job, env, fetcher)
    _run(tx, job, env, fetcher)
    return job.id
