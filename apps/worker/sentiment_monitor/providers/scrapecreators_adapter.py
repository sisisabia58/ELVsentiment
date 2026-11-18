"""Map the existing ScrapeCreators sources onto canonical records."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import time
from typing import Any, Callable, Mapping
from sentiment_monitor.providers.http import urlopen as safe_urlopen

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import (
    CanonicalPost,
    RouteCall,
    detect_language,
    keyword_relevance,
)
from sentiment_monitor.sources.instagram import fetch_instagram_mentions
from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError
from sentiment_monitor.sources.threads import fetch_threads_mentions
from sentiment_monitor.sources.tiktok import fetch_tiktok_mentions

_FETCHERS: dict[str, Callable[..., dict[str, Any]]] = {
    "threads": fetch_threads_mentions,
    "tiktok": fetch_tiktok_mentions,
    "instagram": fetch_instagram_mentions,
}


from sentiment_monitor.providers.canonical import PlatformFetch

def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text.isascii() and text.isdigit():
            return int(text)
    return None


def _optional_text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _to_post(
    platform: str,
    mention: Mapping[str, Any],
    keyword: Keyword,
    collected_at: str,
) -> CanonicalPost:
    text = str(mention.get("text") or "")
    external_id = str(mention.get("external_id") or "")
    route_ids = mention.get("route_ids")
    if not isinstance(route_ids, (list, tuple)) or not route_ids:
        route_id = mention.get("route_id")
        route_ids = (route_id,) if route_id else ()
    draft = CanonicalPost(
        platform=platform,
        external_id=external_id,
        text=text,
        title=_optional_text(mention.get("title")),
        author_name=_optional_text(mention.get("author_name")),
        author_handle=_optional_text(mention.get("author_handle") or mention.get("author")),
        url=_optional_text(mention.get("url")),
        published_at=_optional_text(mention.get("posted_at")),
        thumbnail_url=_optional_text(mention.get("thumbnail_url")),
        views=_optional_int(mention.get("views")),
        likes=_optional_int(mention.get("likes")),
        replies=_optional_int(mention.get("replies")),
        shares=_optional_int(mention.get("shares")),
        top_replies=(),
        hashtags=tuple(str(tag) for tag in mention.get("hashtags") or ()),
        source_provider="scrapecreators",
        routes=tuple(str(route) for route in route_ids),
        raw_ref=f"scrapecreators:{platform}:{external_id}",
        collected_at=collected_at,
        language=detect_language(text),
    )
    return replace(
        draft,
        relevance=keyword_relevance(draft, str(keyword), getattr(keyword, "intent", "phrase")),
    )


def _route_call(platform: str, event: Mapping[str, Any], latency_ms: int) -> RouteCall:
    return RouteCall(
        provider="scrapecreators",
        platform=platform,
        route=str(event.get("route") or ""),
        outcome=event.get("outcome") or "failed",
        http_status=_optional_int(event.get("http_status")),
        credits_charged=_optional_int(event.get("credits_charged")),
        body_length=_optional_int(event.get("body_length")),
        latency_ms=latency_ms,
        safe_detail=str(event.get("detail") or "ok"),
    )


def fetch_scrapecreators_platform(
    platform: str,
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    timeout: float | None = None,
) -> PlatformFetch:
    fetcher = _FETCHERS.get(platform)
    if fetcher is None:
        raise ValueError("unsupported_platform")
    started = time.monotonic()
    try:
        extra: dict[str, Any] = {}
        if platform == "instagram" and timeout is not None:
            extra["timeout"] = timeout
        payload = fetcher(
            str(keyword),
            api_key,
            collected_at,
            intent=getattr(keyword, "intent", "phrase"),
            opener=opener,
            **extra,
        )
    except ScrapeCreatorsError as error:
        latency_ms = int((time.monotonic() - started) * 1000)
        events = getattr(error, "route_events", None) or []
        calls = [_route_call(platform, event, latency_ms) for event in events]
        if not calls:
            calls = [
                RouteCall(
                    provider="scrapecreators",
                    platform=platform,
                    route=f"scrapecreators.{platform}",
                    outcome="failed",
                    http_status=error.http_status,
                    credits_charged=error.credits_charged,
                    body_length=getattr(error, "body_length", None),
                    latency_ms=latency_ms,
                    safe_detail=error.code,
                )
            ]
        return PlatformFetch(
            platform,
            "scrapecreators",
            [],
            calls,
            "failed",
            error.code,
            latency_ms,
        )
    latency_ms = int((time.monotonic() - started) * 1000)
    mentions = payload.get("mentions") or []
    posts = [
        _to_post(platform, mention, keyword, collected_at)
        for mention in mentions
        if isinstance(mention, dict)
    ]
    calls = [
        _route_call(platform, event, latency_ms)
        for event in payload.get("route_events") or []
        if isinstance(event, dict)
    ]
    return PlatformFetch(
        platform,
        "scrapecreators",
        posts,
        calls,
        "answered",
        "ok",
        latency_ms,
    )
