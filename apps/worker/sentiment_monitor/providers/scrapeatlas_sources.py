"""ScrapeAtlas source adapters producing canonical posts."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
import time
from typing import Any, Callable, Mapping
import urllib.request

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import (
    CanonicalPost,
    RouteCall,
    detect_language,
    filter_since,
    keyword_relevance,
)
from sentiment_monitor.providers.scrapeatlas import ScrapeAtlasError, fetch_scrapeatlas_json
from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch
from sentiment_monitor.sources.tiktok import normalize_tiktok_item
from sentiment_monitor.sources.threads import normalize_threads_item

DEFAULT_TIMEOUT = 20


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _optional_text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _cutoff(collected_at: str, date_window_days: int) -> str | None:
    try:
        parsed = datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        return None
    return (parsed - timedelta(days=date_window_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _canonical_from(
    platform: str,
    item: Mapping[str, Any],
    keyword: Keyword,
    collected_at: str,
    route_id: str,
    *,
    web_index: bool = False,
) -> CanonicalPost:
    text = str(item.get("text") or "")
    external_id = str(item.get("external_id") or "")
    draft = CanonicalPost(
        platform=platform,
        external_id=external_id,
        text=text,
        title=_optional_text(item.get("title")),
        author_name=_optional_text(item.get("author_name")),
        author_handle=_optional_text(item.get("author_handle") or item.get("author")),
        url=_optional_text(item.get("url")),
        published_at=_optional_text(item.get("posted_at")),
        thumbnail_url=_optional_text(item.get("thumbnail_url")),
        views=_optional_int(item.get("views")),
        likes=_optional_int(item.get("likes")),
        replies=_optional_int(item.get("replies")),
        shares=_optional_int(item.get("shares")),
        top_replies=(),
        hashtags=tuple(str(tag) for tag in item.get("hashtags") or ()),
        source_provider="scrapeatlas",
        routes=(route_id,),
        raw_ref=f"scrapeatlas:{platform}:{external_id}",
        collected_at=collected_at,
        language=detect_language(text),
        web_index=web_index,
    )
    return replace(
        draft,
        relevance=keyword_relevance(draft, str(keyword), getattr(keyword, "intent", "phrase")),
    )


def _list_items(payload: Mapping[str, Any], key: str) -> list[dict[str, Any]]:
    value = payload.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _first_list(payload: Mapping[str, Any], keys: tuple[str, ...]) -> list[dict[str, Any]]:
    for key in keys:
        items = _list_items(payload, key)
        if items:
            return items
    return []


def _fetch(
    platform: str,
    path: str,
    params: Mapping[str, Any],
    api_key: str,
    *,
    opener: Callable[..., Any],
    keyword: Keyword,
    collected_at: str,
    route_id: str,
    extract: Callable[[Mapping[str, Any], str], list[dict[str, Any]]],
    date_window_days: int | None,
    web_index_from_warnings: bool = False,
) -> PlatformFetch:
    started = time.monotonic()
    try:
        payload = fetch_scrapeatlas_json(path, params, api_key, opener=opener)
    except ScrapeAtlasError as error:
        latency_ms = int((time.monotonic() - started) * 1000)
        if error.code == "not_found":
            call = RouteCall(
                provider="scrapeatlas",
                platform=platform,
                route=route_id,
                outcome="success",
                http_status=error.http_status,
                credits_charged=0,
                body_length=error.body_length,
                latency_ms=latency_ms,
                safe_detail="not_found",
            )
            return PlatformFetch(
                platform, "scrapeatlas", [], [call], "answered", "not_found", latency_ms
            )
        call = RouteCall(
            provider="scrapeatlas",
            platform=platform,
            route=route_id,
            outcome="failed",
            http_status=error.http_status,
            credits_charged=error.credits_charged,
            body_length=error.body_length,
            latency_ms=latency_ms,
            safe_detail=error.code,
        )
        return PlatformFetch(
            platform, "scrapeatlas", [], [call], "failed", error.code, latency_ms
        )
    latency_ms = int((time.monotonic() - started) * 1000)
    web_index = (
        web_index_from_warnings
        and "web_index_selection" in payload.coverage_warnings
    )
    posts = [
        _canonical_from(
            platform,
            item,
            keyword,
            collected_at,
            route_id,
            web_index=web_index,
        )
        for item in extract(payload, collected_at)
    ]
    if date_window_days is not None:
        cutoff = _cutoff(collected_at, date_window_days)
        if cutoff is not None:
            posts = filter_since(posts, cutoff)
    status = payload.get("status")
    outcome = "partial" if status == "partial" else "success"
    call = RouteCall(
        provider="scrapeatlas",
        platform=platform,
        route=route_id,
        outcome=outcome,
        http_status=payload.http_status,
        credits_charged=payload.credits_charged,
        body_length=payload.body_length,
        latency_ms=latency_ms,
        safe_detail="ok",
    )
    return PlatformFetch(
        platform, "scrapeatlas", posts, [call], "answered", "ok", latency_ms
    )


def _threads_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    return [
        normalize_threads_item(item, collected_at)
        for item in _list_items(payload, "posts")
    ]


def _tiktok_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items = []
    for item in _first_list(payload, ("search_item_list", "item_list", "data")):
        if "create_time" not in item and "createTime" in item:
            item = {**item, "create_time": item["createTime"]}
        items.append(normalize_tiktok_item(item, collected_at))
    return items


def fetch_scrapeatlas_threads(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    return _fetch(
        "threads",
        "/v1/threads/search",
        {"query": str(keyword), "recent": "true", "region": "ID"},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.threads.recent",
        extract=_threads_items,
        date_window_days=date_window_days,
    )


def fetch_scrapeatlas_tiktok(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    return _fetch(
        "tiktok",
        "/v1/tiktok/search/keyword",
        {"query": str(keyword), "region": "ID"},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.tiktok.keyword",
        extract=_tiktok_items,
        date_window_days=date_window_days,
    )
