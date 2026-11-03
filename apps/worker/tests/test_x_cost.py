from decimal import Decimal
from pathlib import Path

from sentiment_monitor.limits import load_limits
from sentiment_monitor.x_cost import (
    GLOBAL_CUSTOMER_ID,
    admit_threads_query,
    admit_x_read,
    run_threads,
    threads_block_report,
)

from sentiment_monitor.x_cost import (
    PLATFORM_POST_READ_CAP,
    estimated_usd,
    max_results_within_budget,
    budget_block_report,
)


def test_estimate_uses_the_cited_per_post_rate():
    assert estimated_usd(2) == Decimal("0.010")
    assert PLATFORM_POST_READ_CAP == 3_000_000


def test_customer_and_global_caps_block_the_page():
    assert max_results_within_budget(2_000, 0, 2_000, 20_000, 100) is None
    customer = budget_block_report("x_customer_cap")
    assert customer.fetched_count is None
    assert customer.state == "rate_limited"
    assert customer.detail == "x_customer_cap"
    assert max_results_within_budget(0, 20_000, 2_000, 20_000, 100) is None
    assert budget_block_report("x_global_cap").detail == "x_global_cap"


def test_page_size_stays_inside_x_limits_and_the_platform_cap():
    assert max_results_within_budget(0, 0, 50, 20_000, 100) == 50
    assert max_results_within_budget(0, 2_999_995, 2_000, 9_000_000, 100) is None


def test_unapproved_files_block_collection(tmp_path):
    from sentiment_monitor.collect_once import gate

    config = tmp_path / "config"
    config.mkdir()
    (config / "credential-policy.json").write_text(
        '{"approved": false, "mode": "shared_operator"}', encoding="utf-8"
    )
    (config / "x-budget.json").write_text('{"approved": false}', encoding="utf-8")
    assert gate(tmp_path) == 2


class ScriptedConn:
    def __init__(self, customer_posts=0, global_posts=0, threads_used=0):
        self.customer_posts = customer_posts
        self.global_posts = global_posts
        self.threads_used = threads_used
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        lowered = " ".join(sql.lower().split())
        if "from threads_query_log" in lowered and "count" in lowered:
            return self.threads_used
        if "from x_read_counters" in lowered and "for update" in lowered:
            if params[0] == GLOBAL_CUSTOMER_ID:
                return self.global_posts
            return self.customer_posts
        return None


def test_limits_file_has_the_conservative_defaults():
    limits = load_limits(Path("config/limits.json"), {})
    assert limits.x_monthly_global_post_reads == 20_000
    assert limits.x_monthly_per_customer_post_reads == 2_000
    assert limits.threads_rolling_24h_reserve == 1_500
    assert limits.threads_rolling_24h_platform == 2_200
    assert limits.threads_rolling_24h_reserve < limits.threads_rolling_24h_platform
    overridden = load_limits(Path("config/limits.json"), {"X_MONTHLY_GLOBAL_POST_READS": "100"})
    assert overridden.x_monthly_global_post_reads == 100


def test_x_customer_cap_reads_postgres_and_does_not_fetch():
    conn = ScriptedConn(customer_posts=2_000, global_posts=10)
    limits = load_limits(Path("config/limits.json"), {})
    result = admit_x_read(conn, "11111111-1111-4111-8111-111111111111", 10, limits)
    assert result.detail == "x_customer_cap"
    assert result.fetched_count is None
    assert "for update" in conn.statements[0].lower()
    assert "x_read_counters" in conn.statements[0]
    assert "api.x.com" not in "\n".join(conn.statements)


def test_x_global_cap_reads_postgres_and_does_not_fetch():
    conn = ScriptedConn(customer_posts=0, global_posts=20_000)
    limits = load_limits(Path("config/limits.json"), {})
    result = admit_x_read(conn, "11111111-1111-4111-8111-111111111111", 10, limits)
    assert result.detail == "x_global_cap"
    joined = "\n".join(conn.statements).lower()
    assert "date_trunc('month'" in joined
    assert "for update" in joined


def test_threads_guard_stops_at_the_reserve_before_the_query():
    limits = load_limits(Path("config/limits.json"), {})
    blocked = ScriptedConn(threads_used=1_500)
    calls = []
    result = run_threads(blocked, limits, fetch=lambda: calls.append("threads"))
    assert result.detail == "threads_budget"
    assert result.fetched_count is None
    assert calls == []
    assert "interval '24 hours'" in blocked.statements[0]
    assert not any("insert into threads_query_log" in sql.lower() for sql in blocked.statements)
    allowed = ScriptedConn(threads_used=1_499)
    ran = run_threads(allowed, limits, fetch=lambda: calls.append("threads") or "sent")
    assert calls == ["threads"]
    assert ran == "sent"
    assert any("insert into threads_query_log" in sql.lower() for sql in allowed.statements)


def test_usage_tables_are_forced_rls():
    sql = Path("apps/web/src/db/sql/003_usage_caps.sql").read_text(encoding="utf-8")
    assert "x_read_counters" in sql
    assert "threads_query_log" in sql
    assert sql.lower().count("force row level security") >= 2
    assert "grant select on x_read_counters to app_user" in sql.lower()
    assert "threads_query_log to app_user" not in sql.lower()
