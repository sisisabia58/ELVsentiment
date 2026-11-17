"""Instant search store: queue claim, progress, results, credits, retention."""

from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping
import logging
import os
import re
import time
import uuid

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import (
    MAX_EXTERNAL_ID_LENGTH,
    CanonicalComment,
    CanonicalPost,
    RouteCall,
    dedupe_posts,
    detect_language,
    filter_since,
    keyword_relevance,
    post_identity,
    safe_credit,
    sanitize_comment,
    sanitize_post,
    sort_posts,
)
from sentiment_monitor.providers.capabilities import ProviderSetting, resolve_chain
from sentiment_monitor.providers.comments import fetch_comments
from sentiment_monitor.providers.fetch import fetch_platform
from sentiment_monitor.providers.fixtures import fixture_comment_fetch
from sentiment_monitor.providers.settings import load_provider_settings

ROUTE_TIMEOUT_SECONDS = 20
SEARCH_DEADLINE_SECONDS = 40
# Launching a paid route with less budget than this only pays for a result we
# will immediately mark unavailable. Leave the whole wave unlaunched instead.
MIN_LAUNCH_SECONDS = 8.0
# One comment page for each of the top posts on the six comment-capable platforms.
TOP_POSTS_FOR_COMMENTS = 3
MAX_COMMENT_CALLS = TOP_POSTS_FOR_COMMENTS * 6
# A comment call that cannot finish inside the comment budget is not started.
MIN_COMMENT_SECONDS = 1.0
# Sources may use the search deadline. Comments get this extra slice afterwards
# so one slow source cannot starve every other platform's replies.
COMMENT_BUDGET_SECONDS = 12.0
# Seven launch platforms: one search's routes must fit in a single wave.
MAX_CONCURRENCY = 7
MAX_INFLIGHT = 8
RUNNING_DEADLINE_GRACE_SECONDS = 60
MAX_PLATFORM_RESULTS = 100

_log = logging.getLogger("sentiment_monitor.instant_search")
_LOG_TOKEN = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")


def _info(search_id: str, **fields: object) -> None:
    """One safe line. Values that are not short tokens are dropped."""
    parts = [f"search={search_id}"]
    for key, value in fields.items():
        if not isinstance(key, str) or not _LOG_TOKEN.fullmatch(key):
            continue
        text = str(value)
        if not _LOG_TOKEN.fullmatch(text):
            continue
        parts.append(f"{key}={text}")
    _log.info(" ".join(parts))

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
        "http_3xx",
        "http_429",
        "http_5xx",
        "timeout",
        "transport_error",
        "failed_status",
        "malformed_json",
        "malformed_envelope",
        "body_too_large",
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


class _Transactions:
    """Run each unit of work in its own short transaction.

    The production worker passes a ``connect`` factory; older unit tests pass
    one live connection. Both shapes are supported so the store stays usable
    from scripts and tests without weakening the production commit boundaries.
    """

    def __init__(self, connect: Any) -> None:
        self.connect = connect
        self.factory = callable(connect)
        self.shared = None if self.factory else connect

    @contextmanager
    def begin(self):
        if not self.factory:
            yield self.shared
            commit = getattr(self.shared, "commit", None)
            if callable(commit):
                commit()
            return
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def run(self, fn: Any) -> Any:
        with self.begin() as conn:
            return fn(conn)


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


def _insert_post_row(
    conn: Any,
    job: InstantSearchJob,
    item: CanonicalPost,
    identity: tuple[str, str],
) -> Any:
    return conn.execute(
        """
        insert into instant_search_results
          (id, search_id, customer_id, platform, external_id, author_name,
           author_handle, url, text, title, published_at, thumbnail_url, views,
           likes, replies, shares, language, relevance, web_index,
           source_provider, routes, raw_ref, collected_at)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s)
        on conflict (search_id, platform, external_id) do nothing
        returning id
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


def insert_posts(conn: Any, job: InstantSearchJob, posts: Iterable[CanonicalPost]) -> int:
    _set_customer(conn, job.customer_id)
    inserted = 0
    for item in posts:
        item = sanitize_post(item)
        identity = post_identity(item)
        if identity is None:
            continue
        # An oversized identity is not truncated: truncating would silently
        # merge two different posts. Drop that record and keep its siblings.
        if len(identity[1]) > MAX_EXTERNAL_ID_LENGTH:
            continue
        try:
            conn.execute("savepoint result_row")
        except Exception:
            # Older/simple test connections may not expose savepoints.
            cursor = _insert_post_row(conn, job, item, identity)
            inserted += len(cursor or ())
            continue
        try:
            cursor = _insert_post_row(conn, job, item, identity)
        except Exception:
            conn.execute("rollback to savepoint result_row")
            continue
        conn.execute("release savepoint result_row")
        inserted += len(cursor or ())
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
        item = sanitize_comment(item)
        cursor = conn.execute(
            """
            insert into instant_search_comments
              (id, search_id, customer_id, result_id, platform, external_id,
               author_name, author_handle, text, published_at, likes, replies,
               source_provider, raw_ref, collected_at)
            select %s, %s, %s, %s, platform, %s, %s, %s, %s, %s, %s, %s, %s, %s, now()
            from instant_search_results where id = %s
            on conflict (search_id, result_id, external_id) do nothing
            returning id
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
        inserted += len(cursor or ())
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
            safe_credit(call.credits_charged),
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
    rows = conn.execute(
        "delete from instant_searches where retention_expires_at <= %s returning id",
        (now,),
    )
    return len(rows or ())


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
    post = sanitize_post(post)
    text = post.text or ""
    return replace(
        post,
        language=detect_language(text),
        relevance=keyword_relevance(post, job.query, job.intent),
    )


def _known_credit_sum(calls: Iterable[RouteCall]) -> int | None:
    known = [value for call in calls if (value := safe_credit(call.credits_charged)) is not None]
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


def _store_answered(
    conn: Any,
    job: InstantSearchJob,
    platform: str,
    chain: tuple[str, ...],
    kept: list[CanonicalPost],
    result: Any,
    calls: list[RouteCall],
    detail: str,
    attempted: tuple[str, ...],
) -> int:
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
    return inserted


def _mark_source_failed(
    tx: _Transactions,
    job: InstantSearchJob,
    platform: str,
    chain: tuple[str, ...],
    *,
    latency: Any = None,
    credits: int | None = None,
    attempted: tuple[str, ...] | None = None,
) -> None:
    try:
        tx.run(
            lambda conn: set_source_state(
                conn,
                job,
                platform,
                "failed",
                provider=chain[0],
                latency_ms=latency,
                credits_charged=credits,
                attempted_providers=attempted or chain,
                safe_detail="storage_failed",
            )
        )
    except Exception:
        # The isolation path must not raise again and abort the other sources.
        pass


def _handle_result(
    tx: _Transactions,
    job: InstantSearchJob,
    platform: str,
    chain: tuple[str, ...],
    result: Any,
    cutoff_iso: str | None,
    all_posts: list[CanonicalPost],
) -> None:
    calls = list(getattr(result, "calls", None) or [])
    # Paid calls are durable before any post is stored, so a later normalisation
    # or storage error can never lose the ledger or cause a paid re-run.
    tx.run(lambda conn: [record_call(conn, job, call) for call in calls])
    state = getattr(result, "state", "unavailable")
    detail = getattr(result, "safe_detail", "other")
    attempted = tuple(getattr(result, "attempted_providers", None) or chain)
    credits = _known_credit_sum(calls)
    latency = getattr(result, "latency_ms", None)
    # Normalisation, filtering, sorting and insertion all stay inside this
    # per-platform guard. One poisoned record or one bad row can only fail its
    # own source; the other platforms keep their results and ledger rows.
    try:
        if state == "answered":
            # Sanitise each record before the cutoff filter, and isolate each
            # record: a poisoned date or normalisation error must drop only
            # that post, never its siblings or the platform's ledger rows.
            kept = []
            for item in result.posts or []:
                try:
                    kept.append(_normalize(item, job))
                except Exception:
                    continue
            kept = filter_since(kept, cutoff_iso)
            kept = sort_posts(dedupe_posts(kept), job.sort_mode)[:MAX_PLATFORM_RESULTS]
            tx.run(
                lambda conn: _store_answered(
                    conn, job, platform, chain, kept, result, calls, detail, attempted
                )
            )
            all_posts.extend(kept)
            return kept
        if state == "unavailable":
            tx.run(
                lambda conn: set_source_state(
                    conn,
                    job,
                    platform,
                    "unavailable",
                    provider=chain[0],
                    latency_ms=latency,
                    credits_charged=credits,
                    attempted_providers=attempted,
                    safe_detail=detail,
                )
            )
            return []
        tx.run(
            lambda conn: set_source_state(
                conn,
                job,
                platform,
                "failed",
                provider=chain[0],
                latency_ms=latency,
                credits_charged=credits,
                attempted_providers=attempted,
                safe_detail=detail,
            )
        )
        return []
    except Exception:
        _mark_source_failed(
            tx,
            job,
            platform,
            chain,
            latency=latency,
            credits=credits,
            attempted=attempted,
        )
    return []


def _set_comment_progress(conn: Any, job: InstantSearchJob, status: str, detail: str | None) -> None:
    _set_customer(conn, job.customer_id)
    conn.execute(
        "update instant_searches set comment_status = %s, comment_detail = %s "
        "where id = %s and customer_id = %s",
        (status, detail, job.id, job.customer_id),
    )


def _comment_result_ids(conn: Any, job: InstantSearchJob, platform: str) -> dict[str, str]:
    rows = conn.execute(
        """
        select id, external_id from instant_search_results
        where search_id = %s and customer_id = %s and platform = %s
        """,
        (job.id, job.customer_id, platform),
    ) or []
    found: dict[str, str] = {}
    for row in rows:
        found[str(_row_value(row, "external_id", 1))] = str(_row_value(row, "id", 0))
    return found


def _remaining_seconds(
    job: InstantSearchJob,
    deadline_seconds: float,
    started: datetime,
) -> float:
    """Use whichever is sooner: the caller's budget or the row's deadline_at."""
    limit = max(0.0, float(deadline_seconds))
    value = job.deadline_at
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        remaining = (value - started).total_seconds()
        if remaining < limit:
            limit = remaining
    return limit


def _record_late_calls(connect: Any, job: InstantSearchJob, future: Any) -> None:
    """Persist a straggler's paid calls after the search already finished.

    The callback runs in the executor thread that completed the future. It uses
    a fresh transaction and never touches the search or source rows, so the
    terminal state the user already saw does not change. If the process exits
    before the straggler returns, its ledger row is lost; that is the one
    accepted gap.
    """
    try:
        result = future.result()
    except Exception:
        return
    calls = list(getattr(result, "calls", None) or [])
    if not calls:
        return
    try:
        _Transactions(connect).run(
            lambda conn: [record_call(conn, job, call) for call in calls]
        )
    except Exception:
        # A late ledger failure must never escape into the worker thread.
        pass


def _iso_db(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)


def _post_for_comments(row: Any) -> CanonicalPost:
    return CanonicalPost(
        platform=str(_row_value(row, "platform", 1)),  # type: ignore[arg-type]
        external_id=str(_row_value(row, "external_id", 2) or ""),
        text=str(_row_value(row, "text", 6) or ""),
        title=_row_value(row, "title", 7),
        author_name=_row_value(row, "author_name", 3),
        author_handle=_row_value(row, "author_handle", 4),
        url=_row_value(row, "url", 5),
        published_at=_iso_db(_row_value(row, "published_at", 8)),
        thumbnail_url=_row_value(row, "thumbnail_url", 9),
        views=_row_value(row, "views", 10),
        likes=_row_value(row, "likes", 11),
        replies=_row_value(row, "replies", 12),
        shares=_row_value(row, "shares", 13),
        top_replies=(),
        hashtags=(),
        source_provider=str(_row_value(row, "source_provider", 14) or "unknown"),
        routes=(),
        raw_ref=str(_row_value(row, "raw_ref", 15) or ""),
        collected_at=_iso_db(_row_value(row, "collected_at", 17)) or "1970-01-01T00:00:00Z",
    )


def _default_comment_fetcher(env: Mapping[str, Any], opener: Any) -> Any:
    mode = env.get("CARI_PROVIDER_MODE") if isinstance(env, Mapping) else None
    if not isinstance(mode, str) or not mode.strip():
        mode = os.environ.get("CARI_PROVIDER_MODE", "live")
    if mode.strip() == "fixture":
        return lambda platform, post, **kwargs: fixture_comment_fetch(platform, post)

    def live(platform: str, post: CanonicalPost, **kwargs: Any) -> Any:
        seconds = kwargs.get("timeout")
        call_kwargs: dict[str, Any] = {
            "settings": kwargs["settings"],
            "env": kwargs.get("env") or env,
            "timeout": seconds if isinstance(seconds, int) else ROUTE_TIMEOUT_SECONDS,
        }
        chosen = kwargs.get("opener") or opener
        if chosen is not None:
            call_kwargs["opener"] = chosen
        return fetch_comments(platform, post, **call_kwargs)

    return live


def _rollback_quiet(conn: Any) -> None:
    rollback = getattr(conn, "rollback", None)
    if callable(rollback):
        try:
            rollback()
        except Exception:
            return


def fetch_top_comments(
    conn: Any,
    job: InstantSearchJob,
    *,
    settings: Mapping[str, ProviderSetting],
    env: Mapping[str, Any],
    opener: Any = None,
    comment_fetcher: Any = None,
    allow_call: Any = None,
    seconds_left: Any = None,
) -> None:
    """Fetch one comment page for the top posts. Never changes the search status."""
    if allow_call is None:
        allow_call = lambda: True
    if not allow_call():
        return
    if comment_fetcher is None:
        comment_fetcher = _default_comment_fetcher(env, opener)
    rows = conn.execute(
        """
        select id, platform, external_id, author_name, author_handle, url, text, title,
               published_at, thumbnail_url, views, likes, replies, shares,
               source_provider, raw_ref, rank, collected_at
        from instant_search_results
        where search_id = %s and customer_id = %s
        order by platform,
                 rank asc nulls last,
                 (coalesce(views, 0) + 3 * coalesce(likes, 0)
                  + 2 * coalesce(replies, 0) + 2 * coalesce(shares, 0)) desc,
                 collected_at desc
        """,
        (job.id, job.customer_id),
    ) or []
    chosen: list[Any] = []
    per_platform: dict[str, int] = {}
    for row in rows:
        platform = str(_row_value(row, "platform", 1))
        if resolve_chain(platform, settings, mode="comments") == ():
            continue
        count = per_platform.get(platform, 0)
        if count >= TOP_POSTS_FOR_COMMENTS:
            continue
        per_platform[platform] = count + 1
        chosen.append(row)
        if len(chosen) >= MAX_COMMENT_CALLS:
            break
    for row in chosen:
        if not allow_call():
            return
        platform = str(_row_value(row, "platform", 1))
        result_id = str(_row_value(row, "id", 0))
        left = seconds_left() if seconds_left is not None else ROUTE_TIMEOUT_SECONDS
        timeout = max(1, min(ROUTE_TIMEOUT_SECONDS, int(left)))
        try:
            fetched = comment_fetcher(
                platform,
                _post_for_comments(row),
                settings=settings,
                env=env,
                opener=opener,
                timeout=timeout,
            )
        except Exception:
            continue
        call = getattr(fetched, "call", None)
        if call is not None:
            try:
                record_call(conn, job, call)
            except Exception:
                _rollback_quiet(conn)
                return
        try:
            conn.execute("savepoint comment_row")
            insert_comments(conn, job, result_id, getattr(fetched, "comments", None) or [])
            conn.execute("release savepoint comment_row")
        except Exception:
            try:
                conn.execute("rollback to savepoint comment_row")
            except Exception:
                _rollback_quiet(conn)
                return


def run_instant_search(
    connect: Any,
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
    tx = _Transactions(connect)
    if settings is None:
        settings = tx.run(load_provider_settings)
    tx.run(lambda conn: start_search(conn, job))
    now = now.astimezone(timezone.utc)
    collected_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff_iso = _cutoff(now, job.date_window)
    date_window_days = _DATE_WINDOW_DAYS.get(job.date_window)
    sources = _enabled_platforms(settings)
    for platform, chain in sources:
        tx.run(
            lambda conn, platform=platform, chain=chain: set_source_state(
                conn, job, platform, "queued", provider=chain[0], attempted_providers=chain
            )
        )

    executor = ThreadPoolExecutor(max_workers=max(MAX_CONCURRENCY, len(sources)))
    futures: dict[Any, tuple[str, tuple[str, ...]]] = {}
    all_posts: list[CanonicalPost] = []
    pending: set[Any] = set()
    comment_futures: dict[Any, tuple[str, str]] = {}
    try:
        # The row's own deadline_at is the budget, not a fresh 40 s from claim
        # time: a search claimed late must still finish by its promised time.
        remaining = _remaining_seconds(job, deadline_seconds, datetime.now(timezone.utc))
        comment_calls = 0
        comment_rows = 0
        skip_reasons: list[str] = []
        comment_running = False
        commented_platforms: set[str] = set()
        if comment_fetcher is None:
            comment_fetcher = _default_comment_fetcher(env, None)
        if remaining < MIN_LAUNCH_SECONDS:
            for platform, chain in sources:
                tx.run(
                    lambda conn, platform=platform, chain=chain: set_source_state(
                        conn,
                        job,
                        platform,
                        "unavailable",
                        provider=chain[0],
                        attempted_providers=chain,
                        safe_detail="deadline",
                    )
                )
                _info(job.id, platform=platform, state="unavailable", results=0, latency_ms=0, detail="deadline")
            skip_reasons.append("comment_budget")
        else:
            for platform, chain in sources:
                tx.run(
                    lambda conn, platform=platform, chain=chain: set_source_state(
                        conn, job, platform, "searching", provider=chain[0], attempted_providers=chain
                    )
                )
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
            # One clock read establishes both budgets. Comments keep a slice
            # after the source deadline; they are not limited by it.
            source_deadline = clock() + remaining
            comment_deadline = source_deadline + COMMENT_BUDGET_SECONDS

            def _schedule_comments(platform: str, posts: list[CanonicalPost]) -> None:
                nonlocal comment_calls, comment_running
                if platform in commented_platforms:
                    return
                commented_platforms.add(platform)
                if resolve_chain(platform, settings, mode="comments") == ():
                    skip_reasons.append("no_provider")
                    _info(job.id, platform=platform, comments="skipped", reason="no_provider")
                    return
                if not posts:
                    skip_reasons.append("no_posts")
                    _info(job.id, platform=platform, comments="skipped", reason="no_posts")
                    return
                if comment_deadline - clock() < MIN_COMMENT_SECONDS:
                    skip_reasons.append("comment_budget")
                    _info(job.id, platform=platform, comments="skipped", reason="comment_budget")
                    return
                ranked_posts = sorted(
                    posts,
                    key=lambda item: (item.views or 0) + 3 * (item.likes or 0) + 2 * (item.replies or 0) + 2 * (item.shares or 0),
                    reverse=True,
                )[:TOP_POSTS_FOR_COMMENTS]
                ids = tx.run(lambda conn: _comment_result_ids(conn, job, platform))
                started = 0
                for post in ranked_posts:
                    if comment_calls >= MAX_COMMENT_CALLS:
                        skip_reasons.append("call_cap")
                        break
                    result_id = ids.get(post.external_id)
                    if not result_id:
                        continue
                    left = comment_deadline - clock()
                    if left < MIN_COMMENT_SECONDS:
                        skip_reasons.append("comment_budget")
                        break
                    timeout = max(1, min(ROUTE_TIMEOUT_SECONDS, int(left)))
                    future = executor.submit(
                        comment_fetcher,
                        platform,
                        post,
                        settings=settings,
                        env=env,
                        timeout=timeout,
                    )
                    comment_futures[future] = (platform, result_id)
                    comment_calls += 1
                    started += 1
                if started and not comment_running:
                    tx.run(lambda conn: _set_comment_progress(conn, job, "running", None))
                    comment_running = True
                _info(job.id, platform=platform, comments="started", calls=started)

            def _drain_comments(done: set[Any]) -> None:
                nonlocal comment_rows
                for future in done:
                    meta = comment_futures.pop(future, None)
                    if meta is None:
                        continue
                    platform, result_id = meta
                    try:
                        fetched = future.result()
                    except Exception:
                        _info(job.id, platform=platform, comments="failed", reason="error")
                        continue
                    try:
                        def _store(conn: Any, result_id: str = result_id, fetched: Any = fetched) -> int:
                            call = getattr(fetched, "call", None)
                            if call is not None:
                                record_call(conn, job, call)
                            return insert_comments(
                                conn, job, result_id, getattr(fetched, "comments", None) or []
                            )

                        comment_rows += int(tx.run(_store) or 0)
                    except Exception:
                        if tx.shared is not None:
                            _rollback_quiet(tx.shared)
                        _info(job.id, platform=platform, comments="failed", reason="storage")

            while pending:
                left = source_deadline - clock()
                if left <= 0:
                    break
                done, pending = wait(pending, timeout=left, return_when=FIRST_COMPLETED)
                if not done:
                    break
                for future in done:
                    platform, chain = futures[future]
                    try:
                        result = future.result()
                    except Exception:
                        tx.run(lambda conn, platform=platform, chain=chain: _failed_state(conn, job, platform, chain))
                        _info(job.id, platform=platform, state="failed", results=0, latency_ms=0, detail="other")
                        continue
                    try:
                        kept = _handle_result(tx, job, platform, chain, result, cutoff_iso, all_posts)
                    except Exception:
                        # Belt and braces: _handle_result isolates itself, but one
                        # platform must never abort the remaining done futures.
                        _mark_source_failed(tx, job, platform, chain)
                        kept = []
                    state = getattr(result, "state", "failed")
                    _info(
                        job.id,
                        platform=platform,
                        state=state,
                        results=len(kept or []),
                        latency_ms=getattr(result, "latency_ms", None) or 0,
                        detail=getattr(result, "safe_detail", None) or "other",
                    )
                    _schedule_comments(platform, kept or [])
                ready = {item for item in comment_futures if item.done()}
                if ready:
                    _drain_comments(ready)
            for future in pending:
                platform, chain = futures[future]
                # A route that finishes after the deadline was still paid for.
                # Record its calls once it lands, without changing the state
                # the search already showed.
                if tx.factory:
                    future.add_done_callback(
                        lambda done, job=job: _record_late_calls(connect, job, done)
                    )
                future.cancel()
                tx.run(
                    lambda conn, platform=platform, chain=chain: set_source_state(
                        conn,
                        job,
                        platform,
                        "unavailable",
                        provider=chain[0],
                        attempted_providers=chain,
                        safe_detail="deadline",
                    )
                )
                _info(job.id, platform=platform, state="unavailable", results=0, latency_ms=0, detail="deadline")
            while comment_futures:
                left = comment_deadline - clock()
                if left <= 0:
                    break
                done, _rest = wait(set(comment_futures), timeout=left, return_when=FIRST_COMPLETED)
                if not done:
                    break
                _drain_comments(done)
            for future in list(comment_futures):
                if tx.factory:
                    future.add_done_callback(
                        lambda done, job=job: _record_late_calls(connect, job, done)
                    )
                future.cancel()
        ranked = sort_posts(dedupe_posts(all_posts), job.sort_mode)
        tx.run(lambda conn: _apply_ranks(conn, job, ranked))
        if comment_rows:
            comment_status, comment_detail = "done", "ok"
        elif comment_calls:
            comment_status, comment_detail = "skipped", "calls_failed"
        elif "comment_budget" in skip_reasons:
            comment_status, comment_detail = "skipped", "comment_budget"
        elif "no_posts" in skip_reasons:
            comment_status, comment_detail = "skipped", "no_posts"
        elif "no_provider" in skip_reasons:
            comment_status, comment_detail = "skipped", "no_provider"
        else:
            comment_status, comment_detail = "skipped", "no_posts"
        try:
            tx.run(lambda conn: _set_comment_progress(conn, job, comment_status, comment_detail))
        except Exception:
            if tx.shared is not None:
                _rollback_quiet(tx.shared)
        _info(
            job.id,
            comments_calls=comment_calls,
            comments_inserted=comment_rows,
            comment_status=comment_status,
            comment_detail=comment_detail,
        )
        tx.run(lambda conn: finish_search(conn, job, "failed"))
    finally:
        # cancel() cannot stop a task that already started. Wait only for the
        # per-route bound, then stop waiting entirely: late results are
        # discarded and must not hold the worker thread hostage.
        stragglers = set(pending) | set(comment_futures)
        for future in stragglers:
            future.cancel()
        still_running: set[Any] = set()
        if stragglers:
            _, still_running = wait(stragglers, timeout=ROUTE_TIMEOUT_SECONDS)
        # Join the pool only when every straggler has already finished. A route
        # that is still hung must not hold shutdown (or the worker) hostage.
        executor.shutdown(wait=not still_running, cancel_futures=True)


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


def _fail_unfinished_sources(conn: Any, job: InstantSearchJob) -> None:
    _set_customer(conn, job.customer_id)
    conn.execute(
        "update instant_search_sources set state = 'failed', safe_detail = 'storage_failed', "
        "updated_at = now() where search_id = %s and state in ('queued', 'searching')",
        (job.id,),
    )


def _run_job_safely(connect: Any, job: InstantSearchJob, kwargs: Mapping[str, Any]) -> None:
    try:
        run_instant_search(connect, job, **kwargs)
    except Exception:
        # A started search must never fall back to 'queued' and repeat paid
        # calls, and no source may stay 'searching' forever. Best effort: mark
        # the stragglers terminal, then finish the search as failed.
        try:
            _Transactions(connect).run(lambda conn: _fail_unfinished_sources(conn, job))
        except Exception:
            pass
        try:
            _Transactions(connect).run(
                lambda conn: finish_search(conn, job, "failed", error_code="storage_failed")
            )
        except Exception:
            pass


def run_instant_search_cycle(
    connect: Any,
    *,
    env: Mapping[str, Any],
    now: datetime,
    limits: Any,
    settings: Mapping[str, ProviderSetting] | None = None,
    fetcher: Any = fetch_platform,
    deadline_seconds: float = SEARCH_DEADLINE_SECONDS,
    max_searches: int | None = None,
    max_concurrency: int = 4,
) -> int:
    del limits
    tx = _Transactions(connect)
    tx.run(lambda conn: _fail_deadline_missed_searches(conn, now))
    limit = 4 if max_searches is None else max(0, int(max_searches))
    jobs: list[InstantSearchJob] = []
    seen: set[str] = set()
    while len(jobs) < limit:
        job = tx.run(lambda conn: claim_instant_search(conn, "instant-search-worker"))
        if job is None or job.id in seen:
            break
        seen.add(job.id)
        jobs.append(job)
    kwargs = {
        "env": env,
        "now": now,
        "settings": settings,
        "fetcher": fetcher,
        "deadline_seconds": deadline_seconds,
    }
    try:
        if tx.factory and len(jobs) > 1 and max_concurrency > 1:
            with ThreadPoolExecutor(max_workers=min(max_concurrency, len(jobs))) as pool:
                futures = [pool.submit(_run_job_safely, connect, job, kwargs) for job in jobs]
                for future in futures:
                    future.result()
        else:
            for job in jobs:
                _run_job_safely(connect, job, kwargs)
    finally:
        tx.run(lambda conn: expire_old_searches(conn, now))
    return len(jobs)


def run_instant_search_poll(
    connect: Any,
    *,
    env: Mapping[str, Any],
    now: datetime,
    limits: Any,
    submit: Any,
    in_flight: set[Any],
    settings: Mapping[str, ProviderSetting] | None = None,
    fetcher: Any = fetch_platform,
    deadline_seconds: float = SEARCH_DEADLINE_SECONDS,
    max_inflight: int = MAX_INFLIGHT,
    max_searches: int | None = None,
) -> int:
    """Sweep and claim on the poll cadence, without waiting for running jobs.

    The daemon calls this every ``poll_seconds`` and runs each claimed search on
    a long-lived pool. New arrivals therefore become claimable while an earlier
    batch is still fetching; ``for update skip locked`` plus the immediate
    per-claim commit keep multiple workers from double-claiming.
    """
    del limits
    tx = _Transactions(connect)
    tx.run(lambda conn: _fail_deadline_missed_searches(conn, now))
    capacity = max(0, int(max_inflight) - len(in_flight))
    limit = 4 if max_searches is None else max(0, int(max_searches))
    limit = min(limit, capacity)
    jobs: list[InstantSearchJob] = []
    seen: set[str] = set()
    while len(jobs) < limit:
        job = tx.run(lambda conn: claim_instant_search(conn, "instant-search-worker"))
        if job is None or job.id in seen:
            break
        seen.add(job.id)
        jobs.append(job)
    kwargs = {
        "env": env,
        "now": now,
        "settings": settings,
        "fetcher": fetcher,
        "deadline_seconds": deadline_seconds,
    }
    for job in jobs:
        in_flight.add(submit(_run_job_safely, connect, job, kwargs))
    tx.run(lambda conn: expire_old_searches(conn, now))
    return len(jobs)
