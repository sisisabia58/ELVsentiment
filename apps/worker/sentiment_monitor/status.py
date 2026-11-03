from dataclasses import dataclass


@dataclass(frozen=True)
class CollectionReport:
    source: str
    outcome: str
    fetched_count: int | None
    state: str
    detail: str
    truncated: bool


def classify_http_failure(status_code: int | None) -> str:
    if status_code == 429:
        return "rate_limited"
    if status_code in (401, 403):
        return "authorization_failed"
    return "unavailable"


def report_failure(source: str, state: str, detail: str) -> CollectionReport:
    return CollectionReport(source, "failed", None, state, detail, False)


def report_success(source: str, fetched_count: int, truncated: bool) -> CollectionReport:
    return CollectionReport(source, "success", fetched_count, "ready", "ok", truncated)


def report_threads_empty() -> CollectionReport:
    return CollectionReport("threads", "empty_unconfirmed", None, "ready", "threads_empty_array", False)
