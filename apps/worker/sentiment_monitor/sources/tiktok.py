from __future__ import annotations

from typing import Any, Callable
import urllib.request

from sentiment_monitor.sources.scrapecreators import (
    DEFAULT_REGION,
    credits_from,
    dedupe_mentions,
    fetch_scrapecreators_json,
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
    region: str = DEFAULT_REGION,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    keyword_payload = fetch_scrapecreators_json(
        TIKTOK_KEYWORD_SEARCH_PATH,
        {"query": variant},
        api_key,
        region=region,
        opener=opener,
    )
    top_payload = fetch_scrapecreators_json(
        TIKTOK_TOP_SEARCH_PATH,
        {"query": variant},
        api_key,
        region=region,
        opener=opener,
    )
    keyword_raw = _extract_tiktok_list(keyword_payload)
    top_raw = _extract_tiktok_list(top_payload)
    collected = [
        normalize_tiktok_item(item, collected_at)
        for item in (*keyword_raw, *top_raw)
        if isinstance(item, dict)
    ]
    mentions = dedupe_mentions(collected)
    known_credits = [
        value
        for value in (credits_from(keyword_payload), credits_from(top_payload))
        if value is not None
    ]
    return {
        "mentions": mentions,
        "outcome": "success",
        "counts": {
            "returned": len(keyword_raw) + len(top_raw),
            "parsed": len(collected),
            "deduplicated": len(collected) - len(mentions),
        },
        "credits_charged": sum(known_credits) if known_credits else None,
    }
