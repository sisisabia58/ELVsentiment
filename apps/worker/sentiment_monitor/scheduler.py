import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping
import urllib.error
from urllib.parse import quote, unquote, urlsplit

from sentiment_monitor.collect_once import gate, sources_allowed
from sentiment_monitor.incremental import collect_newer_x, numeric_since_id
from sentiment_monitor.intent import Keyword
from sentiment_monitor.pg_store import CommitOutcomeUnknown, PostgresStore
from sentiment_monitor.sources.routes import scrapecreators_request_count
from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError
from sentiment_monitor.x_cost import admit_collection, admit_threads_query, admit_x_read

# Asia/Jakarta is a fixed UTC+7 offset. The daily schedule uses that civil
# minute, not "24 hours after the worker happened to tick".
JAKARTA = timezone(timedelta(hours=7))

ALL_SOURCES = ("x", "threads", "instagram", "tiktok")

CLAIM_SQL = """
select id, customer_id, project_id, kind
from jobs
where status = 'queued' and run_after <= now()
order by run_after asc, id asc
limit %s
for update skip locked
"""

ENQUEUE_SQL = """
with due as (
  select s.project_id, s.customer_id,
         exists (
           select 1 from jobs j
           where j.project_id = s.project_id
             and j.status in ('queued', 'claimed')
         ) as overlapping
  from project_schedules s
  where s.enabled
    and s.next_run_at is not null
    and s.next_run_at <= now()
),
advanced as (
  update project_schedules s
  set next_run_at = case
    when s.cadence = 'daily' and s.daily_minute is not null then
      timezone(
        'Asia/Jakarta',
        date_trunc('day', timezone('Asia/Jakarta', now()))
          + make_interval(mins => s.daily_minute)
          + case
              when timezone(
                'Asia/Jakarta',
                date_trunc('day', timezone('Asia/Jakarta', now()))
                  + make_interval(mins => s.daily_minute)
              ) <= now()
              then interval '1 day'
              else interval '0'
            end
      )
    else now() + make_interval(hours => s.interval_hours)
  end
  from due
  where s.project_id = due.project_id
  returning s.customer_id, s.project_id, due.overlapping
)
insert into jobs (id, customer_id, project_id, kind, status, run_after, status_detail, created_at)
select gen_random_uuid(), customer_id, project_id, 'scheduled',
       case when overlapping then 'deferred' else 'queued' end,
       now(),
       case when overlapping then 'skipped_overlap' else null end,
       now()
from advanced
"""

EXPIRE_CLAIMS_SQL = """
update jobs
set status = 'failed', status_detail = 'claim_expired'
where status = 'claimed'
and claimed_at < now() - make_interval(secs => %s)
"""

HEARTBEAT_SQL = """
insert into worker_heartbeat (id, worker_id, last_seen_at)
values (1, %s, now())
on conflict (id) do update
  set worker_id = excluded.worker_id,
      last_seen_at = excluded.last_seen_at
"""

_SECRET_NAMES = (
    "DATABASE_URL",
    "WORKER_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "APP_DB_PASSWORD",
    "WORKER_DB_PASSWORD",
    "X_BEARER_TOKEN",
    "SCRAPECREATORS_API_KEY",
    "THREADS_ACCESS_TOKEN",
    "TYPESAFE_API_KEY",
    "OPENROUTER_API_KEY",
)


def enqueue_due_sql() -> str:
    return ENQUEUE_SQL


def next_daily_run_at(daily_minute: int, now: datetime) -> datetime:
    """Next Asia/Jakarta occurrence of a minute-of-day, strictly after `now` when that minute has started."""
    if now.tzinfo is None:
        raise ValueError("daily_clock_requires_aware_now")
    minute = max(0, min(1439, int(daily_minute)))
    local = now.astimezone(JAKARTA)
    hour, mins = divmod(minute, 60)
    candidate = local.replace(hour=hour, minute=mins, second=0, microsecond=0)
    if candidate <= local:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


ENABLED_SOURCES_SQL = """
select enabled_sources
from project_settings
where project_id = %s
"""


def load_enabled_sources(conn, project_id: str) -> list[str]:
    rows = conn.execute(ENABLED_SOURCES_SQL, (project_id,)) or []
    if not rows:
        return list(ALL_SOURCES)
    raw = rows[0].get("enabled_sources") if isinstance(rows[0], dict) else None
    if not isinstance(raw, (list, tuple)):
        return list(ALL_SOURCES)
    filtered = [item for item in raw if item in ALL_SOURCES]
    return filtered or list(ALL_SOURCES)


def heartbeat_sql() -> str:
    return HEARTBEAT_SQL


def claim_due_jobs(conn, worker_id: str, limit: int) -> list:
    rows = conn.execute(CLAIM_SQL, (limit,)) or []
    for row in rows:
        conn.execute(
            "update jobs set status = 'claimed', claimed_by = %s, claimed_at = now() where id = %s",
            (worker_id, row["id"]),
        )
    return rows


def record_heartbeat(conn, worker_id: str) -> None:
    conn.execute(HEARTBEAT_SQL, (worker_id,))


def heartbeat_is_stale(last_seen: datetime | None, now: datetime, stale_seconds: int) -> bool:
    if last_seen is None:
        return True
    return (now - last_seen).total_seconds() > stale_seconds


def decide_job(gate_code: int) -> tuple[str, str] | None:
    if gate_code != 0:
        return ("deferred", "credential_unapproved")
    return None


def _url_password_secrets(value: str) -> set[str]:
    try:
        password = urlsplit(value).password
    except ValueError:
        return set()
    if not password:
        return set()
    decoded = unquote(password)
    return {password, decoded, quote(password, safe=""), quote(decoded, safe="")}


def format_log(
    message: str,
    *,
    env: Mapping[str, str] | None = None,
    **fields: Any,
) -> str:
    source_env = os.environ if env is None else env
    replacement = "[REDACTED]" if env is not None or fields else "[redacted]"
    secrets: set[str] = set()
    for name in _SECRET_NAMES:
        value = source_env.get(name, "")
        if not value:
            continue
        secrets.add(value)
        secrets.add(quote(value, safe=""))
        if "URL" in name:
            secrets.update(_url_password_secrets(value))
    combined = message
    if fields:
        suffix = " ".join(f"{key}={val}" for key, val in fields.items())
        combined = f"{message} {suffix}"
    redacted = combined
    for secret in sorted(secrets, key=len, reverse=True):
        if secret:
            redacted = redacted.replace(secret, replacement)
    return redacted


_SAFE_DETAIL_CODES = frozenset(
    {
        "success_false",
        "malformed_json",
        "malformed_envelope",
        "missing_posts",
        "malformed_posts",
        "collection_failed",
        "transport_error",
        "read_timeout",
        "storage_failed",
        "storage_commit_unknown",
        "sources_unavailable",
        "credential_unapproved",
        "claim_expired",
        "skipped_overlap",
        "schedule_min_interval_hours",
        "unknown_error",
        "other",
        "ok",
    }
)

_SAFE_SOURCES = ("x", "threads", "instagram", "tiktok")

_SAFE_ERROR_CLASSES = frozenset(
    {
        "Exception",
        "RuntimeError",
        "ValueError",
        "TypeError",
        "KeyError",
        "OSError",
        "ScrapeCreatorsError",
        "SourceFetchError",
        "HTTPError",
    }
)

_MAX_SAFE_LABEL_LENGTH = 64


def _safe_detail_code(code: str) -> str:
    if code in _SAFE_DETAIL_CODES or re.fullmatch(r"http_[0-9]{3}", code):
        return code
    for source in _SAFE_SOURCES:
        prefix = f"{source}_"
        if not code.startswith(prefix):
            continue
        rest = code[len(prefix) :]
        if rest in _SAFE_DETAIL_CODES or re.fullmatch(r"http_[0-9]{3}", rest):
            return code
    return "other"


def _safe_error_label(error: Exception) -> str:
    code = getattr(error, "detail", None) or getattr(error, "code", None)
    safe_code = _safe_detail_code(code) if isinstance(code, str) else "other"
    class_name = type(error).__name__
    if class_name not in _SAFE_ERROR_CLASSES:
        class_name = "Exception"
    return f"{class_name} {safe_code}"[:_MAX_SAFE_LABEL_LENGTH]


def _safe_log(log, message) -> None:
    """Logging must never change data or job outcome, and never recurse."""
    try:
        if callable(message):
            message = message()
        log(message)
    except Exception:
        return


def _log_exception(error: Exception) -> None:
    if getattr(error, "_monitor_logged", False):
        return
    _safe_log(print, lambda: format_log(_safe_error_label(error)))
    try:
        error._monitor_logged = True
    except Exception:
        return


def enqueue_due_schedules(conn, limits) -> None:
    # The saved interval was checked against the shared minimum. Filtering again
    # with a worker-only env override would skip schedules the web accepted.
    if limits.schedule_min_interval_hours < 1:
        raise ValueError("schedule_min_interval_hours")
    conn.execute(ENQUEUE_SQL)


def release_expired_claims(conn, stale_seconds: int) -> None:
    conn.execute(EXPIRE_CLAIMS_SQL, (stale_seconds,))


def _defer(conn, job_id: str, detail: str) -> None:
    conn.execute(
        "update jobs set status = 'deferred', status_detail = %s where id = %s",
        (detail, job_id),
    )


def _fail(conn, job_id: str, detail: str) -> None:
    conn.execute(
        "update jobs set status = 'failed', status_detail = %s where id = %s",
        (detail, job_id),
    )


def source_failure_state(detail: str, http_status: int | None = None) -> str:
    status = http_status
    if status is None:
        match = re.search(r"_http_(\d{3})$", detail or "")
        status = int(match.group(1)) if match else None
    if status in (401, 403):
        return "authorization_failed"
    if status in (402, 429):
        return "rate_limited"
    return "unavailable"


def record_source_failure(
    conn,
    customer_id: str,
    project_id: str,
    source: str,
    detail: str,
    state: str,
) -> str:
    conn.execute(
        """
        insert into source_status (customer_id, project_id, source, state, detail, updated_at)
        values (%s, %s, %s, %s, %s, now())
        on conflict (customer_id, project_id, source) do update
          set state = excluded.state,
              detail = excluded.detail,
              updated_at = excluded.updated_at
        """,
        (customer_id, project_id, source, state, detail),
    )
    return state


def record_source_success(conn, customer_id: str, project_id: str, source: str) -> None:
    conn.execute(
        """
        insert into source_status (customer_id, project_id, source, state, detail, last_success_at, updated_at)
        values (%s, %s, %s, 'ready', 'ok', now(), now())
        on conflict (customer_id, project_id, source) do update
          set state = 'ready',
              detail = 'ok',
              last_success_at = now(),
              updated_at = now()
        """,
        (customer_id, project_id, source),
    )


def _failure_detail(error: Exception, source: str = "threads") -> str:
    if isinstance(error, ScrapeCreatorsError):
        return f"{source}_{error.code}"
    if isinstance(error, urllib.error.HTTPError):
        url_str = getattr(error, "url", None) or ""
        try:
            host = (urlsplit(str(url_str)).hostname or "").lower()
        except ValueError:
            host = ""
        if host == "api.x.com":
            return f"x_http_{error.code}"
        return f"{source}_http_{error.code}"

    response = getattr(error, "response", None)
    request = getattr(error, "request", None)
    if request is None and response is not None:
        request = getattr(response, "request", None)
    status = getattr(response, "status_code", None) if response is not None else None
    url = getattr(request, "url", None) if request is not None else None
    host = getattr(url, "host", None) if url is not None else None
    if isinstance(host, str):
        host = host.lower()
    else:
        host = None
    if type(status) is int:
        if host in ("graph.threads.com", "graph.threads.net"):
            return f"threads_http_{status}"
        if host == "api.x.com":
            return f"x_http_{status}"
        if host == "api.scrapecreators.com":
            return f"{source}_http_{status}"
    return "collection_failed"


def active_variants_sql() -> str:
    return """
    select text, intent
    from keyword_variants
    where project_id = %s and active
    order by text
    """


def load_active_variants(conn, project_id: str) -> list[Keyword]:
    rows = conn.execute(active_variants_sql(), (project_id,)) or []
    return [
        Keyword(str(row["text"]), row.get("intent") or "phrase")
        for row in rows
    ]


def store_source(
    conn,
    job,
    mentions: list,
    query_key: str,
    source: str,
    next_cursor: str | None,
    incremental_since=None,
) -> int:
    return PostgresStore(conn).write_mentions_and_cursor(
        customer_id=job["customer_id"],
        project_id=job["project_id"],
        query_key=query_key,
        source=source,
        mentions=mentions,
        next_cursor=next_cursor,
        incremental_since=incremental_since,
    )


class _CommitFailed(Exception):
    """commit() itself raised, so durability is unknown."""

    def __init__(self, error: Exception) -> None:
        super().__init__("commit_failed")
        self.error = error


class _CloseFailed(Exception):
    """Cleanup/close raised after commit() had already returned successfully."""

    def __init__(self, error: Exception, result: Any) -> None:
        super().__init__("close_failed_after_commit")
        self.error = error
        self.result = result


def _call(connect, fn, *, log_error: bool = True, receipt: dict | None = None):
    conn = connect()
    result = None
    committed = False
    failing = False
    try:
        result = fn(conn)
        try:
            conn.commit()
        except Exception as error:
            failing = True
            try:
                conn.rollback()
            except Exception:
                pass
            if log_error:
                _log_exception(error)
            if receipt is not None:
                raise _CommitFailed(error) from None
            raise
        committed = True
        if receipt is not None:
            receipt["committed"] = True
        return result
    except _CommitFailed:
        raise
    except CommitOutcomeUnknown as error:
        # The authoritative transaction/commit phase raised. Do not claim a
        # rollback: durability is unknown.
        failing = True
        if log_error:
            _log_exception(error.error)
        if receipt is not None:
            raise _CommitFailed(error.error) from None
        raise
    except Exception as error:
        failing = True
        try:
            conn.rollback()
        except Exception:
            pass
        if log_error:
            _log_exception(error)
        raise
    finally:
        try:
            conn.close()
        except Exception as close_error:
            if committed and not failing:
                if receipt is not None:
                    raise _CloseFailed(close_error, result) from None
                raise
            if not failing:
                raise


def _heartbeat_log_seconds(explicit: int | None) -> int:
    if explicit is not None:
        return explicit
    raw = (os.environ.get("WORKER_HEARTBEAT_LOG_SECONDS") or "").strip() or "180"
    try:
        seconds = int(raw)
    except (TypeError, ValueError):
        raise ValueError("WORKER_HEARTBEAT_LOG_SECONDS") from None
    if seconds < 1:
        raise ValueError("WORKER_HEARTBEAT_LOG_SECONDS")
    return seconds


def _unpack_fetched(
    result: Any, variant: str
) -> tuple[list[dict[str, Any]], str | None, dict[str, int], int | None, int | None]:
    credits: int | None = None
    http_status: int | None = None
    if isinstance(result, tuple) and len(result) == 2:
        raw_mentions, next_cursor = result
    elif isinstance(result, dict):
        raw_mentions = result.get("mentions") or []
        next_cursor = result.get("next_cursor")
        raw_credits = result.get("credits_charged")
        if type(raw_credits) is int:
            credits = raw_credits
        elif isinstance(raw_credits, float) and raw_credits.is_integer():
            credits = int(raw_credits)
        raw_status = result.get("http_status")
        if type(raw_status) is int:
            http_status = raw_status
    else:
        raw_mentions = []
        next_cursor = None

    normalized: list[dict[str, Any]] = []
    for item in raw_mentions:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        if "excerpt" not in row:
            row["excerpt"] = row.get("text") or ""
        if "variant" not in row:
            row["variant"] = variant
        row["intent"] = row.get("intent") or getattr(variant, "intent", "phrase")
        normalized.append(row)

    counts = {
        "returned": len(raw_mentions),
        "parsed": len(normalized),
        "deduplicated": 0,
    }
    if isinstance(result, dict):
        raw_counts = result.get("counts")
        if isinstance(raw_counts, dict):
            values = [raw_counts.get(key) for key in ("returned", "parsed", "deduplicated")]
            if all(type(value) is int and value >= 0 for value in values):
                counts = {
                    "returned": values[0],
                    "parsed": values[1],
                    "deduplicated": values[2],
                }
    return normalized, next_cursor, counts, credits, http_status


class SourceFetchError(Exception):
    def __init__(
        self,
        detail: str,
        state: str,
        *,
        http_status: int | None = None,
        credits_charged: int | None = None,
        counts: dict[str, int] | None = None,
    ) -> None:
        super().__init__(detail)
        self.detail = detail
        self.state = state
        self.http_status = http_status
        self.credits_charged = credits_charged
        self.counts = counts


def _guarded_fetch(source: str, fetch):
    try:
        return fetch()
    except SourceFetchError:
        raise
    except ScrapeCreatorsError as error:
        raise SourceFetchError(
            f"{source}_{error.code}",
            source_failure_state(error.code, error.http_status),
            http_status=error.http_status,
            credits_charged=error.credits_charged,
            counts=error.counts,
        ) from None
    except Exception as error:
        detail = _failure_detail(error, source)
        status = getattr(error, "code", None)
        if type(status) is not int:
            status = None
        raise SourceFetchError(
            detail,
            source_failure_state(detail, status),
            http_status=status,
            credits_charged=getattr(error, "credits_charged", None),
            counts=getattr(error, "counts", None),
        ) from None


def _count_field(counts: Mapping[str, Any] | None, key: str) -> Any:
    value = counts.get(key) if isinstance(counts, Mapping) else None
    return value if type(value) is int and value >= 0 else "-"


def _log_collection(
    log,
    job,
    source: str,
    outcome: str,
    counts: Mapping[str, Any] | None,
    saved: int | str,
    *,
    http_status: int | None = None,
    credits: int | None = None,
    detail: str = "ok",
) -> None:
    def render() -> str:
        line = (
            f"source_collection job_id={job['id']} project_id={job['project_id']} source={source} "
            f"outcome={outcome} returned={_count_field(counts, 'returned')} "
            f"parsed={_count_field(counts, 'parsed')} "
            f"deduplicated={_count_field(counts, 'deduplicated')} saved={saved} "
            f"http_status={http_status if http_status is not None else '-'} "
            f"credits_charged={credits if credits is not None else '-'} detail={detail}"
        )
        return format_log(line)

    _safe_log(log, render)


def _log_status_write_failed(log, job, source: str, error: Exception) -> None:
    _safe_log(
        log,
        lambda: format_log(
            f"source_status_write_failed job_id={job['id']} project_id={job['project_id']} "
            f"source={source} error={_safe_error_label(error)}"
        ),
    )


def _log_cleanup_failed(log, job, source: str, error: Exception) -> None:
    _safe_log(
        log,
        lambda: format_log(
            f"source_cleanup_failed job_id={job['id']} project_id={job['project_id']} "
            f"source={source} error={_safe_error_label(error)}"
        ),
    )


def _record_source_ready(connect, log, job, source: str) -> None:
    try:
        _call(
            connect,
            lambda conn: record_source_success(
                conn, job["customer_id"], job["project_id"], source
            ),
            log_error=False,
        )
    except Exception as status_error:
        _log_status_write_failed(log, job, source, status_error)


def _job_context(job) -> dict[str, Any]:
    return {
        "job": job,
        "source": None,
        "attempt": False,
        "counts": None,
        "credits": None,
        "http_status": None,
        "committed": False,
        "saved": None,
        "reported": False,
    }


def _reset_source_attempt(context: dict[str, Any], source: str) -> None:
    context["source"] = source
    context["attempt"] = False
    context["counts"] = None
    context["credits"] = None
    context["http_status"] = None
    context["committed"] = False
    context["saved"] = None
    context["reported"] = False


def _commit_source(
    connect,
    log,
    job,
    context: dict[str, Any],
    store_fn,
    *,
    counts: Mapping[str, Any] | None,
    credits: int | None = None,
    http_status: int | None = None,
) -> int:
    """Store, then emit exactly one success line once the commit was reached.

    A close failure after commit keeps the returned saved count and logs a
    distinct cleanup line. A commit failure propagates as _CommitFailed so the
    caller can report an unknown outcome instead of a false rollback.
    """
    cleanup_error = None
    try:
        saved = _call(connect, store_fn, receipt=context)
    except _CloseFailed as error:
        saved = error.result
        cleanup_error = error.error
    context["committed"] = True
    context["saved"] = saved
    _record_source_ready(connect, log, job, context["source"])
    _log_collection(
        log,
        job,
        context["source"],
        "success",
        counts,
        saved,
        http_status=http_status,
        credits=credits,
    )
    context["reported"] = True
    if cleanup_error is not None:
        _log_cleanup_failed(log, job, context["source"], cleanup_error)
    return saved


def _log_job_finalize_failed(log, job, error: Exception) -> None:
    _safe_log(
        log,
        lambda: format_log(
            f"job_finalize_failed job_id={job['id']} project_id={job['project_id']} "
            f"error={_safe_error_label(error)}"
        ),
    )


def admit_threads_queries(conn, limits) -> tuple[bool, str | None]:
    blocked = admit_threads_query(conn, limits)
    if blocked is not None:
        return False, blocked.detail
    return True, None


def serve(
    connect,
    sleep,
    limits,
    worker_id: str,
    root,
    fetch_x,
    fetch_threads,
    log=print,
    monotonic=None,
    heartbeat_log_seconds=None,
    fetch_instagram: Callable[[str], Any] | None = None,
    fetch_tiktok: Callable[[str], Any] | None = None,
) -> None:
    if monotonic is None:
        monotonic = time.monotonic
    interval = _heartbeat_log_seconds(heartbeat_log_seconds)
    last_logged = None
    while True:
        def claim(conn):
            release_expired_claims(conn, limits.worker_heartbeat_stale_seconds)
            record_heartbeat(conn, worker_id)
            enqueue_due_schedules(conn, limits)
            jobs = claim_due_jobs(conn, worker_id, limits.max_jobs_per_tick)
            for job in jobs:
                job["variants"] = load_active_variants(conn, job["project_id"])
                job["sources"] = load_enabled_sources(conn, job["project_id"])
            return gate(root), jobs

        gate_code, jobs = _call(connect, claim)
        for job in jobs:
            context = _job_context(job)

            def fail_job(detail, job=job):
                try:
                    _call(connect, lambda conn: _fail(conn, job["id"], detail))
                except Exception as update_error:
                    _log_exception(update_error)

            blocked_detail = None
            deferred = False
            try:
                decision = decide_job(gate_code)
                if decision is not None:
                    _call(
                        connect,
                        lambda conn, job=job, detail=decision[1]: _defer(conn, job["id"], detail),
                    )
                    deferred = True
                else:
                    selected = [item for item in (job.get("sources") or list(ALL_SOURCES)) if item in ALL_SOURCES]
                    allowed = sources_allowed(root, os.environ)
                    sources = [item for item in selected if item in allowed]
                    if not sources:
                        _call(
                            connect,
                            lambda conn, job=job: _defer(conn, job["id"], "sources_unavailable"),
                        )
                        deferred = True
                    else:
                        plan_keywords = [
                            Keyword(str(item), getattr(item, "intent", "phrase"))
                            for item in job["variants"]
                        ]
                        routes = scrapecreators_request_count(plan_keywords, sources)
                        _safe_log(
                            log,
                            lambda: format_log(
                                f"collection_plan job_id={job['id']} project_id={job['project_id']} "
                                f"keywords={len(plan_keywords)} routes={routes}"
                            ),
                        )
                        for variant in job["variants"]:
                            key = f"{job['customer_id']}:{job['project_id']}:{variant}"
                            collected = None
                            if "x" in sources:
                                _reset_source_attempt(context, "x")
                                def read_state(conn, key=key):
                                    return PostgresStore(conn).source_state(key, "x") or {}

                                state = _call(connect, read_state) or {}
                                floor_id = numeric_since_id(state.get("incremental_cursor"))
                                floor_since = state.get("incremental_since")

                                def admit_first(conn, job=job):
                                    return admit_x_read(conn, job["customer_id"], 10, limits)

                                admission = _call(connect, admit_first)
                                if not isinstance(admission, int):
                                    blocked_detail = admission.detail
                                    break

                                def fetch_page(cursor, since, since_id, limit, variant=variant):
                                    return _guarded_fetch(
                                        "x",
                                        lambda: fetch_x(variant, limit, cursor, since, since_id),
                                    )

                                def admit_page(job=job):
                                    return _call(
                                        connect,
                                        lambda conn, job=job: admit_x_read(conn, job["customer_id"], 10, limits),
                                    )

                                context["attempt"] = True
                                collected = collect_newer_x(
                                    fetch_page,
                                    admit_page,
                                    floor_id=floor_id,
                                    floor_since=floor_since,
                                    first_limit=admission,
                                )
                                x_mentions = list(collected.mentions)
                                x_counts = {
                                    "returned": len(x_mentions),
                                    "parsed": len(x_mentions),
                                    "deduplicated": 0,
                                }
                                context["counts"] = x_counts
                                context["credits"] = None
                                context["http_status"] = None

                                def store_x(
                                    conn,
                                    job=job,
                                    mentions=x_mentions,
                                    key=key,
                                    floor=collected.floor_id,
                                    marker_since=collected.floor_since,
                                ):
                                    return store_source(conn, job, mentions, key, "x", floor, marker_since)

                                _commit_source(
                                    connect,
                                    log,
                                    job,
                                    context,
                                    store_x,
                                    counts=x_counts,
                                    credits=None,
                                    http_status=None,
                                )
                            if "threads" in sources and fetch_threads is not None:
                                _reset_source_attempt(context, "threads")
                                context["attempt"] = True
                                threads_result = _guarded_fetch("threads", lambda: fetch_threads(variant))
                                (
                                    threads_mentions,
                                    threads_cursor,
                                    threads_counts,
                                    threads_credits,
                                    threads_http_status,
                                ) = _unpack_fetched(threads_result, variant)
                                context["counts"] = threads_counts
                                context["credits"] = threads_credits
                                context["http_status"] = threads_http_status

                                def store_threads(
                                    conn,
                                    job=job,
                                    key=key,
                                    threads_mentions=threads_mentions,
                                    threads_cursor=threads_cursor,
                                ):
                                    return store_source(conn, job, threads_mentions, key, "threads", threads_cursor)

                                _commit_source(
                                    connect,
                                    log,
                                    job,
                                    context,
                                    store_threads,
                                    counts=threads_counts,
                                    credits=threads_credits,
                                    http_status=threads_http_status,
                                )
                            if "instagram" in sources and fetch_instagram is not None:
                                _reset_source_attempt(context, "instagram")
                                context["attempt"] = True
                                ig_result = _guarded_fetch("instagram", lambda: fetch_instagram(variant))
                                (
                                    ig_mentions,
                                    ig_cursor,
                                    ig_counts,
                                    ig_credits,
                                    ig_http_status,
                                ) = _unpack_fetched(ig_result, variant)
                                context["counts"] = ig_counts
                                context["credits"] = ig_credits
                                context["http_status"] = ig_http_status

                                def store_instagram(
                                    conn,
                                    job=job,
                                    key=key,
                                    ig_mentions=ig_mentions,
                                    ig_cursor=ig_cursor,
                                ):
                                    return store_source(conn, job, ig_mentions, key, "instagram", ig_cursor)

                                _commit_source(
                                    connect,
                                    log,
                                    job,
                                    context,
                                    store_instagram,
                                    counts=ig_counts,
                                    credits=ig_credits,
                                    http_status=ig_http_status,
                                )
                            if "tiktok" in sources and fetch_tiktok is not None:
                                _reset_source_attempt(context, "tiktok")
                                context["attempt"] = True
                                tt_result = _guarded_fetch("tiktok", lambda: fetch_tiktok(variant))
                                (
                                    tt_mentions,
                                    tt_cursor,
                                    tt_counts,
                                    tt_credits,
                                    tt_http_status,
                                ) = _unpack_fetched(tt_result, variant)
                                context["counts"] = tt_counts
                                context["credits"] = tt_credits
                                context["http_status"] = tt_http_status

                                def store_tiktok(
                                    conn,
                                    job=job,
                                    key=key,
                                    tt_mentions=tt_mentions,
                                    tt_cursor=tt_cursor,
                                ):
                                    return store_source(conn, job, tt_mentions, key, "tiktok", tt_cursor)

                                _commit_source(
                                    connect,
                                    log,
                                    job,
                                    context,
                                    store_tiktok,
                                    counts=tt_counts,
                                    credits=tt_credits,
                                    http_status=tt_http_status,
                                )
                            if collected is not None and collected.blocked_detail:
                                blocked_detail = collected.blocked_detail
                                break
            except _CommitFailed:
                source = context["source"] or "threads"
                _log_collection(
                    log,
                    job,
                    source,
                    "storage_commit_unknown",
                    context["counts"],
                    "-",
                    http_status=context["http_status"],
                    credits=context["credits"],
                    detail="storage_commit_unknown",
                )
                fail_job("storage_commit_unknown")
                continue
            except SourceFetchError as error:
                detail = error.detail
                state = error.state
                source = context["source"] or "threads"
                try:
                    _call(
                        connect,
                        lambda conn: record_source_failure(
                            conn,
                            job["customer_id"],
                            job["project_id"],
                            source,
                            detail,
                            state,
                        ),
                        log_error=False,
                    )
                except Exception as status_error:
                    _log_status_write_failed(log, job, source, status_error)
                _log_collection(
                    log,
                    job,
                    source,
                    "failed",
                    error.counts,
                    0,
                    http_status=error.http_status,
                    credits=error.credits_charged,
                    detail=detail,
                )
                fail_job(detail)
                continue
            except Exception as error:
                if context["committed"]:
                    if not context["reported"]:
                        _log_collection(
                            log,
                            job,
                            context["source"],
                            "success",
                            context["counts"],
                            context["saved"] if context["saved"] is not None else "-",
                            http_status=context["http_status"],
                            credits=context["credits"],
                        )
                        context["reported"] = True
                    _log_cleanup_failed(log, job, context["source"], error)
                else:
                    if context["attempt"]:
                        _log_collection(
                            log,
                            job,
                            context["source"],
                            "storage_failed",
                            context["counts"],
                            0,
                            http_status=context["http_status"],
                            credits=context["credits"],
                            detail="storage_failed",
                        )
                    else:
                        _log_exception(error)
                    fail_job("storage_failed")
                    continue

            if deferred:
                continue
            if job["variants"]:
                def finish_job(conn, job=job, blocked_detail=blocked_detail):
                    if blocked_detail:
                        _defer(conn, job["id"], blocked_detail)
                        return
                    conn.execute(
                        "update jobs set status = 'succeeded', status_detail = null where id = %s",
                        (job["id"],),
                    )
                    conn.execute(
                        "update project_schedules set last_collected_at = now() where project_id = %s",
                        (job["project_id"],),
                    )

                try:
                    _call(connect, finish_job)
                except Exception as error:
                    _log_job_finalize_failed(log, job, error)
                    fail_job("storage_failed")
        now = monotonic()
        if last_logged is None or now - last_logged >= interval:
            _safe_log(log, lambda: format_log(f"worker heartbeat id={worker_id}"))
            last_logged = now
        sleep(limits.worker_poll_seconds)


class CursorRowAdapter:
    """Map a psycopg cursor onto the row shapes the scheduler already expects.

    Only ``__main__`` connect() wraps a live connection. Scripted tests pass
    connections whose execute already returns rows and must not use this.
    """

    manages_transactions = True

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=None):
        cursor = self._conn.execute(sql, params)
        if cursor.description is None:
            return None
        compact = " ".join(sql.lower().split())
        if compact.startswith("select") and "from source_cursors" in compact:
            row = cursor.fetchone()
            return {} if row is None else row
        if _is_counter_select(compact):
            return _counter_value(cursor.fetchone())
        return cursor.fetchall()

    def commit(self):
        # psycopg forbids Connection.commit() inside transaction() and commits
        # on context exit. Scripted connections have no _num_transactions.
        if getattr(self._conn, "_num_transactions", 0):
            return None
        return self._conn.commit()

    def rollback(self):
        return self._conn.rollback()

    def close(self):
        return self._conn.close()

    def transaction(self):
        return self._conn.transaction()


def _is_counter_select(compact: str) -> bool:
    if not compact.startswith("select"):
        return False
    if "from x_read_counters" in compact and "for update" in compact:
        return True
    return "count" in compact and "from threads_query_log" in compact


def _counter_value(row) -> int:
    if row is None:
        return 0
    value = next(iter(row.values())) if isinstance(row, dict) else row[0]
    return int(value or 0)


if __name__ == "__main__":
    import time
    import psycopg
    from sentiment_monitor.limits import load_limits
    from sentiment_monitor.paths import repo_root

    root = repo_root()
    limits = load_limits(root / "config" / "limits.json")
    worker_id = os.environ.get("WORKER_ID", "worker-1")

    def connect():
        from psycopg.rows import dict_row

        return CursorRowAdapter(
            psycopg.connect(
                os.environ["WORKER_DATABASE_URL"],
                autocommit=False,
                row_factory=dict_row,
            )
        )

    def fetch_x(variant: str, limit: int, cursor: str | None, since=None, since_id: str | None = None):
        from datetime import datetime

        from sentiment_monitor.collect import fetch_x_with_cursor

        if isinstance(since, str):
            since = datetime.fromisoformat(since.replace("Z", "+00:00"))
        rows, next_cursor = fetch_x_with_cursor(
            variant,
            os.environ["X_BEARER_TOKEN"],
            cursor=cursor,
            since=since,
            since_id=since_id,
            limit=limit,
        )
        mentions = [
            {
                "external_id": row.external_id,
                "excerpt": row.text,
                "url": row.url,
                "author": row.author,
                "posted_at": row.created_at,
                "variant": row.variant,
                "intent": getattr(variant, "intent", "phrase"),
                "route_id": "x.keyword",
            }
            for row in rows
        ]
        return mentions, next_cursor

    def fetch_threads(variant: str):
        from sentiment_monitor.sources.threads import fetch_threads_mentions

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return fetch_threads_mentions(
            variant,
            os.environ["SCRAPECREATORS_API_KEY"],
            now_iso,
            intent=getattr(variant, "intent", "phrase"),
        )

    def fetch_instagram(variant: str):
        from sentiment_monitor.sources.instagram import fetch_instagram_mentions

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return fetch_instagram_mentions(
            variant,
            os.environ["SCRAPECREATORS_API_KEY"],
            now_iso,
            intent=getattr(variant, "intent", "phrase"),
        )

    def fetch_tiktok(variant: str):
        from sentiment_monitor.sources.tiktok import fetch_tiktok_mentions

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return fetch_tiktok_mentions(
            variant,
            os.environ["SCRAPECREATORS_API_KEY"],
            now_iso,
            intent=getattr(variant, "intent", "phrase"),
        )

    serve(
        connect,
        time.sleep,
        limits,
        worker_id,
        root,
        fetch_x,
        fetch_threads,
        fetch_instagram=fetch_instagram,
        fetch_tiktok=fetch_tiktok,
    )

