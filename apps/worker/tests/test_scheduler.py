import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import pytest

from sentiment_monitor.backup import describe_backup
from sentiment_monitor.limits import load_limits
from sentiment_monitor.scheduler import (
    _failure_detail,
    claim_due_jobs,
    decide_job,
    enqueue_due_schedules,
    enqueue_due_sql,
    format_log,
    heartbeat_is_stale,
    heartbeat_sql,
    load_active_variants,
    next_daily_run_at,
    serve,
)


@pytest.fixture(autouse=True)
def collection_source_tokens(monkeypatch):
    """Serve tests that approve both files still need non-blank source tokens."""
    monkeypatch.setenv("X_BEARER_TOKEN", "test-x-bearer")
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", "test-threads-token")
    monkeypatch.setenv("SCRAPECREATORS_API_KEY", "test-scrapecreators-key")


class JobLock:
    def __init__(self, queued: int):
        self.jobs = [{"id": f"j{i}", "status": "queued"} for i in range(queued)]
        self.locked = set()

    def connect(self):
        return _ClaimConn(self)


class _ClaimConn:
    def __init__(self, db):
        self.db = db
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        if "for update skip locked" not in sql.lower():
            return []
        limit = params[0]
        rows = []
        for job in self.db.jobs:
            if len(rows) >= limit:
                break
            if job["status"] == "queued" and job["id"] not in self.db.locked:
                self.db.locked.add(job["id"])
                rows.append(job)
        return rows


def test_worker_railway_file_is_one_replica_without_cron():
    text = Path("apps/worker/railway.toml").read_text(encoding="utf-8")
    assert "numReplicas = 1" in text
    assert "python -m sentiment_monitor.scheduler" in text
    assert "cronSchedule" not in text
    web = Path("apps/web/railway.toml").read_text(encoding="utf-8")
    assert "cronSchedule" not in web
    postgres = Path("deploy/postgres-service.txt").read_text(encoding="utf-8")
    assert "image=postgres:16.15" in postgres
    assert "region=asia-southeast1-eqsg3a" in postgres


def test_claim_uses_skip_locked_and_stops_at_five():
    limits = load_limits(Path("config/limits.json"), {})
    assert limits.max_jobs_per_tick == 5
    db = JobLock(queued=6)
    first_conn = db.connect()
    first = claim_due_jobs(first_conn, "worker-1", limits.max_jobs_per_tick)
    assert len(first) == 5
    assert "for update skip locked" in first_conn.statements[0].lower()
    second = claim_due_jobs(db.connect(), "worker-2", limits.max_jobs_per_tick)
    assert [job["id"] for job in second] == ["j5"]
    assert {job["id"] for job in second}.isdisjoint({job["id"] for job in first})


def test_enqueue_reads_stored_schedules():
    sql = enqueue_due_sql().lower()
    assert "project_schedules" in sql
    assert "next_run_at" in sql
    assert "cron" not in sql


class DueScheduleMemory:
    """Applies the one enqueue statement: advance due rows, then insert those jobs."""

    def __init__(self, now, schedules):
        self.now = now
        self.schedules = schedules
        self.jobs = []

    def execute(self, sql, params=None):
        compact = " ".join(sql.lower().split())
        understands = (
            compact.startswith("with due as")
            and "advanced as (" in compact
            and "update project_schedules" in compact
            and "cadence = 'daily'" in compact
            and "daily_minute" in compact
            and "asia/jakarta" in compact
            and "else now() + make_interval(hours => s.interval_hours)" in compact
            and "interval_hours >=" not in compact
            and "next_run_at <= now()" in compact
            and "status in ('queued', 'claimed')" in compact
            and "kind = 'scheduled'" not in compact.split("status in")[0]
            and "skipped_overlap" in compact
            and "insert into jobs" in compact
            and "from advanced" in compact
            and "cron" not in compact
            and "%s" not in sql
        )
        if not understands:
            raise AssertionError("enqueue statement does not advance due schedules")
        due = []
        for schedule in self.schedules:
            overlapping = any(
                job["project_id"] == schedule["project_id"] and job["status"] in ("queued", "claimed")
                for job in self.jobs
            )
            if schedule["enabled"] and schedule["next_run_at"] is not None and schedule["next_run_at"] <= self.now:
                due.append((schedule, overlapping))
        for schedule, overlapping in due:
            if schedule.get("cadence") == "daily" and schedule.get("daily_minute") is not None:
                schedule["next_run_at"] = next_daily_run_at(schedule["daily_minute"], self.now)
            else:
                schedule["next_run_at"] = self.now + timedelta(hours=schedule["interval_hours"])
            self.jobs.append({
                "customer_id": schedule["customer_id"],
                "project_id": schedule["project_id"],
                "kind": "scheduled",
                "status": "deferred" if overlapping else "queued",
                "status_detail": "skipped_overlap" if overlapping else None,
            })
        return None


def test_web_saved_schedule_is_not_skipped_when_worker_env_minimum_is_higher():
    now = datetime(2026, 11, 1, 8, 0, tzinfo=timezone.utc)
    schedule = {
        "project_id": "project-1",
        "customer_id": "customer-a",
        "enabled": True,
        "interval_hours": 6,
        "next_run_at": now - timedelta(hours=1),
    }
    db = DueScheduleMemory(now, [schedule])
    limits = load_limits(Path("config/limits.json"), {"SCHEDULE_MIN_INTERVAL_HOURS": "24"})
    assert limits.schedule_min_interval_hours == 24
    enqueue_due_schedules(db, limits)
    assert len(db.jobs) == 1
    assert db.jobs[0]["project_id"] == "project-1"


def test_due_schedule_advances_and_the_next_poll_inserts_nothing():
    now = datetime(2026, 11, 1, 8, 0, tzinfo=timezone.utc)
    schedule = {
        "project_id": "project-1",
        "customer_id": "customer-a",
        "enabled": True,
        "interval_hours": 12,
        "next_run_at": now - timedelta(hours=3),
    }
    db = DueScheduleMemory(now, [schedule])
    limits = load_limits(Path("config/limits.json"), {})
    assert schedule["interval_hours"] != limits.schedule_min_interval_hours

    enqueue_due_schedules(db, limits)

    assert len(db.jobs) == 1
    assert db.jobs[0]["kind"] == "scheduled"
    assert db.jobs[0]["status"] == "queued"
    assert db.jobs[0]["project_id"] == "project-1"
    assert schedule["next_run_at"] == now + timedelta(hours=12)
    db.jobs[0]["status"] = "succeeded"
    enqueue_due_schedules(db, limits)
    assert len(db.jobs) == 1
    assert "cron" not in enqueue_due_sql().lower()


def test_daily_wib_minute_does_not_drift_when_the_tick_is_late():
    # 08:05 WIB on 1 Nov 2026. A 24-hour interval would land at 08:05 the next day.
    now = datetime(2026, 11, 1, 1, 5, tzinfo=timezone.utc)
    assert next_daily_run_at(8 * 60, now) == datetime(2026, 11, 2, 1, 0, tzinfo=timezone.utc)
    schedule = {
        "project_id": "project-1",
        "customer_id": "customer-a",
        "enabled": True,
        "interval_hours": 24,
        "cadence": "daily",
        "daily_minute": 8 * 60,
        "next_run_at": datetime(2026, 11, 1, 1, 0, tzinfo=timezone.utc),
    }
    db = DueScheduleMemory(now, [schedule])
    enqueue_due_schedules(db, load_limits(Path("config/limits.json"), {}))
    assert schedule["next_run_at"] == datetime(2026, 11, 2, 1, 0, tzinfo=timezone.utc)
    assert schedule["next_run_at"] != now + timedelta(hours=24)
    assert db.jobs[0]["status"] == "queued"
    assert db.jobs[0]["status_detail"] is None


def test_due_schedule_overlapping_any_active_job_is_skipped_and_recorded():
    now = datetime(2026, 11, 1, 8, 0, tzinfo=timezone.utc)
    schedule = {
        "project_id": "project-1",
        "customer_id": "customer-a",
        "enabled": True,
        "interval_hours": 6,
        "cadence": "interval",
        "next_run_at": now - timedelta(minutes=1),
    }
    db = DueScheduleMemory(now, [schedule])
    db.jobs.append({
        "customer_id": "customer-a",
        "project_id": "project-1",
        "kind": "manual",
        "status": "claimed",
        "status_detail": None,
    })
    enqueue_due_schedules(db, load_limits(Path("config/limits.json"), {}))
    assert schedule["next_run_at"] == now + timedelta(hours=6)
    skipped = [job for job in db.jobs if job["kind"] == "scheduled"]
    assert skipped == [{
        "customer_id": "customer-a",
        "project_id": "project-1",
        "kind": "scheduled",
        "status": "deferred",
        "status_detail": "skipped_overlap",
    }]
    enqueue_due_schedules(db, load_limits(Path("config/limits.json"), {}))
    assert len([job for job in db.jobs if job["kind"] == "scheduled"]) == 1


def test_heartbeat_row_and_stale_rule():
    assert "worker_heartbeat" in heartbeat_sql()
    assert "on conflict (id)" in heartbeat_sql().lower()
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert heartbeat_is_stale(None, now, 90) is True
    assert heartbeat_is_stale(now - timedelta(seconds=60), now, 90) is False
    assert heartbeat_is_stale(now - timedelta(seconds=91), now, 90) is True


def test_poll_outside_15_to_30_is_rejected():
    assert load_limits(Path("config/limits.json"), {}).worker_poll_seconds == 20
    with pytest.raises(ValueError):
        load_limits(Path("config/limits.json"), {"WORKER_POLL_SECONDS": "5"})


def test_a_project_that_turned_off_x_does_not_fetch_x(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    fetched = {"x": 0, "threads": 0}

    def fetch_x(*_args, **_kwargs):
        fetched["x"] += 1
        raise AssertionError("x is not an enabled source")

    def fetch_threads(_variant):
        fetched["threads"] += 1
        return [], None

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            fetch_x,
            fetch_threads,
        )
    assert fetched == {"x": 0, "threads": 1}


def test_unapproved_gate_defers_the_job():
    assert decide_job(2) == ("deferred", "credential_unapproved")
    assert decide_job(0) is None


def test_backup_is_not_built():
    assert describe_backup("") == {
        "built": False,
        "status": "not_built",
        "cadence": "nightly",
        "destination": "",
        "command": ["pg_dump", "--format=custom", "--no-owner", "--dbname", "$DATABASE_URL"],
    }
    assert describe_backup("memory://later")["built"] is False
    backup_source = Path("apps/worker/sentiment_monitor/backup.py").read_text(encoding="utf-8")
    scheduler_source = Path("apps/worker/sentiment_monitor/scheduler.py").read_text(encoding="utf-8")
    assert "subprocess" not in backup_source
    assert "pg_dump" not in scheduler_source


def test_format_log_redacts_a_password_that_appears_only_inside_a_url(monkeypatch):
    monkeypatch.delenv("WORKER_DB_PASSWORD", raising=False)
    monkeypatch.setenv(
        "WORKER_DATABASE_URL",
        "postgres://worker_role:only-in-url@db.internal:5432/postgres",
    )
    line = format_log("authentication failed password only-in-url")
    assert "only-in-url" not in line
    assert line == "authentication failed password [redacted]"


def test_format_log_redacts_secrets(monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "super-secret-token")
    monkeypatch.setenv("DATABASE_URL", "postgres://app_user:secret-pass@postgres.railway.internal:5432/db")
    line = format_log(
        "failed super-secret-token postgres://app_user:secret-pass@postgres.railway.internal:5432/db"
    )
    assert "super-secret-token" not in line
    assert "secret-pass" not in line
    assert "[redacted]" in line


def test_format_log_redacts_percent_encoded_secrets(monkeypatch):
    token = "tok+en/sec=ret"
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", token)
    quoted = quote(token, safe="")
    assert "+" in token and "/" in token and "=" in token
    assert quoted != token
    line = format_log(f"raw {token} quoted {quoted}")
    assert token not in line
    assert quoted not in line
    assert line == "raw [redacted] quoted [redacted]"


def test_format_log_redacts_app_db_password():
    names = {
        "MIGRATION_DATABASE_URL": "postgres://migrator:mig-secret@db/postgres",
        "APP_DB_PASSWORD": "app-secret-not-for-logs",
        "WORKER_DB_PASSWORD": "worker-secret-not-for-logs",
    }
    previous = {name: os.environ.get(name) for name in names}
    os.environ.update(names)
    try:
        line = format_log(
            "password app-secret-not-for-logs leaked "
            "worker-secret-not-for-logs "
            "postgres://migrator:mig-secret@db/postgres"
        )
        assert "app-secret-not-for-logs" not in line
        assert "worker-secret-not-for-logs" not in line
        assert "mig-secret" not in line
        assert line == "password [redacted] leaked [redacted] [redacted]"
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def test_harken_pin_is_unchanged_and_sqlite_is_not_imported():
    pyproject = Path("apps/worker/pyproject.toml").read_text(encoding="utf-8")
    assert "d0710a427dbbe712594ef3a6c25112e1d14cc027" in pyproject
    assert "github.com/VladUZH/harken.git" in pyproject
    source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in Path("apps/worker/sentiment_monitor").rglob("*.py")
    )
    assert "harken.store" not in source
    assert "sqlite3" not in source
    assert "harken.db" not in source


class LoopWorld:
    def __init__(self, jobs, variants, cursor):
        self.jobs = jobs
        self.variants = variants
        self.cursor = cursor
        self.calls = []

    def connect(self):
        return _LoopConn(self)


class _LoopConn:
    def __init__(self, world):
        self.world = world

    def execute(self, sql, params=None):
        self.world.calls.append((sql, params))
        lowered = " ".join(sql.lower().split())
        if "for update skip locked" in lowered:
            rows = []
            for job in self.world.jobs:
                if job.get("status") != "queued":
                    continue
                job["status"] = "claimed"
                rows.append(dict(job))
                if params and len(rows) >= params[0]:
                    break
            return rows
        if "from keyword_variants" in lowered:
            return [{"text": text} for text in self.world.variants]
        if "from project_settings" in lowered:
            return [{"enabled_sources": list(getattr(self.world, "sources", ["x", "threads"]))}]
        if "from source_cursors" in lowered and lowered.startswith("select"):
            return {
                "incremental_cursor": self.world.cursor,
                "incremental_since": getattr(self.world, "since", None),
                "backfill_cursor": None,
                "last_success_at": None,
                "last_error": None,
            }
        if "from x_read_counters" in lowered and "for update" in lowered:
            return 0
        if "from threads_query_log" in lowered and "count" in lowered:
            return 0
        return None

    def commit(self):
        self.world.calls.append(("COMMIT", None))

    def rollback(self):
        self.world.calls.append(("ROLLBACK", None))

    def close(self):
        return None


def _policy_root(tmp_path, approved):
    config = tmp_path / "config"
    config.mkdir()
    flag = "true" if approved else "false"
    (config / "credential-policy.json").write_text(
        '{"approved": %s, "mode": "shared_operator"}' % flag, encoding="utf-8"
    )
    (config / "x-budget.json").write_text('{"approved": %s}' % flag, encoding="utf-8")
    return tmp_path


def _due_job():
    return {
        "id": "job-1",
        "customer_id": "customer-a",
        "project_id": "project-1",
        "kind": "manual",
        "status": "queued",
    }


def test_x_incremental_fetch_starts_after_the_newest_seen_id(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor="100")
    world.since = datetime(2026, 10, 28, 0, 0, tzinfo=timezone.utc)
    seen = []

    def fetch_x(variant, limit, cursor, since=None, since_id=None):
        seen.append({"variant": variant, "limit": limit, "cursor": cursor, "since": since, "since_id": since_id})
        if cursor is None:
            return (
                [{
                    "external_id": "250",
                    "excerpt": "baru",
                    "url": "https://x.com/i/status/250",
                    "author": "ani",
                    "posted_at": "2026-11-01T02:00:00+00:00",
                    "variant": variant,
                }],
                "older-page-token",
            )
        return (
            [{
                "external_id": "100",
                "excerpt": "lama",
                "url": "https://x.com/i/status/100",
                "author": "ani",
                "posted_at": "2026-10-28T00:00:00+00:00",
                "variant": variant,
            }],
            "even-older",
        )

    def stop(_seconds):
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(world.connect, stop, limits, "worker-1", _policy_root(tmp_path, True), fetch_x, lambda _variant: ([], None))

    assert seen[0]["cursor"] is None
    assert seen[0]["since_id"] == "100"
    assert seen[0]["since"] == world.since
    assert seen[1]["cursor"] == "older-page-token"
    assert seen[1]["since_id"] == "100"
    assert all(call["cursor"] != "even-older" for call in seen)
    x_writes = [
        params
        for sql, params in world.calls
        if "insert into source_cursors" in sql and params and params[2] == "x"
    ]
    assert x_writes
    assert "250" in x_writes[0]
    assert "older-page-token" not in x_writes[0]
    assert "even-older" not in x_writes[0]


class _ThreadsCappedConn(_LoopConn):
    def execute(self, sql, params=None):
        lowered = " ".join(sql.lower().split())
        if "from threads_query_log" in lowered and "count" in lowered:
            self.world.calls.append((sql, params))
            return 1500
        return super().execute(sql, params)


def test_log_redacts_scrapecreators_api_key() -> None:
    env = {
        "SCRAPECREATORS_API_KEY": "sc-super-secret",
        "X_BEARER_TOKEN": "x-secret-value",
    }

    line = format_log(
        "collection_failed",
        detail="token sc-super-secret failed",
        env=env,
        job_id="job-1",
    )

    assert "sc-super-secret" not in line
    assert "[REDACTED]" in line


def test_serve_collects_threads_instagram_and_tiktok_without_threads_reserve_cap(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads", "instagram", "tiktok"]
    fetched = []

    def connect():
        return _ThreadsCappedConn(world)

    def stop(_seconds):
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            connect,
            stop,
            limits,
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: fetched.append("x") or ([], None),
            lambda variant: fetched.append(("threads", variant)) or ([{"external_id": "t1", "excerpt": "t", "url": "https://threads.com/t1", "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": variant}], None),
            fetch_instagram=lambda variant: fetched.append(("instagram", variant)) or ([{"external_id": "ig1", "excerpt": "ig", "url": "https://instagram.com/p/ig1", "author": "b", "posted_at": "2026-11-01T00:00:00Z", "variant": variant}], None),
            fetch_tiktok=lambda variant: fetched.append(("tiktok", variant)) or ([{"external_id": "tt1", "excerpt": "tt", "url": "https://tiktok.com/@c/video/tt1", "author": "c", "posted_at": "2026-11-01T00:00:00Z", "variant": variant}], None),
        )

    assert fetched == [
        ("threads", "geprek gembus"),
        ("instagram", "geprek gembus"),
        ("tiktok", "geprek gembus"),
    ]
    joined = "\n".join(sql for sql, _params in world.calls).lower()
    assert "threads_query_log" not in joined
    cursor_sources = [
        params[2]
        for sql, params in world.calls
        if "insert into source_cursors" in sql.lower() and params
    ]
    assert cursor_sources == ["threads", "instagram", "tiktok"]


class _SecondXPageCapped(_LoopConn):
    def execute(self, sql, params=None):
        lowered = " ".join(sql.lower().split())
        if "from x_read_counters" in lowered and "for update" in lowered:
            self.world.calls.append((sql, params))
            self.world.x_reads = getattr(self.world, "x_reads", 0) + 1
            if self.world.x_reads > 2:
                return 2000
            return 0
        return super().execute(sql, params)


def test_x_budget_stop_stores_the_reserved_page_and_keeps_the_floor(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor="100")
    seen = []

    def fetch_x(variant, limit, cursor, since=None, since_id=None):
        seen.append({"cursor": cursor, "since_id": since_id})
        return (
            [{
                "external_id": "250",
                "excerpt": "baru",
                "url": "https://x.com/i/status/250",
                "author": "ani",
                "posted_at": "2026-11-01T02:00:00+00:00",
                "variant": variant,
            }],
            "older-page-token",
        )

    def connect():
        return _SecondXPageCapped(world)

    def stop(_seconds):
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            connect,
            stop,
            limits,
            "worker-1",
            _policy_root(tmp_path, True),
            fetch_x,
            lambda _variant: ([], None),
        )

    assert seen == [{"cursor": None, "since_id": "100"}]
    mention_params = [
        params for sql, params in world.calls if "insert into mentions" in sql and params
    ]
    assert mention_params and "250" in mention_params[0]
    x_writes = [
        params
        for sql, params in world.calls
        if "insert into source_cursors" in sql and params and params[2] == "x"
    ]
    assert x_writes
    assert "100" in x_writes[0]
    assert "250" not in x_writes[0]
    assert "older-page-token" not in x_writes[0]
    assert any(
        params and "x_customer_cap" in params
        for sql, params in world.calls
        if "status = 'deferred'" in sql.lower()
    )
    assert not any("last_collected_at" in sql.lower() for sql, _params in world.calls)


def test_one_pass_reads_the_cursor_and_commits_it_with_the_mentions(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor="cursor-1")
    seen = {}

    def fetch_x(variant, limit, cursor, since=None, since_id=None):
        seen["x"] = (variant, limit, cursor, since, since_id)
        return (
            [{
                "external_id": "100",
                "excerpt": "geprek gembus",
                "url": "https://x.com/i/status/100",
                "author": "ani",
                "posted_at": "2026-11-01T00:00:00+00:00",
                "variant": variant,
            }],
            "cursor-2",
        )

    def fetch_threads(variant):
        seen["threads"] = variant
        return ([], None)

    def stop(seconds):
        seen["slept"] = seconds
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(world.connect, stop, limits, "worker-1", _policy_root(tmp_path, True), fetch_x, fetch_threads)

    assert seen["slept"] == 20
    assert seen["x"] == ("geprek gembus", 10, None, None, None)
    assert seen["threads"] == "geprek gembus"


def test_job_succeeds_only_after_every_variant_is_stored(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus", "ayam geprek"], cursor=None)

    def fetch_x(variant, limit, cursor, since=None, since_id=None):
        return (
            [{
                "external_id": "100" if variant == "geprek gembus" else "200",
                "excerpt": variant,
                "url": "https://x.com/i/status/100",
                "author": "ani",
                "posted_at": "2026-11-01T00:00:00+00:00",
                "variant": variant,
            }],
            None,
        )

    def fetch_threads(variant):
        return ([], None)

    def stop(seconds):
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(world.connect, stop, limits, "worker-1", _policy_root(tmp_path, True), fetch_x, fetch_threads)

    succeeded = [index for index, (sql, _params) in enumerate(world.calls) if "status = 'succeeded'" in sql.lower()]
    mentions = [index for index, (sql, _params) in enumerate(world.calls) if "insert into mentions" in sql.lower()]
    assert len(mentions) == 2
    assert succeeded == [index for index in succeeded if index > mentions[-1]]
    assert len(succeeded) == 1
    sql_text = "\n".join(sql for sql, _params in world.calls)
    assert "worker_heartbeat" in sql_text
    assert "for update skip locked" in sql_text.lower()
    assert "from keyword_variants" in sql_text.lower()
    mention_at = next(i for i, (sql, _params) in enumerate(world.calls) if "insert into mentions" in sql)
    cursor_at = next(
        i for i, (sql, _params) in enumerate(world.calls) if i > mention_at and "insert into source_cursors" in sql
    )
    commit_at = next(i for i, (sql, _params) in enumerate(world.calls) if i > cursor_at and sql == "COMMIT")
    assert mention_at < cursor_at < commit_at
    assert "100" in world.calls[cursor_at][1]
    assert "cursor-2" not in world.calls[cursor_at][1]
    assert "claim_expired" in sql_text
    assert "for update skip locked" in sql_text.lower()
    assert sql_text.lower().count("claim_expired") == 1
    expired_at = next(i for i, (sql, _params) in enumerate(world.calls) if "claim_expired" in sql)
    enqueue_at = next(
        i for i, (sql, _params) in enumerate(world.calls)
        if "insert into jobs" in sql.lower() and "project_schedules" in sql.lower()
    )
    assert expired_at < enqueue_at
    assert [params for sql, params in world.calls if "claim_expired" in sql] == [(90,)]
    collected = [(sql, params) for sql, params in world.calls if "last_collected_at" in sql.lower()]
    assert len(collected) == 1
    assert "next_run_at" not in collected[0][0].lower()
    assert collected[0][1] == ("project-1",)
    grants = Path("apps/web/src/db/sql/002_schedules_jobs.sql").read_text(encoding="utf-8").lower()
    assert "grant select on keyword_variants to worker_role" in grants


def test_unapproved_pass_defers_without_calling_x_or_threads(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    calls = []

    def stop(seconds):
        calls.append(seconds)
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            limits,
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args: calls.append("x"),
            lambda *_args: calls.append("threads"),
        )
    assert calls == [20]
    assert any(params and "credential_unapproved" in params for _sql, params in world.calls)
    assert not any("api.x.com" in sql or "graph.threads.com" in sql for sql, _params in world.calls)
    assert not any("last_collected_at" in sql.lower() for sql, _params in world.calls)


def _idle_clock(sleep_limit):
    """monotonic starts at 0 and jumps by 20 inside each sleep."""
    state = {"now": 0, "sleeps": 0}

    def monotonic():
        return state["now"]

    def sleep(_seconds):
        state["sleeps"] += 1
        state["now"] += 20
        if state["sleeps"] >= sleep_limit:
            raise SystemExit

    return monotonic, sleep, state


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_idle_loop_logs_again_at_180_seconds_by_default(monkeypatch, tmp_path, raw):
    if raw is None:
        monkeypatch.delenv("WORKER_HEARTBEAT_LOG_SECONDS", raising=False)
    else:
        monkeypatch.setenv("WORKER_HEARTBEAT_LOG_SECONDS", raw)
    world = LoopWorld(jobs=[], variants=[], cursor=None)
    lines = []
    times = []
    monotonic, sleep, state = _idle_clock(10)

    def log(line):
        lines.append(line)
        times.append(state["now"])

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            world.connect,
            sleep,
            limits,
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args: ([], None),
            log=log,
            monotonic=monotonic,
        )
    assert state["sleeps"] == 10
    assert lines == [
        "worker heartbeat id=worker-1",
        "worker heartbeat id=worker-1",
    ]
    assert times == [0, 180]


def test_idle_loop_logs_one_heartbeat_across_nine_polls(tmp_path):
    world = LoopWorld(jobs=[], variants=[], cursor=None)
    lines = []
    monotonic, sleep, state = _idle_clock(9)
    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            world.connect,
            sleep,
            limits,
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args: ([], None),
            log=lines.append,
            monotonic=monotonic,
            heartbeat_log_seconds=180,
        )
    assert state["sleeps"] == 9
    assert lines == ["worker heartbeat id=worker-1"]


def test_idle_loop_logs_each_time_the_heartbeat_interval_elapses(tmp_path):
    world = LoopWorld(jobs=[], variants=[], cursor=None)
    lines = []
    monotonic, sleep, state = _idle_clock(2)
    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            world.connect,
            sleep,
            limits,
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args: ([], None),
            log=lines.append,
            monotonic=monotonic,
            heartbeat_log_seconds=20,
        )
    assert state["sleeps"] == 2
    assert lines == [
        "worker heartbeat id=worker-1",
        "worker heartbeat id=worker-1",
    ]


def test_worker_heartbeat_log_seconds_rejects_zero(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKER_HEARTBEAT_LOG_SECONDS", "0")
    world = LoopWorld(jobs=[], variants=[], cursor=None)
    limits = load_limits(Path("config/limits.json"), {})

    def sleep(_seconds):
        raise SystemExit

    with pytest.raises(ValueError, match="WORKER_HEARTBEAT_LOG_SECONDS"):
        serve(
            world.connect,
            sleep,
            limits,
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args: ([], None),
        )


def test_worker_heartbeat_log_seconds_rejects_non_integer(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKER_HEARTBEAT_LOG_SECONDS", "nope")
    world = LoopWorld(jobs=[], variants=[], cursor=None)
    limits = load_limits(Path("config/limits.json"), {})

    def sleep(_seconds):
        raise SystemExit

    with pytest.raises(ValueError, match="^WORKER_HEARTBEAT_LOG_SECONDS$"):
        serve(
            world.connect,
            sleep,
            limits,
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args: ([], None),
        )


class _SecretURL:
    def __init__(self, host):
        self.host = host

    def __str__(self):
        return "URL-STRING-FORM"


def _http_error(message: str, host: str, status: int) -> Exception:
    error = RuntimeError(message)
    error.request = type("Request", (), {"url": _SecretURL(host)})()
    error.response = type("Response", (), {"status_code": status, "request": error.request})()
    return error


def test_failure_detail_reads_the_host_without_stringifying_the_url():
    assert _failure_detail(_http_error("boom", "graph.threads.com", 403)) == "threads_http_403"
    assert _failure_detail(_http_error("boom", "api.x.com", 429)) == "x_http_429"
    assert _failure_detail(_http_error("boom", "API.X.COM", 500)) == "x_http_500"
    assert _failure_detail(_http_error("boom", "example.com", 500)) == "collection_failed"
    assert _failure_detail(RuntimeError("boom")) == "collection_failed"


def test_failure_detail_and_record_source_failure_for_scrapecreators_and_x():
    import urllib.error
    from sentiment_monitor.scheduler import (
        ALL_SOURCES,
        ScrapeCreatorsError,
        load_enabled_sources,
        record_source_failure,
        record_source_success,
        source_failure_state,
    )

    assert ALL_SOURCES == ("x", "threads", "instagram", "tiktok")

    class _FakeConn:
        def __init__(self, rows=None):
            self.rows = rows
            self.calls = []

        def execute(self, sql, params=None):
            self.calls.append((sql, params))
            return self.rows

    assert load_enabled_sources(_FakeConn([]), "p1") == ["x", "threads", "instagram", "tiktok"]
    assert load_enabled_sources(
        _FakeConn([{"enabled_sources": ["threads", "instagram", "tiktok", "unknown"]}]),
        "p1",
    ) == ["threads", "instagram", "tiktok"]

    ig_402 = urllib.error.HTTPError(
        url="https://api.scrapecreators.com/v2/instagram/reels/search?query=a&region=ID",
        code=402,
        msg="Payment Required",
        hdrs=None,
        fp=None,
    )
    x_429 = urllib.error.HTTPError(
        url="https://api.x.com/2/tweets/search/recent?query=a",
        code=429,
        msg="Too Many Requests",
        hdrs=None,
        fp=None,
    )
    assert _failure_detail(ig_402, source="instagram") == "instagram_http_402"
    assert _failure_detail(x_429, source="instagram") == "x_http_429"
    assert _failure_detail(ScrapeCreatorsError("success_false"), source="threads") == "threads_success_false"
    assert (
        _failure_detail(ScrapeCreatorsError("http_402", http_status=402), source="instagram")
        == "instagram_http_402"
    )

    assert source_failure_state("threads_http_401", 401) == "authorization_failed"
    assert source_failure_state("threads_http_403", 403) == "authorization_failed"
    assert source_failure_state("instagram_http_402", 402) == "rate_limited"
    assert source_failure_state("tiktok_http_429", 429) == "rate_limited"
    assert source_failure_state("threads_success_false", None) == "unavailable"
    assert source_failure_state("weird_provider_text_402", None) == "unavailable"

    conn = _FakeConn()
    assert (
        record_source_failure(
            conn, "cust-1", "proj-1", "instagram", "instagram_http_402", "rate_limited"
        )
        == "rate_limited"
    )
    assert (
        record_source_failure(
            conn, "cust-1", "proj-1", "tiktok", "tiktok_http_401", "authorization_failed"
        )
        == "authorization_failed"
    )
    assert (
        record_source_failure(conn, "cust-1", "proj-1", "threads", "threads_http_500", "unavailable")
        == "unavailable"
    )
    record_source_success(conn, "cust-1", "proj-1", "threads")
    assert len(conn.calls) == 4
    failure_sql = " ".join(conn.calls[0][0].lower().split())
    assert "insert into source_status (customer_id, project_id, source, state, detail, updated_at)" in failure_sql
    assert "on conflict (customer_id, project_id, source) do update" in failure_sql
    assert "last_success_at" not in failure_sql
    assert len(conn.calls[0][1]) == 5
    success_sql = " ".join(conn.calls[3][0].lower().split())
    assert "last_success_at = now()" in success_sql
    assert "'ready'" in success_sql
    assert "'ok'" in success_sql


def test_fetch_error_is_redacted_and_marks_the_job_failed(tmp_path, monkeypatch, capfd):
    token = "tok+en/sec=ret"
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", token)
    quoted = quote(token, safe="")
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor="cursor-1")
    world.sources = ["threads"]

    def fetch_threads(variant):
        raise _http_error(f"{token} {quoted}", "graph.threads.com", 401)

    def stop(seconds):
        assert seconds == 20
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            limits,
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args: ([], None),
            fetch_threads,
        )

    captured = capfd.readouterr()
    assert token not in captured.out
    assert quoted not in captured.out
    assert token not in captured.err
    assert quoted not in captured.err
    assert "URL-STRING-FORM" not in captured.out
    assert "URL-STRING-FORM" not in captured.err
    assert "Traceback" not in captured.err
    collection = [
        line
        for line in captured.out.splitlines()
        if line.startswith("source_collection") and "detail=threads_http_401" in line
    ]
    assert len(collection) == 1
    assert "source=threads" in collection[0]
    assert captured.err == ""
    failed = [
        (sql, params)
        for sql, params in world.calls
        if "status = 'failed'" in sql.lower() and "claim_expired" not in sql
    ]
    assert len(failed) == 1
    detail, job_id = failed[0][1]
    assert job_id == "job-1"
    assert detail == "all_sources_failed:threads:geprek%20gembus:threads_http_401"
    assert token not in detail
    assert quoted not in detail
    assert "://" not in detail
    assert "URL-STRING-FORM" not in detail
    assert not any("last_collected_at" in sql.lower() for sql, _params in world.calls)


class _FailUpdateConn(_LoopConn):
    def __init__(self, world, message):
        super().__init__(world)
        self.message = message

    def execute(self, sql, params=None):
        lowered = " ".join(sql.lower().split())
        if "status = 'failed'" in lowered and "claim_expired" not in lowered:
            raise RuntimeError(self.message)
        return super().execute(sql, params)


def test_failed_status_update_is_redacted_and_the_loop_continues(tmp_path, monkeypatch, capfd):
    token = "tok+en/sec=ret"
    monkeypatch.setenv("X_BEARER_TOKEN", token)
    quoted = quote(token, safe="")
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["x"]
    message = f"{token} {quoted}"

    def connect():
        return _FailUpdateConn(world, message)

    def fetch_x(variant, limit, cursor, since=None, since_id=None):
        raise _http_error(message, "api.x.com", 503)

    def stop(seconds):
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            connect,
            stop,
            limits,
            "worker-1",
            _policy_root(tmp_path, True),
            fetch_x,
            lambda *_args: ([], None),
        )

    captured = capfd.readouterr()
    assert captured.err == ""
    assert token not in captured.out
    assert quoted not in captured.out
    assert "URL-STRING-FORM" not in captured.out
    assert "RuntimeError other" in captured.out


def test_fetch_x_with_cursor_keeps_the_harken_cursor(monkeypatch):
    class Page:
        mentions = []
        next_cursor = "cursor-2"

    class Source:
        def __init__(self, bearer_token):
            self.bearer_token = bearer_token

        def fetch_page(self, query, limit=50, *, cursor=None, since=None):
            assert query == "geprek gembus"
            assert cursor == "cursor-1"
            assert limit == 10
            return Page()

    monkeypatch.setattr("sentiment_monitor.collect.XSource", Source)
    from sentiment_monitor.collect import fetch_x_page, fetch_x_with_cursor

    candidates, cursor = fetch_x_with_cursor(
        "geprek gembus", "token", cursor="cursor-1", since=None, limit=10
    )
    assert candidates == []
    assert cursor == "cursor-2"
    assert fetch_x_page("geprek gembus", "token", cursor="cursor-1", since=None, limit=10) == []


class _Cursor:
    def __init__(self, description, one=None, many=None):
        self.description = description
        self._one = one
        self._many = many

    def fetchone(self):
        if self.description is None:
            raise AssertionError("fetchone on a command cursor")
        return self._one

    def fetchall(self):
        if self.description is None:
            raise AssertionError("fetchall on a command cursor")
        return self._many


class _CursorConn:
    """Stands in for psycopg: execute returns a cursor, not a row."""

    def __init__(self):
        self.executed = []
        self.events = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        compact = " ".join(sql.lower().split())
        if compact.startswith("insert") or compact in {"begin", "commit", "rollback"}:
            return _Cursor(None)
        if compact.startswith("select") and "from source_cursors" in compact:
            if params and params[0] == "missing":
                return _Cursor(("incremental_cursor",), one=None, many=[{"incremental_cursor": "nope"}])
            return _Cursor(
                ("incremental_cursor",),
                one={
                    "incremental_cursor": "cursor-1",
                    "backfill_cursor": None,
                    "last_success_at": None,
                    "last_error": None,
                },
                many=[{"incremental_cursor": "from-fetchall"}],
            )
        if "from x_read_counters" in compact and "for update" in compact:
            if params == ("nobody",):
                return _Cursor(("coalesce",), one=None, many=[{"coalesce": 9}])
            return _Cursor(("coalesce",), one={"coalesce": 4}, many=[{"coalesce": 9}])
        if "count" in compact and "from threads_query_log" in compact:
            return _Cursor(("count",), one={"count": 2}, many=[{"count": 9}])
        if "for update skip locked" in compact:
            return _Cursor(
                ("id",),
                one={"id": "from-fetchone"},
                many=[{
                    "id": "job-1",
                    "customer_id": "customer-a",
                    "project_id": "project-1",
                    "kind": "manual",
                }],
            )
        return _Cursor(("set_config",), one={"set_config": "from-fetchone"}, many=[{"set_config": "customer-a"}])

    def commit(self):
        self.events.append("commit")

    def rollback(self):
        self.events.append("rollback")

    def close(self):
        self.events.append("close")

    def transaction(self):
        self.events.append("transaction")
        return _Scope(self)


class _Scope:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        self.conn.events.append("enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.conn.events.append("exit")
        return False


def test_cursor_adapter_maps_psycopg_cursors_onto_the_row_contract():
    from sentiment_monitor.scheduler import CLAIM_SQL, CursorRowAdapter
    from sentiment_monitor.x_cost import THREADS_COUNT_SQL, X_COUNTER_SQL

    inner = _CursorConn()
    conn = CursorRowAdapter(inner)

    claimed = conn.execute(CLAIM_SQL, (5,))
    assert inner.executed[0] == (CLAIM_SQL, (5,))
    assert claimed == [{
        "id": "job-1",
        "customer_id": "customer-a",
        "project_id": "project-1",
        "kind": "manual",
    }]
    assert claimed[0]["id"] == "job-1"

    state = conn.execute(
        """
        select incremental_cursor, backfill_cursor, last_success_at, last_error
        from source_cursors
        where query_key = %s and source = %s
        """,
        ("customer-a:project-1:geprek gembus", "x"),
    )
    assert state == {
        "incremental_cursor": "cursor-1",
        "backfill_cursor": None,
        "last_success_at": None,
        "last_error": None,
    }
    assert state.get("incremental_cursor") == "cursor-1"
    assert conn.execute(
        """
        select incremental_cursor from source_cursors
        where query_key = %s and source = %s
        """,
        ("missing", "x"),
    ) == {}

    used = conn.execute(X_COUNTER_SQL, ("customer-a",))
    assert used == 4
    assert type(used) is int
    assert conn.execute(X_COUNTER_SQL, ("nobody",)) == 0
    assert type(conn.execute(THREADS_COUNT_SQL, ())) is int
    assert conn.execute(THREADS_COUNT_SQL, ()) == 2

    assert conn.execute(
        "insert into mentions (id) values (%s)",
        ("100",),
    ) is None

    conn.commit()
    conn.rollback()
    conn.close()
    with conn.transaction():
        pass
    assert inner.events == ["commit", "rollback", "close", "transaction", "enter", "exit"]

    source = Path("apps/worker/sentiment_monitor/scheduler.py").read_text(encoding="utf-8")
    main = source.split('if __name__ == "__main__":', 1)[1]
    assert "from psycopg.rows import dict_row" in main
    assert "row_factory=dict_row" in main
    assert "autocommit=False" in main
    assert "CursorRowAdapter(" in main
    body = source.split('if __name__ == "__main__":', 1)[0]
    assert "CursorRowAdapter(" not in body


def test_serve_writes_ready_after_success_and_logs_safe_counts(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(variant):
        return {
            "mentions": [
                {"external_id": "1", "excerpt": "aman", "url": None, "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": variant},
                {"external_id": "1", "excerpt": "aman", "url": None, "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": variant},
            ],
            "counts": {"returned": 3, "parsed": 2, "deduplicated": 1},
            "credits_charged": 2,
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
        )

    status = [params for sql, params in world.calls if "insert into source_status" in sql.lower()]
    assert status and status[-1][2] == "threads"
    collection_line = next(line for line in lines if line.startswith("source_collection"))
    assert "job_id=job-1" in collection_line
    assert "project_id=project-1" in collection_line
    assert "source=threads" in collection_line
    assert "returned=3" in collection_line
    assert "parsed=2" in collection_line
    assert "deduplicated=1" in collection_line
    assert "saved=" in collection_line
    assert "credits_charged=2" in collection_line
    assert "geprek" not in collection_line
    assert "aman" not in collection_line


def test_provider_failure_writes_failure_and_fails_with_safe_detail(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]

    def fetch_threads(_variant):
        raise ScrapeCreatorsError("success_false", credits_charged=4)

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
        )

    status_params = [params for sql, params in world.calls if "insert into source_status" in sql.lower()]
    assert status_params == [("customer-a", "project-1", "threads", "unavailable", "threads_success_false")]
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql.lower() and "claim_expired" not in sql.lower()]
    assert failed == [("all_sources_failed:threads:geprek%20gembus:threads_success_false", "job-1")]


def test_status_write_failure_does_not_replace_provider_detail(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    class StatusFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into source_status" in sql.lower():
                raise RuntimeError("status write failed with secret provider text")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]

    def fetch_threads(_variant):
        raise ScrapeCreatorsError("http_401", http_status=401)

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StatusFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
        )

    failed = [params for sql, params in world.calls if "status = 'failed'" in sql.lower() and "claim_expired" not in sql.lower()]
    assert failed == [("all_sources_failed:threads:geprek%20gembus:threads_http_401", "job-1")]


def test_status_write_failure_on_success_keeps_mentions_and_succeeds_the_job(tmp_path):
    class StatusFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into source_status" in sql.lower():
                raise RuntimeError("status write failed")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "aman", "url": None, "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StatusFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
        )

    joined = "\n".join(sql for sql, _params in world.calls).lower()
    mention_at = joined.index("insert into mentions")
    cursor_at = joined.index("insert into source_cursors", mention_at)
    succeeded_at = joined.index("status = 'succeeded'", cursor_at)
    assert mention_at < cursor_at < succeeded_at
    assert any(line.startswith("source_status_write_failed") for line in lines)


def test_storage_failure_does_not_write_source_status(tmp_path):
    class StoreFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into mentions" in sql.lower():
                raise RuntimeError("database unavailable")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]

    def fetch_threads(variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "aman", "url": None, "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StoreFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
        )

    assert not any("insert into source_status" in sql.lower() for sql, _params in world.calls)
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql.lower() and "claim_expired" not in sql.lower()]
    assert failed == [("storage_failed", "job-1")]


def test_safe_error_label_never_prints_raw_provider_text():
    from sentiment_monitor.scheduler import _safe_error_label

    label = _safe_error_label(RuntimeError("keyword rahasia https://api.x.com/?q=rahasia secret-key"))
    assert label == "RuntimeError other"
    assert "rahasia" not in label
    assert "secret-key" not in label


def test_safe_error_label_uses_fixed_allowlists_and_bounds_length():
    from sentiment_monitor.scheduler import _safe_error_label
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    for token in ["private_keyword", "this_is_private_post_text", "abc123", "a" * 500]:
        error = Exception("not emitted")
        error.detail = token
        label = _safe_error_label(error)
        assert token not in label
        assert label == "Exception other"
        assert len(label) <= 64

    assert _safe_error_label(ScrapeCreatorsError("success_false")) == "ScrapeCreatorsError success_false"
    assert _safe_error_label(ScrapeCreatorsError("http_401", http_status=401)) == "ScrapeCreatorsError http_401"
    assert _safe_error_label(RuntimeError("boom")) == "RuntimeError other"

    class MysteryError(Exception):
        pass

    mystery = MysteryError("boom")
    mystery.detail = "success_false"
    assert _safe_error_label(mystery) == "Exception success_false"


def test_status_write_failure_logs_one_safe_structured_line(capsys):
    from sentiment_monitor.scheduler import _record_source_ready

    class Broken:
        def execute(self, *_args, **_kwargs):
            error = RuntimeError("private body")
            error.detail = "private_keyword"
            raise error

        def rollback(self):
            pass

        def close(self):
            pass

    lines = []
    _record_source_ready(
        Broken,
        lines.append,
        {"id": "local-job", "project_id": "local-project", "customer_id": "local-tenant"},
        "threads",
    )
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    assert len(lines) == 1
    assert lines[0].startswith("source_status_write_failed")
    assert "RuntimeError other" in lines[0]
    assert "private_keyword" not in lines[0]


def test_storage_failure_preserves_fetch_counts_and_credits(tmp_path):
    class StoreFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into mentions" in sql.lower():
                raise RuntimeError("synthetic storage failure")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "synthetic", "url": None, "author": None, "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 3, "parsed": 2, "deduplicated": 1},
            "credits_charged": 4,
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StoreFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
        )

    line = next(line for line in lines if line.startswith("source_collection"))
    assert "outcome=storage_failed" in line
    assert "returned=3" in line
    assert "parsed=2" in line
    assert "deduplicated=1" in line
    assert "saved=0" in line
    assert "credits_charged=4" in line
    assert "detail=storage_failed" in line


def test_collection_log_keeps_zero_credit_distinct_from_unknown(tmp_path):
    root = _policy_root(tmp_path, True)
    for credits, expected in ((0, "credits_charged=0"), (None, "credits_charged=-")):
        world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
        world.sources = ["threads"]
        lines = []

        def fetch_threads(variant, credits=credits):
            payload = {
                "mentions": [],
                "counts": {"returned": 0, "parsed": 0, "deduplicated": 0},
            }
            if credits is not None:
                payload["credits_charged"] = credits
            return payload

        def stop(_seconds):
            raise SystemExit

        with pytest.raises(SystemExit):
            serve(
                world.connect,
                stop,
                load_limits(Path("config/limits.json"), {}),
                "worker-1",
                root,
                lambda *_args, **_kwargs: ([], None),
                fetch_threads,
                log=lines.append,
            )

        line = next(line for line in lines if line.startswith("source_collection"))
        assert expected in line


def test_malformed_failure_logs_known_credits_and_counts(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(_variant):
        raise ScrapeCreatorsError(
            "malformed_posts",
            credits_charged=3,
            counts={"returned": 1, "parsed": 1, "deduplicated": 1},
        )

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
        )

    line = next(line for line in lines if line.startswith("source_collection"))
    assert "outcome=failed" in line
    assert "returned=1" in line
    assert "parsed=1" in line
    assert "deduplicated=1" in line
    assert "saved=0" in line
    assert "credits_charged=3" in line
    assert "detail=threads_malformed_posts" in line


def test_partial_multi_endpoint_failure_logs_known_counts_credits_and_status(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["instagram"]
    lines = []

    def fetch_instagram(_variant):
        raise ScrapeCreatorsError(
            "http_500",
            http_status=500,
            credits_charged=3,
            counts={"returned": 2, "parsed": 2, "deduplicated": 0},
        )

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args, **_kwargs: ([], None),
            log=lines.append,
            fetch_instagram=fetch_instagram,
        )

    line = next(line for line in lines if line.startswith("source_collection"))
    assert "outcome=failed" in line
    assert "returned=2" in line
    assert "parsed=2" in line
    assert "deduplicated=0" in line
    assert "saved=0" in line
    assert "http_status=500" in line
    assert "credits_charged=3" in line
    assert "detail=instagram_http_500" in line


def test_status_write_failure_on_provider_failure_logs_one_structured_line(tmp_path, capsys):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    class StatusFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into source_status" in sql.lower():
                error = RuntimeError("private body")
                error.detail = "private_keyword"
                raise error
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(_variant):
        raise ScrapeCreatorsError("http_401", http_status=401)

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StatusFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
        )

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    status_lines = [line for line in lines if line.startswith("source_status_write_failed")]
    assert len(status_lines) == 1
    assert "private_keyword" not in "\n".join(lines)
    assert not any(line.startswith("Exception ") or line.startswith("RuntimeError ") for line in lines)


def test_early_deferral_failure_does_not_crash_serve_and_fails_job(tmp_path):
    class DeferralFail(_LoopConn):
        def execute(self, sql, params=None):
            if "status = 'deferred'" in sql:
                raise RuntimeError("synthetic defer storage failure")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    providers = []

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: DeferralFail(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args, **_kwargs: providers.append("x"),
            lambda *_args, **_kwargs: providers.append("threads"),
            log=lines.append,
        )

    failed = [params for sql, params in world.calls if "status = 'failed'" in sql and "claim_expired" not in sql]
    assert failed == [("storage_failed", "job-1")]
    assert providers == []
    assert not any(line.startswith("source_collection") for line in lines)


def test_budget_and_no_sources_deferrals_emit_no_source_attempt(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["x"]
    lines, providers = [], []

    class BudgetBlock(_LoopConn):
        def execute(self, sql, params=None):
            if "from x_read_counters" in " ".join(sql.lower().split()) and "for update" in sql.lower():
                return 100000
            return super().execute(sql, params)

    def stop(_seconds):
        raise SystemExit

    root = _policy_root(tmp_path, True)
    with pytest.raises(SystemExit):
        serve(
            lambda: BudgetBlock(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            root,
            lambda *_args, **_kwargs: providers.append("x"),
            lambda *_args, **_kwargs: providers.append("threads"),
            log=lines.append,
        )

    assert providers == []
    assert not any(line.startswith("source_collection") for line in lines)
    assert any(params and "x_customer_cap" in params for sql, params in world.calls if "status = 'deferred'" in sql)

    from unittest.mock import patch

    world2 = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines2 = []
    with pytest.raises(SystemExit):
        with patch("sentiment_monitor.scheduler.sources_allowed", return_value=[]):
            serve(
                world2.connect,
                stop,
                load_limits(Path("config/limits.json"), {}),
                "worker-1",
                root,
                lambda *_args, **_kwargs: providers.append("x"),
                lambda *_args, **_kwargs: providers.append("threads"),
                log=lines2.append,
            )
    assert not any(line.startswith("source_collection") for line in lines2)
    assert any(
        params and "sources_unavailable" in params
        for sql, params in world2.calls
        if "status = 'deferred'" in sql
    )


def test_consecutive_jobs_reset_attempt_context(tmp_path):
    job2 = {**_due_job(), "id": "job-2"}
    world = LoopWorld(jobs=[_due_job(), job2], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines, calls = [], {"n": 0}

    def fetch_threads(_variant):
        from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

        calls["n"] += 1
        if calls["n"] == 1:
            raise ScrapeCreatorsError(
                "http_429",
                http_status=429,
                credits_charged=4,
                counts={"returned": 3, "parsed": 2, "deduplicated": 1},
            )
        return {
            "mentions": [{"external_id": "2", "excerpt": "synthetic", "url": None, "author": None,
                          "posted_at": "2026-11-01T00:00:00Z", "variant": "geprek gembus"}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
            "credits_charged": 2,
            "http_status": 200,
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
        )

    collection = [line for line in lines if line.startswith("source_collection")]
    failed = next(line for line in collection if "outcome=failed" in line)
    succeeded = next(line for line in collection if "outcome=success" in line)
    assert "returned=3" in failed and "credits_charged=4" in failed and "http_status=429" in failed
    assert "returned=1" in succeeded and "credits_charged=2" in succeeded and "http_status=200" in succeeded
    assert "returned=3" not in succeeded and "credits_charged=4" not in succeeded


def test_multi_source_multi_variant_resets_attempt_context(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["v1", "v2"], cursor=None)
    world.sources = ["threads", "instagram"]
    lines = []

    def fetch_threads(variant):
        return {
            "mentions": [{"external_id": variant, "excerpt": "synthetic", "url": None, "author": None,
                          "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
            "credits_charged": 2,
            "http_status": 200,
        }

    def fetch_instagram(variant):
        return {
            "mentions": [{"external_id": variant, "excerpt": "synthetic", "url": None, "author": None,
                          "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 2, "parsed": 2, "deduplicated": 0},
            "credits_charged": 3,
            "http_status": 201,
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
            fetch_instagram=fetch_instagram,
        )

    collection = [line for line in lines if line.startswith("source_collection")]
    assert len(collection) == 4
    threads = [line for line in collection if "source=threads" in line]
    instagram = [line for line in collection if "source=instagram" in line]
    assert len(threads) == 2 and len(instagram) == 2
    assert all(
        "returned=1" in line and "credits_charged=2" in line and "http_status=200" in line
        for line in threads
    )
    assert all(
        "returned=2" in line and "credits_charged=3" in line and "http_status=201" in line
        for line in instagram
    )


def test_success_and_storage_failure_logs_carry_known_http_status(tmp_path):
    def fetch_threads(variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "synthetic", "url": None, "author": None,
                          "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
            "credits_charged": 2,
            "http_status": 200,
        }

    def stop(_seconds):
        raise SystemExit

    root = _policy_root(tmp_path, True)
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []
    with pytest.raises(SystemExit):
        serve(world.connect, stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", root,
              lambda *_args, **_kwargs: ([], None), fetch_threads, log=lines.append)
    assert "http_status=200" in next(line for line in lines if line.startswith("source_collection"))

    class StoreFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into mentions" in sql.lower():
                raise RuntimeError("synthetic storage failure")
            return super().execute(sql, params)

    world2 = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world2.sources = ["threads"]
    lines2 = []
    with pytest.raises(SystemExit):
        serve(lambda: StoreFailConn(world2), stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", root,
              lambda *_args, **_kwargs: ([], None), fetch_threads, log=lines2.append)
    storage = next(line for line in lines2 if line.startswith("source_collection"))
    assert "outcome=storage_failed" in storage and "http_status=200" in storage


def test_unknown_http_status_stays_dash(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "synthetic", "url": None, "author": None,
                          "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(world.connect, stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", _policy_root(tmp_path, True),
              lambda *_args, **_kwargs: ([], None), fetch_threads, log=lines.append)
    assert "http_status=-" in next(line for line in lines if line.startswith("source_collection"))


def test_job_finalization_failure_keeps_committed_source_outcome(tmp_path):
    class FinishFail(_LoopConn):
        def execute(self, sql, params=None):
            if "status = 'succeeded'" in sql:
                raise RuntimeError("synthetic finish bookkeeping failure")
            result = super().execute(sql, params)
            if "insert into mentions" in sql.lower():
                return [{"id": "local-insert"}]
            return result

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "synthetic", "url": None, "author": None,
                          "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
            "credits_charged": 2,
            "http_status": 200,
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(lambda: FinishFail(world), stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", _policy_root(tmp_path, True),
              lambda *_args, **_kwargs: ([], None), fetch_threads, log=lines.append)

    collection = [line for line in lines if line.startswith("source_collection")]
    assert len(collection) == 1
    assert "outcome=success" in collection[0] and "saved=1" in collection[0]
    assert not any("outcome=storage_failed" in line for line in collection)
    finalize = [line for line in lines if line.startswith("job_finalize_failed")]
    assert len(finalize) == 1 and "job_id=job-1" in finalize[0] and "private" not in finalize[0]
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql and "claim_expired" not in sql]
    assert failed == [("storage_failed", "job-1")]
    assert [sql for sql, _params in world.calls].count("COMMIT") >= 2


class _WroteConn(_LoopConn):
    def __init__(self, world):
        super().__init__(world)
        self.wrote = False
        self.committed = False

    def execute(self, sql, params=None):
        if "insert into mentions" in sql.lower():
            self.wrote = True
            super().execute(sql, params)
            return [{"id": "local-insert"}]
        return super().execute(sql, params)


class _CloseFailAfterCommit(_WroteConn):
    def commit(self):
        super().commit()
        self.committed = True

    def close(self):
        if self.wrote and self.committed:
            raise RuntimeError("synthetic close failure after commit")


class _CommitFailAfterWrite(_WroteConn):
    manages_transactions = True

    def __init__(self, world):
        super().__init__(world)
        self.commits = 0

    def transaction(self):
        from contextlib import nullcontext

        return nullcontext()

    def commit(self):
        self.commits += 1
        if self.wrote and self.commits >= 2:
            raise RuntimeError("synthetic commit failure")
        super().commit()


class _WriteFail(_LoopConn):
    def execute(self, sql, params=None):
        if "insert into mentions" in sql.lower():
            raise RuntimeError("synthetic mention write failure")
        return super().execute(sql, params)


def _source_fetchers():
    def fetch_x(variant, limit, cursor, since=None, since_id=None):
        return (
            [{"external_id": "100", "excerpt": "synthetic", "url": None, "author": None,
              "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            None,
        )

    def fetch_dict(variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "synthetic", "url": None, "author": None,
                          "posted_at": "2026-11-01T00:00:00Z", "variant": variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
            "credits_charged": 2,
            "http_status": 200,
        }

    return fetch_x, fetch_dict


def _collect_source(source, connect, tmp_path, log, world=None):
    from unittest.mock import patch

    if world is None:
        world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = [source]

    def stop(_seconds):
        raise SystemExit

    fetch_x, fetch_dict = _source_fetchers()
    with patch("sentiment_monitor.scheduler.sources_allowed", return_value=[source]):
        with pytest.raises(SystemExit):
            serve(
                connect,
                stop,
                load_limits(Path("config/limits.json"), {}),
                "worker-1",
                _policy_root(tmp_path, True),
                fetch_x,
                fetch_dict,
                log=log,
                fetch_instagram=fetch_dict,
                fetch_tiktok=fetch_dict,
            )
    return world


@pytest.mark.parametrize("source", ["threads", "instagram", "tiktok", "x"])
def test_committed_close_failure_keeps_success_and_succeeds_job(tmp_path, source):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    world = _collect_source(source, lambda: _CloseFailAfterCommit(world), tmp_path, lines.append, world=world)

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert len(source_lines) == 1
    assert "outcome=success" in source_lines[0]
    assert "saved=1" in source_lines[0]
    assert not any("outcome=storage_failed" in line for line in source_lines)
    assert any(line.startswith("source_cleanup_failed") for line in lines)
    assert any("status = 'succeeded'" in sql for sql, _params in world.calls)
    assert not any("status = 'failed'" in sql and "claim_expired" not in sql for sql, _params in world.calls)


@pytest.mark.parametrize("source", ["threads", "instagram", "tiktok", "x"])
def test_logger_failure_after_commit_keeps_one_success_line_and_job(tmp_path, source):
    lines = []

    def log(line):
        if line.startswith("source_collection"):
            lines.append(line)
            raise RuntimeError("synthetic logger failure after write")
        lines.append(line)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world = _collect_source(source, lambda: _WroteConn(world), tmp_path, log, world=world)

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert len(source_lines) == 1
    assert "outcome=success" in source_lines[0] and "saved=1" in source_lines[0]
    assert not any("outcome=storage_failed" in line for line in source_lines)
    assert any("status = 'succeeded'" in sql for sql, _params in world.calls)
    assert not any("status = 'failed'" in sql and "claim_expired" not in sql for sql, _params in world.calls)


@pytest.mark.parametrize("source", ["threads", "instagram", "tiktok", "x"])
def test_logger_failure_before_recording_success_never_invents_rollback(tmp_path, source):
    lines = []

    def log(line):
        if line.startswith("source_collection"):
            raise RuntimeError("synthetic logger failure before write")
        lines.append(line)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world = _collect_source(source, lambda: _WroteConn(world), tmp_path, log, world=world)

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert not any("outcome=storage_failed" in line for line in source_lines)
    assert not any("saved=0" in line for line in source_lines)
    assert any("status = 'succeeded'" in sql for sql, _params in world.calls)
    assert not any("status = 'failed'" in sql and "claim_expired" not in sql for sql, _params in world.calls)


@pytest.mark.parametrize("source", ["threads", "instagram", "tiktok", "x"])
def test_commit_failure_logs_commit_unknown_not_false_rollback(tmp_path, source):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    world = _collect_source(source, lambda: _CommitFailAfterWrite(world), tmp_path, lines.append, world=world)

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert len(source_lines) == 1
    assert "outcome=storage_commit_unknown" in source_lines[0]
    assert "saved=-" in source_lines[0]
    assert "detail=storage_commit_unknown" in source_lines[0]
    assert not any("outcome=storage_failed" in line for line in source_lines)
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql and "claim_expired" not in sql]
    assert failed == [("storage_commit_unknown", "job-1")]


@pytest.mark.parametrize("source", ["threads", "instagram", "tiktok", "x"])
def test_write_failure_before_commit_still_logs_true_rollback(tmp_path, source):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    world = _collect_source(source, lambda: _WriteFail(world), tmp_path, lines.append, world=world)

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert len(source_lines) == 1
    assert "outcome=storage_failed" in source_lines[0]
    assert "saved=0" in source_lines[0]
    assert "detail=storage_failed" in source_lines[0]
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql and "claim_expired" not in sql]
    assert failed == [("storage_failed", "job-1")]


def test_commit_unknown_is_isolated_to_one_job(tmp_path):
    job2 = {**_due_job(), "id": "job-2"}
    state = {"fired": False}

    class FirstCommitFails(_WroteConn):
        manages_transactions = True

        def __init__(self, world):
            super().__init__(world)
            self.commits = 0

        def transaction(self):
            from contextlib import nullcontext

            return nullcontext()

        def commit(self):
            self.commits += 1
            if self.wrote and self.commits >= 2 and not state["fired"]:
                state["fired"] = True
                raise RuntimeError("synthetic first commit failure")
            super().commit()

    world = LoopWorld(jobs=[_due_job(), job2], variants=["geprek gembus"], cursor=None)
    lines = []
    world = _collect_source("threads", lambda: FirstCommitFails(world), tmp_path, lines.append, world=world)

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert len(source_lines) == 2
    assert sum("outcome=storage_commit_unknown" in line for line in source_lines) == 1
    assert sum("outcome=success" in line and "saved=1" in line for line in source_lines) == 1
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql and "claim_expired" not in sql]
    assert failed == [("storage_commit_unknown", "job-1")]
    assert any(
        "status = 'succeeded'" in sql and params == (None, "job-2")
        for sql, params in world.calls
    )


class _TransactionCommitFail(_WroteConn):
    manages_transactions = True

    class _Scope:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            raise RuntimeError("synthetic transaction commit failure")

    def transaction(self):
        return self._Scope()


@pytest.mark.parametrize("source", ["threads", "instagram", "tiktok", "x"])
def test_transaction_exit_commit_failure_is_commit_unknown(tmp_path, source):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    world = _collect_source(
        source,
        lambda: _TransactionCommitFail(world),
        tmp_path,
        lines.append,
        world=world,
    )

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert len(source_lines) == 1
    assert "outcome=storage_commit_unknown" in source_lines[0]
    assert "saved=-" in source_lines[0]
    assert "detail=storage_commit_unknown" in source_lines[0]
    assert not any("outcome=storage_failed" in line for line in source_lines)
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql and "claim_expired" not in sql]
    assert failed == [("storage_commit_unknown", "job-1")]


def test_format_log_failure_never_fails_the_job(tmp_path, monkeypatch):
    import sentiment_monitor.scheduler as scheduler

    def broken_format(*_args, **_kwargs):
        raise RuntimeError("synthetic format failure")

    monkeypatch.setattr(scheduler, "format_log", broken_format)
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    world = _collect_source("threads", lambda: _WroteConn(world), tmp_path, lines.append, world=world)

    assert any("status = 'succeeded'" in sql for sql, _params in world.calls)
    assert not any("status = 'failed'" in sql and "claim_expired" not in sql for sql, _params in world.calls)


def test_post_commit_unexpected_error_still_finalizes_the_job(tmp_path, monkeypatch):
    import sentiment_monitor.scheduler as scheduler

    def broken_ready(*_args, **_kwargs):
        raise RuntimeError("synthetic post-commit status failure")

    monkeypatch.setattr(scheduler, "_record_source_ready", broken_ready)
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    world = _collect_source("threads", lambda: _WroteConn(world), tmp_path, lines.append, world=world)

    source_lines = [line for line in lines if line.startswith("source_collection")]
    assert len(source_lines) == 1
    assert "outcome=success" in source_lines[0] and "saved=1" in source_lines[0]
    assert any(line.startswith("source_cleanup_failed") for line in lines)
    assert any("status = 'succeeded'" in sql for sql, _params in world.calls)
    assert not any("status = 'failed'" in sql and "claim_expired" not in sql for sql, _params in world.calls)


def test_load_active_variants_returns_keywords_with_stored_intent():
    class Conn:
        def execute(self, sql, params=None):
            return [
                {"text": "#kopi", "intent": "hashtag"},
                {"text": "kopi", "intent": "phrase"},
            ]

    variants = load_active_variants(Conn(), "project-1")
    assert [(str(item), item.intent) for item in variants] == [
        ("#kopi", "hashtag"),
        ("kopi", "phrase"),
    ]


def test_collection_plan_logs_keywords_and_fixed_route_count(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["kopi"], cursor=None)
    world.sources = ["threads", "instagram", "tiktok"]
    lines = []

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            lambda _variant: {"mentions": []},
            log=lines.append,
            fetch_instagram=lambda _variant: {"mentions": []},
            fetch_tiktok=lambda _variant: {"mentions": []},
        )

    assert any(
        "collection_plan" in line and "keywords=1" in line and "routes=6" in line
        for line in lines
    )


def test_unpack_fetched_carries_keyword_intent_and_route_provenance():
    from sentiment_monitor.intent import Keyword
    from sentiment_monitor.scheduler import _unpack_fetched

    rows, _cursor, _counts, _credits, _status = _unpack_fetched(
        {"mentions": [{"external_id": "1", "text": "kopi"}]},
        Keyword("kopi", "hashtag"),
    )
    assert rows[0]["intent"] == "hashtag"
    assert _unpack_fetched(
        {"mentions": [{"external_id": "2", "text": "kopi", "intent": "phrase"}]},
        Keyword("kopi", "hashtag"),
    )[0][0]["intent"] == "phrase"


def test_barayam_partial_source_failure_continues_sources_and_keywords(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["ayam barayam", "ayam geprek", "sambal"], cursor=None)
    world.sources = ["threads", "instagram", "tiktok"]
    calls = []
    lines = []

    def post(source, variant):
        return [{
            "external_id": f"{source}-{variant}",
            "excerpt": f"{source} {variant}",
            "url": f"https://example.com/{source}/{variant}",
            "author": "a",
            "posted_at": "2026-11-01T00:00:00Z",
            "variant": variant,
        }]

    def fetch_threads(variant):
        calls.append(("threads", variant))
        return post("threads", variant), None

    def fetch_instagram(variant):
        calls.append(("instagram", variant))
        if variant == "ayam barayam":
            raise ScrapeCreatorsError("http_404", http_status=404)
        return post("instagram", variant), None

    def fetch_tiktok(variant):
        calls.append(("tiktok", variant))
        return post("tiktok", variant), None

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
            fetch_instagram=fetch_instagram,
            fetch_tiktok=fetch_tiktok,
        )

    assert calls == [
        ("threads", "ayam barayam"), ("instagram", "ayam barayam"), ("tiktok", "ayam barayam"),
        ("threads", "ayam geprek"), ("instagram", "ayam geprek"), ("tiktok", "ayam geprek"),
        ("threads", "sambal"), ("instagram", "sambal"), ("tiktok", "sambal"),
    ]
    failed = [line for line in lines if line.startswith("source_collection") and "outcome=failed" in line]
    assert len(failed) == 1
    assert "source=instagram" in failed[0]
    assert "detail=instagram_http_404" in failed[0]
    successes = [line for line in lines if line.startswith("source_collection") and "outcome=success" in line]
    assert len(successes) == 8

    updates = [
        params for sql, params in world.calls
        if "update jobs set status = 'succeeded'" in sql.lower()
    ]
    assert len(updates) == 1
    detail = updates[0][0]
    assert detail.startswith("partial_failures:")
    assert "instagram:ayam%20barayam:instagram_http_404" in detail

    failed_jobs = [
        params for sql, params in world.calls
        if "update jobs set status = 'failed'" in sql.lower()
        and "claim_expired" not in sql.lower()
    ]
    assert failed_jobs == []
    schedule_updates = [
        params for sql, params in world.calls
        if "update project_schedules set last_collected_at" in sql.lower()
    ]
    assert schedule_updates == [("project-1",)]


def test_every_source_failing_fails_the_job_with_a_summary(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["ayam barayam"], cursor=None)
    world.sources = ["instagram"]

    def fetch_instagram(_variant):
        raise ScrapeCreatorsError("http_404", http_status=404)

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args, **_kwargs: ([], None),
            fetch_instagram=fetch_instagram,
        )

    failed = [
        params for sql, params in world.calls
        if "update jobs set status = 'failed'" in sql.lower()
        and "claim_expired" not in sql.lower()
    ]
    assert failed == [(
        "all_sources_failed:instagram:ayam%20barayam:instagram_http_404",
        "job-1",
    )]
    succeeded = [
        sql for sql, _params in world.calls
        if "update jobs set status = 'succeeded'" in sql.lower()
    ]
    assert succeeded == []


@pytest.mark.parametrize("error_type", [TypeError, ValueError, RuntimeError])
def test_unexpected_fetch_error_fails_job_instead_of_partial_success(tmp_path, error_type):
    world = LoopWorld(
        jobs=[_due_job()],
        variants=["ayam barayam", "ayam geprek", "sambal"],
        cursor=None,
    )
    world.sources = ["threads", "instagram", "tiktok"]
    calls = []
    lines = []

    def post(source, variant):
        return [{
            "external_id": f"{source}-{variant}",
            "excerpt": f"{source} {variant}",
            "url": f"https://example.com/{source}/{variant}",
            "author": "a",
            "posted_at": "2026-11-01T00:00:00Z",
            "variant": variant,
        }]

    def fetch_threads(variant):
        calls.append(("threads", variant))
        return post("threads", variant), None

    def fetch_instagram(variant):
        calls.append(("instagram", variant))
        if variant == "ayam barayam":
            raise error_type("synthetic programming error")
        return post("instagram", variant), None

    def fetch_tiktok(variant):
        calls.append(("tiktok", variant))
        return post("tiktok", variant), None

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
            fetch_instagram=fetch_instagram,
            fetch_tiktok=fetch_tiktok,
        )

    assert calls == [
        ("threads", "ayam barayam"),
        ("instagram", "ayam barayam"),
    ]
    failed_jobs = [
        params for sql, params in world.calls
        if "update jobs set status = 'failed'" in sql.lower()
        and "claim_expired" not in sql.lower()
    ]
    assert failed_jobs == [("collection_failed", "job-1")]
    succeeded = [
        sql for sql, _params in world.calls
        if "update jobs set status = 'succeeded'" in sql.lower()
    ]
    assert succeeded == []
    assert all("synthetic programming error" not in line for line in lines)
