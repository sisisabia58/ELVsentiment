from __future__ import annotations

from typing import Any, Callable
import urllib.error


def _failure_state(error: Exception) -> str:
    if isinstance(error, urllib.error.HTTPError):
        if error.code == 401:
            return "authorization_failed"
        if error.code in (402, 429):
            return "rate_limited"
    return "unavailable"


def collect_project_sources(fetchers: dict[str, Callable[[], dict[str, Any]]]) -> dict[str, Any]:
    mentions: list[dict[str, Any]] = []
    sources: dict[str, dict[str, Any]] = {}
    for source, fetch in fetchers.items():
        try:
            result = fetch()
            source_mentions = list(result.get("mentions", []))
            mentions.extend(source_mentions)
            sources[source] = {
                "state": "ready",
                "outcome": "empty_unconfirmed"
                if source == "threads" and len(source_mentions) == 0
                else "success",
                "fetched_count": len(source_mentions),
            }
        except Exception as error:
            sources[source] = {
                "state": _failure_state(error),
                "outcome": "failed",
                "fetched_count": None,
            }
    return {"mentions": mentions, "sources": sources}
