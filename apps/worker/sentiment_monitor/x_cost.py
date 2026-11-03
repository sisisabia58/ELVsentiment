from decimal import Decimal

from sentiment_monitor.status import CollectionReport

# Posts: Read, $0.005 per resource.
# https://docs.x.com/x-api/getting-started/pricing.md observed 2026-11-01.
# Prices on that page are subject to change.
POSTS_READ_USD = Decimal("0.005")

# Pay-per-usage plans are capped at 3 million Post reads per monthly billing cycle.
# Same official page, observed 2026-11-01.
PLATFORM_POST_READ_CAP = 3_000_000


def estimated_usd(posts_returned: int) -> Decimal:
    return POSTS_READ_USD * posts_returned


def max_results_within_budget(
    posts_already_customer: int,
    posts_already_global: int,
    customer_cap: int,
    global_cap: int,
    requested: int,
) -> int | None:
    if requested < 10:
        return None
    remaining = min(
        customer_cap - posts_already_customer,
        min(global_cap, PLATFORM_POST_READ_CAP) - posts_already_global,
    )
    if remaining < 10:
        return None
    return min(requested, 100, remaining)


def budget_block_report(detail: str) -> CollectionReport:
    if detail not in ("x_customer_cap", "x_global_cap"):
        raise ValueError(detail)
    return CollectionReport("x", "failed", None, "rate_limited", detail, False)


GLOBAL_CUSTOMER_ID = "00000000-0000-0000-0000-000000000000"

X_COUNTER_SQL = """
select coalesce(posts_reserved, 0)
from x_read_counters
where customer_id = %s
  and period_start = date_trunc('month', now() at time zone 'utc')::date
for update
"""

RESERVE_X_SQL = """
insert into x_read_counters (customer_id, period_start, posts_reserved)
values (%s, date_trunc('month', now() at time zone 'utc')::date, %s)
on conflict (customer_id, period_start)
do update set posts_reserved = x_read_counters.posts_reserved + excluded.posts_reserved
"""

THREADS_COUNT_SQL = """
select count(*)
from threads_query_log
where queried_at > now() - interval '24 hours'
"""

RESERVE_THREADS_SQL = """
insert into threads_query_log (id, queried_at)
values (gen_random_uuid(), now())
"""


def threads_block_report() -> CollectionReport:
    return CollectionReport("threads", "failed", None, "rate_limited", "threads_budget", False)


def _counter(conn, sql: str, params: tuple) -> int:
    found = conn.execute(sql, params)
    return int(found or 0)


def _x_budget(conn, customer_id: str, requested: int, limits) -> int | CollectionReport:
    customer_used = _counter(conn, X_COUNTER_SQL, (customer_id,))
    global_used = _counter(conn, X_COUNTER_SQL, (GLOBAL_CUSTOMER_ID,))
    if customer_used + requested > limits.x_monthly_per_customer_post_reads:
        return budget_block_report("x_customer_cap")
    if global_used + requested > limits.x_monthly_global_post_reads:
        return budget_block_report("x_global_cap")
    page = max_results_within_budget(
        customer_used,
        global_used,
        limits.x_monthly_per_customer_post_reads,
        limits.x_monthly_global_post_reads,
        requested,
    )
    if page is None:
        detail = "x_global_cap" if global_used >= customer_used else "x_customer_cap"
        return budget_block_report(detail)
    return page


def _reserve_x(conn, customer_id: str, page: int) -> None:
    conn.execute(RESERVE_X_SQL, (customer_id, page))
    conn.execute(RESERVE_X_SQL, (GLOBAL_CUSTOMER_ID, page))


def admit_x_read(conn, customer_id: str, requested: int, limits) -> int | CollectionReport:
    page = _x_budget(conn, customer_id, requested, limits)
    if not isinstance(page, int):
        return page
    _reserve_x(conn, customer_id, page)
    return page


def admit_collection(conn, customer_id: str, requested: int, limits) -> int | CollectionReport:
    """Reserve one X page and one Threads query, or neither.

    Both caps are read before either reserve. A Threads block therefore does
    not keep an X read that the caller would have to drop.
    """
    used = _counter(conn, THREADS_COUNT_SQL, ())
    if used >= limits.threads_rolling_24h_reserve:
        return threads_block_report()
    page = _x_budget(conn, customer_id, requested, limits)
    if not isinstance(page, int):
        return page
    _reserve_x(conn, customer_id, page)
    conn.execute(RESERVE_THREADS_SQL, ())
    return page


def admit_threads_query(conn, limits) -> CollectionReport | None:
    used = _counter(conn, THREADS_COUNT_SQL, ())
    if used >= limits.threads_rolling_24h_reserve:
        return threads_block_report()
    conn.execute(RESERVE_THREADS_SQL, ())
    return None


def run_threads(conn, limits, fetch):
    blocked = admit_threads_query(conn, limits)
    if blocked is not None:
        return blocked
    return fetch()
