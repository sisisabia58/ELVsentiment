import inspect

from sentiment_monitor import cursors
from sentiment_monitor.cursors import commit_cursor, query_key
from sentiment_monitor.status import (
    classify_http_failure,
    report_failure,
    report_success,
    report_threads_empty,
)


def test_failures_are_not_zero_mentions():
    assert classify_http_failure(429) == "rate_limited"
    assert classify_http_failure(401) == "authorization_failed"
    assert classify_http_failure(403) == "authorization_failed"
    assert classify_http_failure(503) == "unavailable"
    assert classify_http_failure(None) == "unavailable"
    failed = report_failure("x", "rate_limited", "429")
    assert failed.outcome == "failed"
    assert failed.fetched_count is None


def test_threads_empty_array_is_not_a_zero_count():
    report = report_threads_empty()
    assert report.outcome == "empty_unconfirmed"
    assert report.fetched_count is None
    assert report.detail == "threads_empty_array"


def test_x_success_can_be_a_real_zero():
    report = report_success("x", 0, False)
    assert report.outcome == "success"
    assert report.fetched_count == 0
    assert report.state == "ready"


class FakeStore:
    def __init__(self):
        self.success = 0
        self.state = {}

    def record_source_success(self, query, source, mentions, *, mode, next_cursor, incremental_since=None):
        self.success += 1
        self.state["last_success_at"] = "set"

    def record_source_error(self, query, source, error):
        self.state["last_error"] = error

    def source_state(self, query, source):
        return self.state


def test_cursor_waits_for_handoff():
    store = FakeStore()
    key = query_key("customer-a", "project-1", "geprek gembus")
    other = query_key("customer-b", "project-1", "geprek gembus")
    assert key != other
    commit_cursor(store, key, "x", [], None, False)
    assert store.success == 0
    assert store.source_state(key, "x").get("last_success_at") is None
    commit_cursor(store, key, "x", [], None, True)
    assert store.success == 1
    assert "sqlite3" not in inspect.getsource(cursors)
    assert "harken.store" not in inspect.getsource(cursors)
