"""Route a supported search to the configured ScrapeAtlas adapter."""

from __future__ import annotations

from dataclasses import replace
import time
from typing import Any, Callable, Mapping
import os
from sentiment_monitor.providers.http import urlopen as safe_urlopen

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.capabilities import (
    ProviderSetting,
    resolve_chain,
)
from sentiment_monitor.providers.scrapeatlas_sources import (
    continuation_values,
    facebook_hashtag,
    fetch_scrapeatlas_facebook,
    fetch_scrapeatlas_instagram,
    fetch_scrapeatlas_x,
    fetch_scrapeatlas_linkedin,
    fetch_scrapeatlas_reddit,
    fetch_scrapeatlas_threads,
    fetch_scrapeatlas_tiktok,
    fetch_scrapeatlas_youtube,
)
from sentiment_monitor.providers.canonical import PlatformFetch

_SCRAPEATLAS_FETCHERS: dict[str, Callable[..., PlatformFetch]] = {
    "threads": fetch_scrapeatlas_threads,
    "instagram": fetch_scrapeatlas_instagram,
    "x": fetch_scrapeatlas_x,
    "tiktok": fetch_scrapeatlas_tiktok,
    "youtube": fetch_scrapeatlas_youtube,
    "reddit": fetch_scrapeatlas_reddit,
    "facebook": fetch_scrapeatlas_facebook,
    "linkedin": fetch_scrapeatlas_linkedin,
}

CONTINUATION_ROUTES = {
    "tiktok": "scrapeatlas.tiktok.keyword",
    "instagram": "scrapeatlas.instagram.posts",
    "x": "scrapeatlas.twitter.posts",
    "youtube": "scrapeatlas.youtube.search",
    "reddit": "scrapeatlas.reddit.search",
    "facebook": "scrapeatlas.facebook.hashtag",
    "linkedin": "scrapeatlas.linkedin.posts",
}


def provider_api_key(provider: str, env: Mapping[str, Any]) -> str | None:
    if provider != "scrapeatlas":
        return None
    value = env.get("SCRAPEATLAS_API_KEY")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def fetch_platform(
    platform: str,
    keyword: Keyword,
    settings: Mapping[str, ProviderSetting],
    *,
    env: Mapping[str, Any],
    collected_at: str,
    date_window_days: int | None = None,
    opener: Callable[..., Any] = safe_urlopen,
    timeout: int | None = None,
    continuation_route: str | None = None,
    cursor: str | None = None,
    companion: str | None = None,
) -> PlatformFetch:
    chain = resolve_chain(platform, settings)
    if not chain:
        return PlatformFetch(
            platform, "off", [], [], "unavailable", "unsupported_provider", 0, ()
        )
    if platform == "facebook" and facebook_hashtag(keyword) is None:
        return PlatformFetch(platform, "scrapeatlas", state="unavailable", safe_detail="hashtag_only")
    mode = env.get("CARI_PROVIDER_MODE") if isinstance(env, Mapping) else None
    if not isinstance(mode, str) or not mode:
        mode = os.environ.get("CARI_PROVIDER_MODE", "live")
    page_args = {}
    if continuation_route is not None or cursor is not None or companion is not None:
        cursor, companion = continuation_values(platform, cursor, companion)
        if (mode == "fixture" or continuation_route is None
                or continuation_route != CONTINUATION_ROUTES.get(platform)
                or cursor is None):
            return PlatformFetch(platform, "scrapeatlas", state="unavailable", safe_detail="unsupported_provider")
        page_args["cursor"] = cursor
        if platform == "tiktok":
            page_args["search_id"] = companion
    if mode == "fixture":
        from sentiment_monitor.providers.fixtures import fixture_platform_fetch

        return fixture_platform_fetch(
            platform,
            keyword,
            collected_at=collected_at,
            date_window_days=date_window_days,
        )
    first = chain[0]
    first_key = provider_api_key(first, env)
    if first_key is None:
        return PlatformFetch(
            platform, first, [], [], "unavailable", "missing_key", 0, (first,)
        )
    effective_opener = opener
    if timeout is not None:
        budget_end = time.monotonic() + float(timeout)

        def effective_opener(request, timeout=None, **kwargs):
            left = budget_end - time.monotonic()
            if left <= 0:
                raise TimeoutError("route_budget")
            chosen = left if timeout is None else min(float(timeout), left)
            return opener(request, timeout=max(0.001, chosen), **kwargs)

    fetcher = _SCRAPEATLAS_FETCHERS[platform]
    result = fetcher(
        keyword,
        api_key=first_key,
        collected_at=collected_at,
        date_window_days=date_window_days,
        opener=effective_opener,
        **page_args,
    )
    return replace(result, attempted_providers=(first,) if result.calls else ())
