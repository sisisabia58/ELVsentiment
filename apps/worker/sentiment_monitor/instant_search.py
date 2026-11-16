"""Instant search store: queue claim, progress, results, credits, retention."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable
import re
import uuid

from sentiment_monitor.providers.canonical import (
    CanonicalComment,
    CanonicalPost,
    RouteCall,
    post_identity,
)

ROUTE_TIMEOUT_SECONDS = 20
SEARCH_DEADLINE_SECONDS = 40
MAX_CONCURRENCY = 6

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
