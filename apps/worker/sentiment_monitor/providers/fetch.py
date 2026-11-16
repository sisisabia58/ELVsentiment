"""Provider-agnostic fetch with a capability guard and optional fallback."""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Callable, Mapping
import os
import urllib.request

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.capabilities import (
    ProviderSetting,
    resolve_chain,
)
from sentiment_monitor.providers.scrapeatlas_sources import (
    fetch_scrapeatlas_facebook,
    fetch_scrapeatlas_linkedin,
    fetch_scrapeatlas_reddit,
    fetch_scrapeatlas_threads,
    fetch_scrapeatlas_tiktok,
    fetch_scrapeatlas_youtube,
)
from sentiment_monitor.providers.scrapecreators_adapter import (
    PlatformFetch,
    fetch_scrapecreators_platform,
)

RETRYABLE_DETAILS = frozenset({"http_429", "timeout", "transport_error"})

_ENV_KEYS = {
    "scrapecreators": "SCRAPECREATORS_API_KEY",
    "scrapeatlas": "SCRAPEATLAS_API_KEY",
    "official_x": "X_BEARER_TOKEN",
}

_SCRAPEATLAS_FETCHERS: dict[str, Callable[..., PlatformFetch]] = {
    "threads": fetch_scrapeatlas_threads,
    "tiktok": fetch_scrapeatlas_tiktok,
    "youtube": fetch_scrapeatlas_youtube,
    "reddit": fetch_scrapeatlas_reddit,
    "facebook": fetch_scrapeatlas_facebook,
    "linkedin": fetch_scrapeatlas_linkedin,
}


def provider_api_key(provider: str, env: Mapping[str, Any]) -> str | None:
    name = _ENV_KEYS.get(provider)
    if name is None:
        return None
    value = env.get(name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _dispatch(
    provider: str,
    *,
    platform: str,
    keyword: Keyword,
    api_key: str,
    collected_at: str,
    date_window_days: int | None,
    opener: Callable[..., Any],
) -> PlatformFetch:
    if provider == "scrapecreators":
        return fetch_scrapecreators_platform(
            platform,
            keyword,
            api_key=api_key,
            collected_at=collected_at,
            opener=opener,
        )
    if provider == "scrapeatlas":
        fetcher = _SCRAPEATLAS_FETCHERS.get(platform)
        if fetcher is None:
            return PlatformFetch(
                platform,
                "scrapeatlas",
                [],
                [],
                "unavailable",
                "unsupported_provider",
                0,
                ("scrapeatlas",),
            )
        return fetcher(
            keyword,
            api_key=api_key,
            collected_at=collected_at,
            opener=opener,
            date_window_days=date_window_days,
        )
    return PlatformFetch(
        platform,
        provider,
        [],
        [],
        "unavailable",
        "unsupported_provider",
        0,
        (provider,),
    )


def _is_retryable(detail: str) -> bool:
    return detail in RETRYABLE_DETAILS or detail.startswith("http_5")


def _merged_latency(primary: int | None, fallback: int | None) -> int | None:
    if primary is not None and fallback is not None:
        return primary + fallback
    return fallback if fallback is not None else primary


def fetch_platform(
    platform: str,
    keyword: Keyword,
    settings: Mapping[str, ProviderSetting],
    *,
    env: Mapping[str, Any],
    collected_at: str,
    date_window_days: int | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
    primary: Callable[..., PlatformFetch] | None = None,
    fallback: Callable[..., PlatformFetch] | None = None,
) -> PlatformFetch:
    mode = env.get("CARI_PROVIDER_MODE") if isinstance(env, Mapping) else None
    if not isinstance(mode, str) or not mode:
        mode = os.environ.get("CARI_PROVIDER_MODE", "live")
    if mode == "fixture":
        from sentiment_monitor.providers.fixtures import fixture_platform_fetch

        return fixture_platform_fetch(
            platform,
            keyword,
            collected_at=collected_at,
            date_window_days=date_window_days,
        )
    chain = resolve_chain(platform, settings)
    if not chain:
        return PlatformFetch(
            platform, "off", [], [], "unavailable", "unsupported_provider", 0, ()
        )
    first = chain[0]
    first_key = provider_api_key(first, env)
    if first_key is None:
        return PlatformFetch(
            platform, first, [], [], "unavailable", "missing_key", 0, (first,)
        )
    common = {
        "platform": platform,
        "keyword": keyword,
        "collected_at": collected_at,
        "date_window_days": date_window_days,
        "opener": opener,
    }
    if primary is not None:
        result = primary(api_key=first_key, **common)
    else:
        result = _dispatch(first, api_key=first_key, **common)
    result = replace(result, attempted_providers=(first,))
    if (
        len(chain) < 2
        or result.state != "failed"
        or not _is_retryable(result.safe_detail)
    ):
        return result
    second = chain[1]
    second_key = provider_api_key(second, env)
    attempted = (first, second)
    if second_key is None:
        return PlatformFetch(
            platform,
            second,
            list(result.posts),
            list(result.calls),
            "unavailable",
            "missing_key",
            result.latency_ms,
            attempted,
        )
    if fallback is not None:
        fallback_result = fallback(api_key=second_key, **common)
    else:
        fallback_result = _dispatch(second, api_key=second_key, **common)
    return replace(
        fallback_result,
        calls=list(result.calls) + list(fallback_result.calls),
        latency_ms=_merged_latency(result.latency_ms, fallback_result.latency_ms),
        attempted_providers=attempted,
    )
