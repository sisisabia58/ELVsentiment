"""Scheduler claim and tenant isolation against a real Postgres 16 server.

Skipped unless POSTGRES_TEST_URL is set. Every connection, including schema
setup, uses that URL. The test creates and drops database sm_pg16 on that
server. Example: postgresql://ubuntu@/postgres
"""

import hashlib
import os
import subprocess
from datetime import timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

from sentiment_monitor.scheduler import CLAIM_SQL, ENQUEUE_SQL, EXPIRE_CLAIMS_SQL, next_daily_run_at

SQL_DIR = Path(__file__).resolve().parents[2] / "web" / "src" / "db" / "sql"
CUSTOMER_A = "11111111-1111-4111-8111-111111111111"
CUSTOMER_B = "22222222-2222-4222-8222-222222222222"
PROJECT_A = "33333333-3333-4333-8333-333333333333"
JOB_A = "44444444-4444-4444-8444-444444444444"
JOB_B = "55555555-5555-4555-8555-555555555555"
JOB_OLD = "66666666-6666-4666-8666-666666666666"
JOB_FRESH = "77777777-7777-4777-8777-777777777777"


def _admin_url() -> str:
    url = os.environ.get("POSTGRES_TEST_URL", "")
    if not url:
        pytest.skip("POSTGRES_TEST_URL is not set")
    return url


def _db_url(dbname: str) -> str:
    parts = urlsplit(_admin_url())
    return urlunsplit((parts.scheme, parts.netloc, f"/{dbname}", parts.query, parts.fragment))


def _apply_schema(dbname: str) -> None:
    url = _db_url(dbname)
    for path in sorted(SQL_DIR.glob("*.sql")):
        subprocess.run(
            ["psql", url, "-v", "ON_ERROR_STOP=1", "-f", str(path)],
            check=True,
            capture_output=True,
            text=True,
        )


@pytest.fixture
def pg16():
    admin = psycopg.connect(_admin_url(), autocommit=True)
    version = admin.execute("show server_version_num").fetchone()[0]
    if int(version) // 10000 != 16:
        pytest.skip(f"need Postgres 16, connected to {version}")
    admin.execute(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'sm_pg16' and pid <> pg_backend_pid()"
    )
    admin.execute("drop database if exists sm_pg16")
    admin.execute("drop role if exists app_user")
    admin.execute("drop role if exists worker_role")
    admin.execute("create database sm_pg16")
    _apply_schema("sm_pg16")
    conn = psycopg.connect(_db_url("sm_pg16"))
    try:
        yield conn
    finally:
        conn.close()
        admin.execute(
            "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'sm_pg16' and pid <> pg_backend_pid()"
        )
        admin.execute("drop database if exists sm_pg16")
        admin.execute("drop role if exists app_user")
        admin.execute("drop role if exists worker_role")
        admin.close()


def _seed(conn) -> None:
    conn.execute("begin")
    for customer_id in (CUSTOMER_A, CUSTOMER_B):
        conn.execute(
            "insert into customers (id, customer_id, created_at) values (%s, %s, now())",
            (customer_id, customer_id),
        )
    conn.execute(
        "insert into projects (id, customer_id, brand_name, created_at) values (%s, %s, %s, now())",
        (PROJECT_A, CUSTOMER_A, "ayam geprek pak gembus"),
    )
    for job_id, customer_id in ((JOB_A, CUSTOMER_A), (JOB_B, CUSTOMER_B)):
        conn.execute(
            """
            insert into jobs (id, customer_id, project_id, kind, status, run_after, created_at)
            values (%s, %s, %s, 'manual', 'queued', now(), now())
            """,
            (job_id, customer_id, PROJECT_A),
        )
    conn.execute(
        """
        insert into jobs (id, customer_id, project_id, kind, status, run_after, claimed_at, created_at)
        values (%s, %s, %s, 'manual', 'claimed', now(), now() - interval '2 minutes', now())
        """,
        (JOB_OLD, CUSTOMER_A, PROJECT_A),
    )
    conn.execute(
        """
        insert into jobs (id, customer_id, project_id, kind, status, run_after, claimed_at, created_at)
        values (%s, %s, %s, 'manual', 'claimed', now(), now(), now())
        """,
        (JOB_FRESH, CUSTOMER_A, PROJECT_A),
    )
    conn.commit()


def test_postgres16_rls_tenant_a_cannot_read_tenant_b(pg16):
    conn = pg16
    version = conn.execute("show server_version").fetchone()[0]
    assert version.startswith("16.")
    owner = conn.execute(
        """
        select c.relforcerowsecurity, r.rolname, r.rolsuper, r.rolbypassrls
        from pg_class c
        join pg_roles r on r.oid = c.relowner
        where c.relname = 'projects'
        """
    ).fetchone()
    assert owner[0] is True
    assert owner[1] not in ("app_user", "worker_role")
    roles = conn.execute(
        """
        select rolname, rolsuper, rolbypassrls
        from pg_roles
        where rolname in ('app_user', 'worker_role')
        order by rolname
        """
    ).fetchall()
    assert roles == [("app_user", False, False), ("worker_role", False, False)]

    _seed(conn)

    def visible_projects(customer_id):
        conn.execute("begin")
        conn.execute("select set_config('app.customer_id', %s::text, true)", (str(customer_id),))
        conn.execute("set local role app_user")
        rows = conn.execute("select id from projects").fetchall()
        conn.rollback()
        return rows

    assert visible_projects(CUSTOMER_B) == []
    assert [str(row[0]) for row in visible_projects(CUSTOMER_A)] == [PROJECT_A]

    user_id = "88888888-8888-4888-8888-888888888888"
    token_hash = hashlib.sha256(b"owner-session").hexdigest()
    conn.execute(
        "insert into users (id, customer_id, email, password_hash, created_at) values (%s, %s, %s, %s, now())",
        (user_id, CUSTOMER_A, "owner@example.com", "hash"),
    )
    conn.execute(
        "insert into sessions (id, customer_id, user_id, token_hash, expires_at) values (%s, %s, %s, %s, now() + interval '1 day')",
        ("99999999-9999-4999-8999-999999999999", CUSTOMER_A, user_id, token_hash),
    )
    conn.commit()
    conn.execute("begin")
    conn.execute("select set_config('app.session_token_hash', %s, true)", (token_hash,))
    conn.execute(
        "select set_config('app.customer_id', '00000000-0000-0000-0000-000000000000', true)"
    )
    conn.execute("set local role app_user")
    session_customer = conn.execute("select customer_id::text from sessions").fetchone()
    conn.rollback()
    assert session_customer == (CUSTOMER_A,)


def test_postgres16_skip_locked_two_workers_cannot_claim_the_same_job(pg16):
    conn = pg16
    _seed(conn)
    first = psycopg.connect(_db_url("sm_pg16"))
    second = psycopg.connect(_db_url("sm_pg16"))
    try:
        first.execute("begin")
        first.execute("set local role worker_role")
        locked = first.execute(CLAIM_SQL, (1,)).fetchall()
        assert len(locked) == 1
        second.execute("begin")
        second.execute("set statement_timeout = '3s'")
        second.execute("set local role worker_role")
        skipped = second.execute(CLAIM_SQL, (5,)).fetchall()
        locked_ids = {str(row[0]) for row in locked}
        skipped_ids = {str(row[0]) for row in skipped}
        assert locked_ids.isdisjoint(skipped_ids)
        assert locked_ids | skipped_ids == {JOB_A, JOB_B}
        first.rollback()
        second.rollback()

        first.execute("begin")
        first.execute("set local role worker_role")
        assert first.execute("select pg_try_advisory_xact_lock(hashtext('customer-a'))").fetchone()[0] is True
        second.execute("begin")
        second.execute("set local role worker_role")
        assert second.execute("select pg_try_advisory_xact_lock(hashtext('customer-a'))").fetchone()[0] is False
        first.rollback()
        assert second.execute("select pg_try_advisory_xact_lock(hashtext('customer-a'))").fetchone()[0] is True
        second.rollback()
    finally:
        first.close()
        second.close()

    conn.execute("begin")
    conn.execute("set local role worker_role")
    conn.execute(EXPIRE_CLAIMS_SQL, (90,))
    conn.commit()
    expired = conn.execute("select status, status_detail from jobs where id = %s", (JOB_OLD,)).fetchone()
    fresh = conn.execute("select status, status_detail from jobs where id = %s", (JOB_FRESH,)).fetchone()
    assert expired == ("failed", "claim_expired")
    assert fresh[0] == "claimed"
    assert fresh[1] is None


def test_postgres16_daily_wib_minute_and_overlap_skip(pg16):
    conn = pg16
    _seed(conn)
    clock = conn.execute(
        """
        select now() as now,
               ((extract(hour from timezone('Asia/Jakarta', now()))::int * 60
                 + extract(minute from timezone('Asia/Jakarta', now()))::int
                 - 30 + 1440) % 1440)::int as daily_minute
        """
    ).fetchone()
    now, daily_minute = clock[0], int(clock[1])
    daily_project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    overlap_project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    manual_job = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    conn.execute(
        "insert into projects (id, customer_id, brand_name, created_at) values (%s, %s, %s, now()), (%s, %s, %s, now())",
        (daily_project, CUSTOMER_A, "harian", overlap_project, CUSTOMER_A, "tumpang"),
    )
    conn.execute(
        """
        insert into project_schedules
          (project_id, customer_id, enabled, interval_hours, time_zone, next_run_at, cadence, daily_minute)
        values (%s, %s, true, 24, 'Asia/Jakarta', now() - interval '1 minute', 'daily', %s)
        """,
        (daily_project, CUSTOMER_A, daily_minute),
    )
    conn.execute(
        """
        insert into project_schedules
          (project_id, customer_id, enabled, interval_hours, time_zone, next_run_at, cadence)
        values (%s, %s, true, 6, 'Asia/Jakarta', now() - interval '1 minute', 'interval')
        """,
        (overlap_project, CUSTOMER_A),
    )
    conn.execute(
        """
        insert into jobs (id, customer_id, project_id, kind, status, run_after, claimed_at, created_at)
        values (%s, %s, %s, 'manual', 'claimed', now(), now(), now())
        """,
        (manual_job, CUSTOMER_A, overlap_project),
    )
    conn.execute(
        """
        insert into project_settings (project_id, customer_id, source_filter, enabled_sources)
        values (%s, %s, 'all', array['threads']::text[])
        """,
        (daily_project, CUSTOMER_A),
    )
    conn.commit()

    conn.execute("begin")
    conn.execute("set local role worker_role")
    visible = conn.execute(
        "select enabled_sources from project_settings where project_id = %s",
        (daily_project,),
    ).fetchone()
    assert list(visible[0]) == ["threads"]
    conn.execute(ENQUEUE_SQL)
    conn.commit()

    daily = conn.execute(
        "select next_run_at from project_schedules where project_id = %s",
        (daily_project,),
    ).fetchone()
    daily_job = conn.execute(
        "select status, status_detail from jobs where project_id = %s and kind = 'scheduled'",
        (daily_project,),
    ).fetchone()
    expected = next_daily_run_at(daily_minute, now.astimezone(timezone.utc))
    assert daily_job == ("queued", None)
    assert abs((daily[0] - expected).total_seconds()) < 2
    assert abs((daily[0] - (now + timedelta(hours=24))).total_seconds()) > 60

    overlap = conn.execute(
        "select status, status_detail from jobs where project_id = %s and kind = 'scheduled'",
        (overlap_project,),
    ).fetchone()
    advanced = conn.execute(
        "select next_run_at > now() from project_schedules where project_id = %s",
        (overlap_project,),
    ).fetchone()
    assert overlap == ("deferred", "skipped_overlap")
    assert advanced[0] is True


def test_migration_009_scrapecreators_sources_sql_exists_and_expands_source_constraints():
    migration_path = SQL_DIR / "009_scrapecreators_sources.sql"
    assert migration_path.is_file(), "009_scrapecreators_sources.sql must exist"
    sql = migration_path.read_text(encoding="utf-8").lower()
    for constraint in (
        "mentions_source_check",
        "source_status_source_check",
        "source_cursors_source_check",
        "project_settings_enabled_sources_check",
    ):
        assert f"drop constraint if exists {constraint}" in sql
        assert f"add constraint {constraint}" in sql
    for source in ("'x'", "'threads'", "'instagram'", "'tiktok'"):
        assert source in sql
    assert "alter table project_settings alter column enabled_sources" in sql
    assert "set default array['x', 'threads', 'instagram', 'tiktok']" in sql


def test_postgres16_scrapecreators_sources_constraints(pg16):
    conn = pg16
    _seed(conn)
    conn.execute("begin")
    conn.execute(
        """
        insert into project_settings (project_id, customer_id, source_filter, enabled_sources)
        values (%s, %s, 'all', array['x', 'threads', 'instagram', 'tiktok']::text[])
        """,
        (PROJECT_A, CUSTOMER_A),
    )
    for idx, source in enumerate(("instagram", "tiktok"), start=1):
        conn.execute(
            """
            insert into mentions (
              id, customer_id, project_id, source, external_id, excerpt,
              posted_at, collected_at, matched_variants, scoring_status
            )
            values (%s, %s, %s, %s, %s, 'uji', now(), now(), array['geprek']::text[], 'pending')
            """,
            (f"dddddddd-dddd-4ddd-8ddd-ddddddddddd{idx}", CUSTOMER_A, PROJECT_A, source, f"ext-{source}"),
        )
        conn.execute(
            """
            insert into source_status (customer_id, project_id, source, state, detail, updated_at)
            values (%s, %s, %s, 'ready', 'ok', now())
            """,
            (CUSTOMER_A, PROJECT_A, source),
        )
        conn.execute(
            """
            insert into source_cursors (customer_id, query_key, source)
            values (%s, %s, %s)
            """,
            (CUSTOMER_A, f"qk-{source}", source),
        )
    conn.commit()
    enabled = conn.execute(
        "select enabled_sources from project_settings where project_id = %s",
        (PROJECT_A,),
    ).fetchone()
    assert list(enabled[0]) == ["x", "threads", "instagram", "tiktok"]



def test_migration_010_grants_only_worker_source_status_dml():
    path = SQL_DIR / "010_source_status_worker.sql"
    assert path.is_file(), "010_source_status_worker.sql must exist"
    sql = path.read_text(encoding="utf-8").lower()
    grants = [line for line in sql.splitlines() if line.startswith("grant")]
    assert grants == ["grant select, insert, update on source_status to worker_role;"]
    for policy in (
        "source_status_worker_select",
        "source_status_worker_insert",
        "source_status_worker_update",
    ):
        assert f"create policy {policy} on source_status" in sql
    assert "for delete" not in sql


def test_postgres16_migration_010_worker_status_permissions_and_tenant_isolation(pg16):
    conn = pg16
    _seed(conn)
    privileges = conn.execute(
        """
        select has_table_privilege('worker_role', 'public.source_status', 'select'),
               has_table_privilege('worker_role', 'public.source_status', 'insert'),
               has_table_privilege('worker_role', 'public.source_status', 'update'),
               has_table_privilege('worker_role', 'public.source_status', 'delete'),
               has_table_privilege('app_user', 'public.source_status', 'delete')
        """
    ).fetchone()
    assert privileges == (True, True, True, False, True)

    policies = dict(
        conn.execute(
            "select polname, polcmd from pg_policy where polrelid = 'public.source_status'::regclass"
        ).fetchall()
    )
    assert policies["source_status_worker_select"] == "r"
    assert policies["source_status_worker_insert"] == "a"
    assert policies["source_status_worker_update"] == "w"
    assert "source_status_worker_delete" not in policies

    project_b = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    conn.execute(
        "insert into projects (id, customer_id, brand_name, created_at) values (%s, %s, %s, now())",
        (project_b, CUSTOMER_B, "tenant b"),
    )
    conn.commit()

    conn.execute("begin")
    conn.execute("set local role worker_role")
    conn.execute(
        """
        insert into source_status (customer_id, project_id, source, state, detail, updated_at)
        values (%s, %s, 'threads', 'ready', 'ok', now()),
               (%s, %s, 'threads', 'unavailable', 'threads_http_500', now())
        on conflict (customer_id, project_id, source) do update
          set state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at
        """,
        (CUSTOMER_A, PROJECT_A, CUSTOMER_B, project_b),
    )
    assert conn.execute("select count(*) from source_status").fetchone() == (2,)
    conn.commit()

    conn.execute("begin")
    conn.execute("set local role worker_role")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("delete from source_status")
    conn.rollback()

    conn.execute("begin")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_A,))
    conn.execute("set local role app_user")
    visible = conn.execute("select customer_id::text from source_status").fetchall()
    assert visible == [(CUSTOMER_A,)]
    conn.rollback()

    roles = dict(
        conn.execute(
            "select rolname, rolsuper or rolbypassrls from pg_roles where rolname in ('app_user','worker_role')"
        ).fetchall()
    )
    assert roles == {"app_user": False, "worker_role": False}


def test_postgres16_mention_write_returns_real_inserted_count_and_rolls_back_on_failure(pg16):
    from sentiment_monitor.pg_store import PostgresStore
    from sentiment_monitor.scheduler import CursorRowAdapter

    conn = pg16
    _seed(conn)
    conn.execute("begin")
    conn.execute("set local role worker_role")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_A,))
    store = PostgresStore(CursorRowAdapter(conn))
    mention = {
        "external_id": "dedup-1",
        "excerpt": "uji",
        "url": None,
        "author": "a",
        "posted_at": "2026-11-01T00:00:00+00:00",
        "variant": "uji",
    }
    assert store.write_mentions_and_cursor(
        customer_id=CUSTOMER_A,
        project_id=PROJECT_A,
        query_key="q",
        source="threads",
        mentions=[mention, mention],
        next_cursor="cursor-1",
    ) == 1
    conn.rollback()

    conn.execute("begin")
    conn.execute("set local role worker_role")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_A,))
    store = PostgresStore(CursorRowAdapter(conn))
    try:
        store.write_mentions_and_cursor(
            customer_id=CUSTOMER_A,
            project_id=PROJECT_A,
            query_key="q",
            source="threads",
            mentions=[mention, {**mention, "source": "threads", "external_id": "bad", "posted_at": "not-a-time"}],
            next_cursor="cursor-2",
        )
    except Exception:
        pass
    conn.rollback()
    assert conn.execute("select count(*) from mentions").fetchone() == (0,)
    assert conn.execute("select count(*) from source_cursors").fetchone() == (0,)


def test_postgres16_worker_status_success_and_failure_preserves_last_success(pg16):
    from sentiment_monitor.scheduler import record_source_failure, record_source_success

    conn = pg16
    _seed(conn)
    conn.execute("begin")
    conn.execute("set local role worker_role")
    record_source_success(conn, CUSTOMER_A, PROJECT_A, "threads")
    conn.commit()
    first = conn.execute(
        "select state, detail, last_success_at is not null from source_status where source = 'threads'"
    ).fetchone()
    assert first == ("ready", "ok", True)

    conn.execute("begin")
    conn.execute("set local role worker_role")
    record_source_failure(conn, CUSTOMER_A, PROJECT_A, "threads", "threads_http_401", "authorization_failed")
    conn.commit()
    second = conn.execute(
        "select state, detail, last_success_at is not null from source_status where source = 'threads'"
    ).fetchone()
    assert second == ("authorization_failed", "threads_http_401", True)


def test_postgres16_top_level_mention_write_commits_and_rolls_back(pg16):
    from sentiment_monitor.pg_store import PostgresStore
    from sentiment_monitor.scheduler import CursorRowAdapter

    conn = pg16
    _seed(conn)
    conn.execute("set role worker_role")
    conn.execute("select set_config('app.customer_id', %s::text, false)", (CUSTOMER_A,))
    conn.commit()
    store = PostgresStore(CursorRowAdapter(conn))
    mention = {
        "external_id": "top-1",
        "excerpt": "uji",
        "url": None,
        "author": "a",
        "posted_at": "2026-11-01T00:00:00+00:00",
        "variant": "uji",
    }
    assert store.write_mentions_and_cursor(
        customer_id=CUSTOMER_A,
        project_id=PROJECT_A,
        query_key="q",
        source="threads",
        mentions=[mention],
        next_cursor="cursor-1",
    ) == 1

    reader = psycopg.connect(_db_url("sm_pg16"))
    try:
        assert reader.execute("select count(*) from mentions").fetchone() == (1,)
        assert reader.execute("select incremental_cursor from source_cursors where query_key = 'q'").fetchone() == (
            "cursor-1",
        )
    finally:
        reader.close()

    try:
        store.write_mentions_and_cursor(
            customer_id=CUSTOMER_A,
            project_id=PROJECT_A,
            query_key="q",
            source="threads",
            mentions=[{**mention, "external_id": "top-2"}, {**mention, "external_id": "top-bad", "posted_at": "bad"}],
            next_cursor="cursor-2",
        )
    except Exception:
        pass

    reader = psycopg.connect(_db_url("sm_pg16"))
    try:
        assert reader.execute("select count(*) from mentions").fetchone() == (1,)
        assert reader.execute("select incremental_cursor from source_cursors where query_key = 'q'").fetchone() == (
            "cursor-1",
        )
    finally:
        reader.close()
