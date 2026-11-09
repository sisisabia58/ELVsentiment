from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sentiment_monitor.intent import Keyword, hashtag_term

SCRAPECREATORS_SOURCES = ("threads", "instagram", "tiktok")
WINDOW_DAYS = {"last-week": 8, "this-week": 8}
# Asia/Jakarta is a fixed UTC+7 offset, matching scheduler.JAKARTA. The
# Threads window uses Jakarta civil dates, not the worker's UTC date.
JAKARTA = timezone(timedelta(hours=7))
THREADS_WINDOW_DAYS = WINDOW_DAYS["last-week"]


@dataclass(frozen=True)
class Route:
    id: str
    source: str
    intent: str
    path: str
    query_param: str
    date_param: str | None = None
    date_value: str | None = None
    disclosure: str | None = None
    date_window: str | None = None
    extra_params: tuple[tuple[str, str], ...] = ()
    conditional: bool = False


_ROUTES: dict[tuple[str, str], tuple[Route, ...]] = {
    ("threads", "phrase"): (
        Route(
            "threads.keyword",
            "threads",
            "phrase",
            "/v1/threads/search",
            "query",
            date_window="threads_start_end",
        ),
    ),
    ("threads", "hashtag"): (
        Route(
            "threads.hashtag_text",
            "threads",
            "hashtag",
            "/v1/threads/search",
            "query",
            disclosure="Threads has no hashtag search; searched as text",
            date_window="threads_start_end",
        ),
    ),
    ("instagram", "phrase"): (
        Route(
            "instagram.reels",
            "instagram",
            "phrase",
            "/v2/instagram/reels/search",
            "query",
            "date_posted",
            "last-week",
        ),
    ),
    ("instagram", "hashtag"): (
        Route(
            "instagram.hashtag",
            "instagram",
            "hashtag",
            "/v1/instagram/search/hashtag",
            "hashtag",
            "date_posted",
            "last-week",
        ),
    ),
    ("tiktok", "phrase"): (
        Route(
            "tiktok.keyword",
            "tiktok",
            "phrase",
            "/v1/tiktok/search/keyword",
            "query",
            "date_posted",
            "this-week",
        ),
        Route(
            "tiktok.top",
            "tiktok",
            "phrase",
            "/v1/tiktok/search/top",
            "query",
            "publish_time",
            "this-week",
        ),
    ),
    ("tiktok", "hashtag"): (
        Route("tiktok.hashtag", "tiktok", "hashtag", "/v1/tiktok/search/hashtag", "hashtag"),
    ),
}


def routes_for(source: str, keyword: Keyword) -> tuple[Route, ...]:
    intent = getattr(keyword, "intent", "phrase")
    return _ROUTES.get((source, intent), ())


def threads_date_window(now: datetime | str | None = None) -> tuple[str, str]:
    """Return the 8-day Threads window ending tomorrow, as Jakarta civil dates.

    The ledger from the 9 Nov 2026 run used start_date=2026-11-02 and
    end_date=2026-11-10 at 23:31 WIB: end is the next Jakarta day and start
    is eight days before that end.
    """
    parsed = now if isinstance(now, datetime) else _parse_timestamp(now)
    if parsed is None:
        parsed = datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    today = parsed.astimezone(JAKARTA).date()
    end = today + timedelta(days=1)
    start = end - timedelta(days=THREADS_WINDOW_DAYS)
    return start.isoformat(), end.isoformat()


def request_params(
    route: Route, keyword: Keyword, *, now: datetime | str | None = None
) -> dict[str, str]:
    if route.id == "threads.hashtag_text":
        value = str(keyword)
    elif route.query_param == "hashtag":
        value = hashtag_term(str(keyword))
    else:
        value = str(keyword)
    params = {route.query_param: value}
    if route.date_param is not None and route.date_value is not None:
        params[route.date_param] = route.date_value
    for key, extra in route.extra_params:
        params[key] = extra
    if route.date_window == "threads_start_end":
        start, end = threads_date_window(now)
        params["start_date"] = start
        params["end_date"] = end
    return params


def _parse_timestamp(value: str | None) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def within_overlap(posted_at: str | None, collected_at: str, route: Route) -> bool:
    window_days = WINDOW_DAYS.get(route.date_value or "")
    if window_days is None:
        return True
    posted = _parse_timestamp(posted_at)
    collected = _parse_timestamp(collected_at)
    if posted is None or collected is None:
        return True
    return (collected - posted).total_seconds() <= window_days * 86400


def scrapecreators_request_count(keywords: list[Keyword], sources: list[str]) -> int:
    total = 0
    for source in sources:
        if source not in SCRAPECREATORS_SOURCES:
            continue
        for keyword in keywords:
            total += len(routes_for(source, keyword))
    return total
