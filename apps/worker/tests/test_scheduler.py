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
    from sentiment_monitor.scheduler import ALL_SOURCES, load_enabled_sources, record_source_failure

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

    conn = _FakeConn()
    assert record_source_failure(conn, "cust-1", "proj-1", "instagram", "instagram_http_402") == "rate_limited"
    assert record_source_failure(conn, "cust-1", "proj-1", "tiktok", "tiktok_http_401") == "authorization_failed"
    assert record_source_failure(conn, "cust-1", "proj-1", "threads", "threads_http_500") == "unavailable"


def test_fetch_error_is_redacted_and_marks_the_job_failed(tmp_path, monkeypatch, capfd):
    token = "tok+en/sec=ret"
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", token)
    quoted = quote(token, safe="")
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor="cursor-1")

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
    assert captured.out == "[redacted] [redacted]\nworker heartbeat id=worker-1\n"
    assert captured.err == ""
    failed = [
        (sql, params)
        for sql, params in world.calls
        if "status = 'failed'" in sql.lower() and "claim_expired" not in sql
    ]
    assert len(failed) == 1
    detail, job_id = failed[0][1]
    assert job_id == "job-1"
    assert detail == "threads_http_401"
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
    assert captured.out == "[redacted] [redacted]\n[redacted] [redacted]\nworker heartbeat id=worker-1\n"
    assert captured.err == ""
    assert token not in captured.out
    assert quoted not in captured.out
    assert "URL-STRING-FORM" not in captured.out


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
