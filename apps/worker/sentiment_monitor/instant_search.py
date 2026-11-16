"""Instant search store: queue claim, progress, results, credits, retention."""

from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping
import re
import time
import uuid

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import (
    CanonicalComment,
    CanonicalPost,
    RouteCall,
    dedupe_posts,
    detect_language,
    filter_since,
    keyword_relevance,
    post_identity,
    sort_posts,
)
from sentiment_monitor.providers.capabilities import ProviderSetting, resolve_chain
from sentiment_monitor.providers.fetch import fetch_platform
from sentiment_monitor.providers.settings import load_provider_settings

ROUTE_TIMEOUT_SECONDS = 20
SEARCH_DEADLINE_SECONDS = 40
MAX_CONCURRENCY = 6
RUNNING_DEADLINE_GRACE_SECONDS = 60

CLAIM_SQL = """
select id, customer_id, query_text, keyword_intent, date_window, sort_mode,
       language_filter, deadline_at
from instant_searches
where status = 'queued' and deadline_at > now()
order by created_at asc, id asc
limit 1
for update skip locked
"""

SAFE_DETAILS = frozenset(
    {
        "ok",
        "queued",
        "deadline",
        "missing_key",
        "missing_url",
        "unsupported_provider",
        "unsupported_platform",
        "not_found",
        "http_429",
        "http_5xx",
        "timeout",
        "transport_error",
        "failed_status",
        "malformed_json",
        "malformed_envelope",
        "success_false",
        "storage_failed",
        "unknown_error",
        "other",
    }
)

_ROUTE_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")
_HTTP_STATUS_PATTERN = re.compile(r"http_[0-9]{3}")


def _row_value(row: Any, key: str, index: int) -> Any:
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[index]
    except (TypeError, KeyError, IndexError):
        return getattr(row, key, None)


def _safe_detail(value: Any) -> str:
    if isinstance(value, str) and (value in SAFE_DETAILS or _HTTP_STATUS_PATTERN.fullmatch(value)):
        return value
    return "other"


def _safe_route(value: Any) -> str:
    if isinstance(value, str) and _ROUTE_PATTERN.fullmatch(value):
        return value
    return "other"


@dataclass(frozen=True)
class InstantSearchJob:
    id: str
    customer_id: str
    query: str
    intent: str = "phrase"
    date_window: str = "all"
    sort_mode: str = "relevance"
    language_filter: str = "all"
    deadline_at: Any = None


def _job_from_row(row: Any) -> InstantSearchJob | None:
    job_id = _row_value(row, "id", 0)
    customer_id = _row_value(row, "customer_id", 1)
    query = _row_value(row, "query_text", 2)
    if job_id is None or customer_id is None or not isinstance(query, str) or not query:
        return None
    return InstantSearchJob(
        id=str(job_id),
        customer_id=str(customer_id),
        query=query,
        intent=_row_value(row, "keyword_intent", 3) or "phrase",
        date_window=_row_value(row, "date_window", 4) or "all",
        sort_mode=_row_value(row, "sort_mode", 5) or "relevance",
        language_filter=_row_value(row, "language_filter", 6) or "all",
        deadline_at=_row_value(row, "deadline_at", 7),
    )


def _set_customer(conn: Any, customer_id: str) -> None:
    conn.execute("select set_config('app.customer_id', %s, true)", (customer_id,))


def search_status(states: Iterable[str]) -> str:
    values = list(states)
    answered = sum(1 for state in values if state == "answered")
    if values and answered == len(values):
        return "succeeded"
    if answered:
        return "partial"
    return "failed"


def claim_instant_search(conn: Any, worker_id: str) -> InstantSearchJob | None:
    del worker_id
    rows = conn.execute(CLAIM_SQL) or []
    if not rows:
        return None
    job = _job_from_row(rows[0])
    if job is None:
        return None
    _set_customer(conn, job.customer_id)
    conn.execute(
        "update instant_searches set status = 'running', started_at = coalesce(started_at, now()) "
        "where id = %s and status = 'queued'",
        (job.id,),
    )
    return job


def start_search(conn: Any, job: InstantSearchJob) -> None:
    _set_customer(conn, job.customer_id)
    conn.execute(
        "update instant_searches set status = 'running', started_at = coalesce(started_at, now()) "
        "where id = %s and status in ('queued', 'running')",
        (job.id,),
    )


def set_source_state(
    conn: Any,
    job: InstantSearchJob,
    platform: str,
    state: str,
    **fields: Any,
) -> None:
    _set_customer(conn, job.customer_id)
    conn.execute(
        """
        insert into instant_search_sources
          (search_id, customer_id, platform, provider, state, result_count,
           latency_ms, credits_charged, attempted_providers, safe_detail, updated_at)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
        on conflict (search_id, platform) do update set
          provider = excluded.provider,
          state = excluded.state,
          result_count = excluded.result_count,
          latency_ms = excluded.latency_ms,
          credits_charged = excluded.credits_charged,
          attempted_providers = excluded.attempted_providers,
          safe_detail = excluded.safe_detail,
          updated_at = now()
        """,
        (
            job.id,
            job.customer_id,
            platform,
            fields.get("provider") or "off",
            state,
            int(fields.get("result_count") or 0),
            fields.get("latency_ms"),
            fields.get("credits_charged"),
            list(fields.get("attempted_providers") or ()),
            _safe_detail(fields.get("safe_detail", "queued")),
        ),
    )


def insert_posts(conn: Any, job: InstantSearchJob, posts: Iterable[CanonicalPost]) -> int:
    _set_customer(conn, job.customer_id)
    inserted = 0
    for item in posts:
        identity = post_identity(item)
        if identity is None:
            continue
        cursor = conn.execute(
            """
            insert into instant_search_results
              (id, search_id, customer_id, platform, external_id, author_name,
               author_handle, url, text, title, published_at, thumbnail_url, views,
               likes, replies, shares, language, relevance, web_index,
               source_provider, routes, raw_ref, collected_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (search_id, platform, external_id) do nothing
            """,
            (
                str(uuid.uuid4()),
                job.id,
                job.customer_id,
                item.platform,
                identity[1],
                item.author_name,
                item.author_handle,
                item.url,
                item.text,
                item.title,
                item.published_at,
                item.thumbnail_url,
                item.views,
                item.likes,
                item.replies,
                item.shares,
                item.language,
                item.relevance,
                item.web_index,
                item.source_provider,
                list(item.routes),
                item.raw_ref,
                item.collected_at,
            ),
        )
        inserted += int(getattr(cursor, "rowcount", 0) or 0)
    return inserted


def insert_comments(
    conn: Any,
    job: InstantSearchJob,
    result_id: str,
    comments: Iterable[CanonicalComment],
) -> int:
    _set_customer(conn, job.customer_id)
    inserted = 0
    for item in comments:
        cursor = conn.execute(
            """
            insert into instant_search_comments
              (id, search_id, customer_id, result_id, platform, external_id,
               author_name, author_handle, text, published_at, likes, replies,
               source_provider, raw_ref, collected_at)
            select %s, %s, %s, %s, platform, %s, %s, %s, %s, %s, %s, %s, %s, %s, now()
            from instant_search_results where id = %s
            on conflict (search_id, result_id, external_id) do nothing
            """,
            (
                str(uuid.uuid4()),
                job.id,
                job.customer_id,
                result_id,
                item.external_id,
                item.author_name,
                item.author_handle,
                item.text,
                item.published_at,
                item.likes,
                item.replies,
                item.source_provider,
                item.raw_ref,
                result_id,
            ),
        )
        inserted += int(getattr(cursor, "rowcount", 0) or 0)
    return inserted


def record_call(conn: Any, job: InstantSearchJob, call: RouteCall) -> None:
    _set_customer(conn, job.customer_id)
    latency = call.latency_ms if type(call.latency_ms) is int else 0
    conn.execute(
        """
        insert into search_credit_ledger
          (id, search_id, customer_id, provider, platform, route, credits_charged,
           http_status, safe_detail, body_length, latency_ms)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            str(uuid.uuid4()),
            job.id,
            job.customer_id,
            str(call.provider),
            str(call.platform),
            _safe_route(call.route),
            call.credits_charged if type(call.credits_charged) is int else None,
            call.http_status if type(call.http_status) is int else None,
            _safe_detail(call.safe_detail),
            call.body_length if type(call.body_length) is int else None,
            latency,
        ),
    )


def credit_total(conn: Any, search_id: str) -> int:
    rows = conn.execute(
        "select coalesce(sum(credits_charged), 0) as total from search_credit_ledger where search_id = %s",
        (search_id,),
    ) or []
    if not rows:
        return 0
    value = _row_value(rows[0], "total", 0)
    return int(value or 0)


def finish_search(
    conn: Any,
    job: InstantSearchJob,
    status: str,
    *,
    error_code: str | None = None,
) -> str:
    _set_customer(conn, job.customer_id)
    rows = conn.execute(
        "select state from instant_search_sources where search_id = %s",
        (job.id,),
    ) or []
    computed = search_status(
        [_row_value(row, "state", 0) for row in rows]
    ) if rows else status
    credits = credit_total(conn, job.id)
    conn.execute(
        "update instant_searches set status = %s, finished_at = now(), "
        "credits_used = %s, error_code = %s where id = %s",
        (computed, credits, error_code, job.id),
    )
    return computed


def expire_old_searches(conn: Any, now: Any) -> int:
    cursor = conn.execute(
        "delete from instant_searches where retention_expires_at <= %s",
        (now,),
    )
    return int(getattr(cursor, "rowcount", 0) or 0)


_PLATFORM_ORDER = (
    "threads",
    "tiktok",
    "instagram",
    "youtube",
    "reddit",
    "facebook",
    "linkedin",
)

_DATE_WINDOW_DAYS = {"24h": 1, "7d": 7, "30d": 30, "12m": 365}


def _cutoff(now: datetime, date_window: str) -> str | None:
    days = _DATE_WINDOW_DAYS.get(date_window)
    if days is None:
        return None
    return (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _enabled_platforms(settings: Mapping[str, ProviderSetting]) -> list[tuple[str, tuple[str, ...]]]:
    enabled: list[tuple[str, tuple[str, ...]]] = []
    for platform in _PLATFORM_ORDER:
        chain = resolve_chain(platform, settings)
        if chain:
            enabled.append((platform, chain))
    return enabled


def _normalize(post: CanonicalPost, job: InstantSearchJob) -> CanonicalPost:
    text = post.text or ""
    return replace(
        post,
        language=detect_language(text),
        relevance=keyword_relevance(post, job.query, job.intent),
    )


def _known_credit_sum(calls: Iterable[RouteCall]) -> int | None:
    known = [call.credits_charged for call in calls if type(call.credits_charged) is int]
    if not known:
        return None
    return sum(known)


def _fetch_one(
    fetcher: Any,
    platform: str,
    keyword: Keyword,
    settings: Mapping[str, ProviderSetting],
    *,
    env: Mapping[str, Any],
    collected_at: str,
    date_window_days: int | None,
) -> Any:
    return fetcher(
        platform,
        keyword,
        settings,
        env=env,
        collected_at=collected_at,
        date_window_days=date_window_days,
        timeout=ROUTE_TIMEOUT_SECONDS,
    )


def _apply_ranks(conn: Any, job: InstantSearchJob, ordered: list[CanonicalPost]) -> None:
    _set_customer(conn, job.customer_id)
    for rank, item in enumerate(ordered, start=1):
        identity = post_identity(item)
        if identity is None:
            continue
        conn.execute(
            "update instant_search_results set rank = %s "
            "where search_id = %s and platform = %s and external_id = %s",
            (rank, job.id, item.platform, identity[1]),
        )


def _failed_state(conn: Any, job: InstantSearchJob, platform: str, chain: tuple[str, ...]) -> None:
    set_source_state(
        conn,
        job,
        platform,
        "failed",
        provider=chain[0],
        attempted_providers=chain,
        safe_detail="other",
    )


def _handle_result(
    conn: Any,
    job: InstantSearchJob,
    platform: str,
    chain: tuple[str, ...],
    result: Any,
    cutoff_iso: str | None,
    all_posts: list[CanonicalPost],
) -> None:
    calls = list(getattr(result, "calls", None) or [])
    for call in calls:
        record_call(conn, job, call)
    state = getattr(result, "state", "unavailable")
    detail = getattr(result, "safe_detail", "other")
    attempted = tuple(getattr(result, "attempted_providers", None) or chain)
    if state == "answered":
        kept = [_normalize(item, job) for item in filter_since(result.posts or [], cutoff_iso)]
        kept = dedupe_posts(kept)
        inserted = insert_posts(conn, job, kept)
        set_source_state(
            conn,
            job,
            platform,
            "answered",
            provider=chain[0],
            result_count=inserted,
            latency_ms=getattr(result, "latency_ms", None),
            credits_charged=_known_credit_sum(calls),
            attempted_providers=attempted,
            safe_detail=detail,
        )
        all_posts.extend(kept)
        return
    if state == "unavailable":
        set_source_state(
            conn,
            job,
            platform,
            "unavailable",
            provider=chain[0],
            latency_ms=getattr(result, "latency_ms", None),
            credits_charged=_known_credit_sum(calls),
            attempted_providers=attempted,
            safe_detail=detail,
        )
        return
    set_source_state(
        conn,
        job,
        platform,
        "failed",
        provider=chain[0],
        latency_ms=getattr(result, "latency_ms", None),
        credits_charged=_known_credit_sum(calls),
        attempted_providers=attempted,
        safe_detail=detail,
    )


def run_instant_search(
    conn: Any,
    job: InstantSearchJob,
    *,
    env: Mapping[str, Any],
    now: datetime,
    settings: Mapping[str, ProviderSetting] | None = None,
    fetcher: Any = fetch_platform,
    comment_fetcher: Any = None,
    clock: Any = time.monotonic,
    deadline_seconds: float = SEARCH_DEADLINE_SECONDS,
) -> None:
    del comment_fetcher
    if settings is None:
        settings = load_provider_settings(conn)
    start_search(conn, job)
    now = now.astimezone(timezone.utc)
    collected_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff_iso = _cutoff(now, job.date_window)
    date_window_days = _DATE_WINDOW_DAYS.get(job.date_window)
    sources = _enabled_platforms(settings)
    for platform, chain in sources:
        set_source_state(
            conn, job, platform, "queued", provider=chain[0], attempted_providers=chain
        )

    executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)
    futures: dict[Any, tuple[str, tuple[str, ...]]] = {}
    all_posts: list[CanonicalPost] = []
    pending: set[Any] = set()
    try:
        for platform, chain in sources:
            future = executor.submit(
                _fetch_one,
                fetcher,
                platform,
                Keyword(job.query, job.intent),
                settings,
                env=env,
                collected_at=collected_at,
                date_window_days=date_window_days,
            )
            futures[future] = (platform, chain)
        pending = set(futures)
        deadline = clock() + deadline_seconds
        while pending:
            remaining = deadline - clock()
            if remaining <= 0:
                break
            done, pending = wait(pending, timeout=remaining, return_when=FIRST_COMPLETED)
            if not done:
                break
            for future in done:
                platform, chain = futures[future]
                try:
                    result = future.result()
                except Exception:
                    _failed_state(conn, job, platform, chain)
                    continue
                _handle_result(conn, job, platform, chain, result, cutoff_iso, all_posts)
        for future in pending:
            platform, chain = futures[future]
            future.cancel()
            set_source_state(
                conn,
                job,
                platform,
                "unavailable",
                provider=chain[0],
                attempted_providers=chain,
                safe_detail="deadline",
            )
    finally:
        # cancel() cannot stop a task that already started, so bound the wait
        # for started route threads by the per-route timeout before tearing the
        # executor down. Late results are discarded: only futures observed in
        # the loop above contribute to all_posts.
        for future in pending:
            future.cancel()
        if pending:
            wait(pending, timeout=ROUTE_TIMEOUT_SECONDS)
        executor.shutdown(wait=True, cancel_futures=True)

    ranked = sort_posts(dedupe_posts(all_posts), job.sort_mode)
    _apply_ranks(conn, job, ranked)
    finish_search(conn, job, "failed")


FAIL_DEADLINE_SQL = """
with expired as (
    update instant_searches
       set (status, error_code, finished_at) =
           ('failed', 'deadline', coalesce(finished_at, %s))
     where (status = 'queued' and deadline_at <= %s)
        or (status = 'running' and deadline_at <= %s - interval '60 seconds')
    returning id
)
update instant_search_sources
   set state = 'unavailable',
       safe_detail = 'deadline',
       updated_at = %s
 where state in ('queued', 'searching')
   and search_id in (select id from expired)
"""


def _fail_deadline_missed_searches(conn: Any, now: datetime) -> None:
    # A queued search past its deadline can never be claimed, and a running
    # search that missed its deadline by more than the grace window was left by
    # a crashed runner. Both are finished as failed before the claim loop so the
    # UI stops polling them forever. The 60 s grace avoids racing an in-flight
    # runner that is still shutting its route threads down.
    conn.execute(FAIL_DEADLINE_SQL, (now, now, now, now))


def run_instant_search_cycle(
    conn: Any,
    *,
    env: Mapping[str, Any],
    now: datetime,
    limits: Any,
) -> int:
    del limits
    processed = 0
    seen: set[str] = set()
    try:
        _fail_deadline_missed_searches(conn, now)
        while processed < 2:
            job = claim_instant_search(conn, "instant-search-worker")
            if job is None:
                break
            if job.id in seen:
                break
            seen.add(job.id)
            run_instant_search(conn, job, env=env, now=now)
            processed += 1
    finally:
        expire_old_searches(conn, now)
    return processed
