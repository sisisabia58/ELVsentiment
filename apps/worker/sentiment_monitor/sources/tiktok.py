from __future__ import annotations

from typing import Any, Callable
import urllib.request

from sentiment_monitor.intent import Keyword
from sentiment_monitor.sources.routes import request_params, routes_for, within_overlap
from sentiment_monitor.sources.scrapecreators import (
    ScrapeCreatorsError,
    carry_attempt_context,
    credits_from,
    dedupe_mentions,
    failure_counts,
    fetch_scrapecreators_json,
    has_usable_mentions,
    known_credits,
    select_post_list,
    unix_to_iso,
)

TIKTOK_KEYWORD_SEARCH_PATH = "/v1/tiktok/search/keyword"
TIKTOK_TOP_SEARCH_PATH = "/v1/tiktok/search/top"
TIKTOK_KEYWORD_SEARCH_URL = f"https://api.scrapecreators.com{TIKTOK_KEYWORD_SEARCH_PATH}"
TIKTOK_TOP_SEARCH_URL = f"https://api.scrapecreators.com{TIKTOK_TOP_SEARCH_PATH}"


def _extract_tiktok_author(aweme: dict[str, Any]) -> str | None:
    author = aweme.get("author")
    if isinstance(author, dict):
        for key in ("unique_id", "uniqueId", "nickname"):
            val = author.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    if isinstance(author, str) and author.strip():
        return author.strip()
    return None


def normalize_tiktok_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]:
    aweme = item.get("aweme_info") if isinstance(item.get("aweme_info"), dict) else item
    external_id = str(aweme.get("aweme_id") or aweme.get("id") or "")
    author = _extract_tiktok_author(aweme)
    text = str(aweme.get("desc") or aweme.get("text") or "")
    url = aweme.get("share_url") or aweme.get("url")
    if not url and author and external_id:
        url = f"https://www.tiktok.com/@{author}/video/{external_id}"
    raw_ts = aweme.get("create_time") if aweme.get("create_time") is not None else aweme.get("posted_at")
    return {
        "external_id": external_id,
        "source": "tiktok",
        "author": author,
        "text": text,
        "url": url,
        "posted_at": unix_to_iso(raw_ts),
        "collected_at": collected_at,
    }


def _extract_tiktok_list(payload: dict[str, Any]) -> list[Any]:
    return select_post_list(payload, ("search_item_list", "aweme_list", "items", "data"))


def fetch_tiktok_mentions(
    variant: str,
    api_key: str,
    collected_at: str,
    *,
    intent: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    keyword = variant if isinstance(variant, Keyword) else Keyword(str(variant), intent or "phrase")
    routes = routes_for("tiktok", keyword)
    credits: list[int | None] = []
    returned: int | None = None
    collected: list[dict[str, Any]] = []
    http_status: int | None = None

    for route in routes:
        try:
            payload = fetch_scrapecreators_json(
                route.path,
                request_params(route, keyword),
                api_key,
                opener=opener,
            )
        except ScrapeCreatorsError as error:
            raise carry_attempt_context(error, credits, returned, collected) from None
        http_status = getattr(payload, "http_status", None)
        credits.append(credits_from(payload))
        try:
            raw = _extract_tiktok_list(payload)
        except ScrapeCreatorsError as error:
            raise carry_attempt_context(error, credits, returned, collected, http_status=http_status) from None
        normalized_items = [
            normalize_tiktok_item(item, collected_at)
            for item in raw
            if isinstance(item, dict)
        ]
        returned = len(raw) if returned is None else returned + len(raw)
        collected.extend(
            {**item, "route_id": route.id}
            for item in normalized_items
            if within_overlap(item["posted_at"], collected_at, route)
        )
        if raw and not has_usable_mentions(normalized_items):
            raise ScrapeCreatorsError(
                "malformed_posts",
                http_status=http_status,
                credits_charged=known_credits(credits),
                counts=failure_counts(returned, collected),
            )

    mentions = dedupe_mentions(collected)
    return {
        "mentions": mentions,
        "outcome": "success",
        "counts": {
            "returned": returned,
            "parsed": len(collected),
            "deduplicated": len(collected) - len(mentions),
        },
        "credits_charged": known_credits(credits),
        "http_status": http_status,
    }
