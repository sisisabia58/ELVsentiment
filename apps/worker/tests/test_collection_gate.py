import json
from pathlib import Path

import pytest

import sentiment_monitor.collect_once as collect_once
from sentiment_monitor.limits import load_limits
from sentiment_monitor.scheduler import serve


def _root(tmp_path, credential_approved, mode, x_budget_approved):
    config = tmp_path / "config"
    config.mkdir()
    (config / "credential-policy.json").write_text(
        json.dumps({"approved": credential_approved, "mode": mode}),
        encoding="utf-8",
    )
    (config / "x-budget.json").write_text(
        json.dumps({"approved": x_budget_approved}),
        encoding="utf-8",
    )
    return tmp_path


def _env(x_token, threads_token):
    env = {}
    if x_token == "yes":
        env["X_BEARER_TOKEN"] = "test-x-token"
    elif x_token == "blank":
        env["X_BEARER_TOKEN"] = "   "
    if threads_token == "yes":
        env["THREADS_ACCESS_TOKEN"] = "test-threads-token"
    elif threads_token == "blank":
        env["THREADS_ACCESS_TOKEN"] = "   "
    return env


# credential approved, mode, x budget approved, X token, Threads token, gate, allowed
_ROWS = [
    (False, "shared_operator", False, "no", "no", 2, set()),
    (False, "shared_operator", True, "yes", "yes", 2, set()),
    (False, "shared_operator", False, "yes", "yes", 2, set()),
    (True, "per_customer", True, "yes", "yes", 2, set()),
    (True, "shared_operator", False, "no", "yes", 0, {"threads"}),
    (True, "shared_operator", False, "yes", "yes", 0, {"threads"}),
    (True, "shared_operator", False, "no", "no", 0, set()),
    (True, "shared_operator", False, "yes", "no", 0, set()),
    (True, "shared_operator", True, "no", "yes", 0, {"threads"}),
    (True, "shared_operator", True, "yes", "no", 0, {"x"}),
    (True, "shared_operator", True, "yes", "yes", 0, {"x", "threads"}),
    (True, "shared_operator", True, "no", "no", 0, set()),
    (True, "shared_operator", True, "blank", "blank", 0, set()),
]


@pytest.mark.parametrize(
    ("credential_approved", "mode", "x_budget_approved", "x_token", "threads_token", "expected_gate", "expected_allowed"),
    _ROWS,
)
def test_gate_ignores_x_budget_and_sources_follow_tokens(
    tmp_path,
    credential_approved,
    mode,
    x_budget_approved,
    x_token,
    threads_token,
    expected_gate,
    expected_allowed,
):
    root = _root(tmp_path, credential_approved, mode, x_budget_approved)
    assert collect_once.gate(root) == expected_gate
    sources_allowed = getattr(collect_once, "sources_allowed", None)
    assert callable(sources_allowed)
    assert sources_allowed(root, _env(x_token, threads_token)) == expected_allowed


class _LoopWorld:
    def __init__(self, sources=None, threads_used=0):
        self.jobs = [{
            "id": "job-1",
            "customer_id": "customer-a",
            "project_id": "project-1",
            "kind": "manual",
            "status": "queued",
        }]
        self.calls = []
        self.sources = ["x", "threads"] if sources is None else list(sources)
        self.threads_used = threads_used

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
            return rows
        if "from keyword_variants" in lowered:
            return [{"text": "geprek gembus"}]
        if "from project_settings" in lowered:
            return [{"enabled_sources": list(self.world.sources)}]
        if "from source_cursors" in lowered and lowered.startswith("select"):
            return {
                "incremental_cursor": None,
                "incremental_since": None,
                "backfill_cursor": None,
                "last_success_at": None,
                "last_error": None,
            }
        if "from x_read_counters" in lowered and "for update" in lowered:
            return 0
        if "from threads_query_log" in lowered and "count" in lowered:
            return self.world.threads_used
        return None

    def commit(self):
        self.world.calls.append(("COMMIT", None))

    def rollback(self):
        self.world.calls.append(("ROLLBACK", None))

    def close(self):
        return None


def test_threads_fetch_runs_without_an_approved_x_budget(tmp_path, monkeypatch):
    monkeypatch.delenv("X_BEARER_TOKEN", raising=False)
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", "test-threads-token")
    root = _root(tmp_path, True, "shared_operator", False)
    world = _LoopWorld()
    fetched = []

    def fetch_x(*_args, **_kwargs):
        fetched.append("x")
        return [], None

    def fetch_threads(_variant):
        fetched.append(("threads", len(world.calls)))
        return [], None

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            root,
            fetch_x,
            fetch_threads,
        )

    assert [item for item in fetched if item == "x"] == []
    threads_fetches = [item for item in fetched if isinstance(item, tuple)]
    assert len(threads_fetches) == 1
    count_at = next(
        index
        for index, (sql, _params) in enumerate(world.calls)
        if "count" in sql.lower() and "from threads_query_log" in sql.lower()
    )
    assert count_at < threads_fetches[0][1]


def _serve_until_sleep(world, root, fetch_x, fetch_threads):
    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            root,
            fetch_x,
            fetch_threads,
        )


def _statements(world):
    return [" ".join(sql.lower().split()) for sql, _params in world.calls]


def test_x_only_reserves_x_and_does_not_fetch_threads(tmp_path, monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "test-x-token")
    monkeypatch.delenv("THREADS_ACCESS_TOKEN", raising=False)
    root = _root(tmp_path, True, "shared_operator", True)
    world = _LoopWorld()
    fetched = []

    def fetch_x(*_args, **_kwargs):
        fetched.append("x")
        return [], None

    def fetch_threads(_variant):
        fetched.append("threads")
        return [], None

    _serve_until_sleep(world, root, fetch_x, fetch_threads)

    assert fetched == ["x"]
    statements = _statements(world)
    assert any("insert into x_read_counters" in sql for sql in statements)
    assert not any("insert into threads_query_log" in sql for sql in statements)


def test_threads_only_over_reserve_defers_without_fetch(tmp_path, monkeypatch):
    monkeypatch.delenv("X_BEARER_TOKEN", raising=False)
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", "test-threads-token")
    root = _root(tmp_path, True, "shared_operator", False)
    limits = load_limits(Path("config/limits.json"), {})
    world = _LoopWorld(threads_used=limits.threads_rolling_24h_reserve)
    fetched = []

    def fetch_x(*_args, **_kwargs):
        fetched.append("x")
        return [], None

    def fetch_threads(_variant):
        fetched.append("threads")
        return [], None

    _serve_until_sleep(world, root, fetch_x, fetch_threads)

    assert fetched == []
    assert limits.threads_rolling_24h_reserve == 1500
    assert any(
        params and params[0] == "threads_budget"
        for sql, params in world.calls
        if "status = 'deferred'" in sql.lower()
    )


def test_both_sources_admit_collection_once(tmp_path, monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "test-x-token")
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", "test-threads-token")
    root = _root(tmp_path, True, "shared_operator", True)
    world = _LoopWorld(sources=["x", "threads"])
    fetched = []

    def fetch_x(*_args, **_kwargs):
        fetched.append("x")
        return [], None

    def fetch_threads(_variant):
        fetched.append("threads")
        return [], None

    _serve_until_sleep(world, root, fetch_x, fetch_threads)

    assert fetched == ["x", "threads"]
    statements = _statements(world)
    thread_inserts = [index for index, sql in enumerate(statements) if "insert into threads_query_log" in sql]
    x_inserts = [index for index, sql in enumerate(statements) if "insert into x_read_counters" in sql]
    assert len(thread_inserts) == 1
    assert len(x_inserts) == 2
    count_at = next(
        index
        for index, sql in enumerate(statements)
        if "from threads_query_log" in sql and "count" in sql
    )
    assert count_at < x_inserts[0]
    assert x_inserts[0] < thread_inserts[0]


def test_both_sources_at_threads_reserve_defers_without_reserve_or_fetch(tmp_path, monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "test-x-token")
    monkeypatch.setenv("THREADS_ACCESS_TOKEN", "test-threads-token")
    root = _root(tmp_path, True, "shared_operator", True)
    limits = load_limits(Path("config/limits.json"), {})
    world = _LoopWorld(sources=["x", "threads"], threads_used=limits.threads_rolling_24h_reserve)
    fetched = []

    def fetch_x(*_args, **_kwargs):
        fetched.append("x")
        return [], None

    def fetch_threads(_variant):
        fetched.append("threads")
        return [], None

    _serve_until_sleep(world, root, fetch_x, fetch_threads)

    assert fetched == []
    assert limits.threads_rolling_24h_reserve == 1500
    statements = _statements(world)
    assert not any("insert into x_read_counters" in sql for sql in statements)
    assert not any("insert into threads_query_log" in sql for sql in statements)
    assert any(
        params and params[0] == "threads_budget"
        for sql, params in world.calls
        if "status = 'deferred'" in sql.lower()
    )
