from __future__ import annotations

import re
from typing import Any, Callable
import urllib.request

from sentiment_monitor.sources.scrapecreators import (
    DEFAULT_REGION,
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

INSTAGRAM_REELS_SEARCH_PATH = "/v2/instagram/reels/search"
INSTAGRAM_HASHTAG_SEARCH_PATH = "/v1/instagram/search/hashtag"
INSTAGRAM_REELS_SEARCH_URL = f"https://api.scrapecreators.com{INSTAGRAM_REELS_SEARCH_PATH}"
INSTAGRAM_HASHTAG_SEARCH_URL = f"https://api.scrapecreators.com{INSTAGRAM_HASHTAG_SEARCH_PATH}"


def normalize_hashtag(variant: str) -> str:
    cleaned = re.sub(r"[^\w]+", "", variant.strip(), flags=re.UNICODE)
    return cleaned.lower()


def _extract_instagram_text(media: dict[str, Any]) -> str:
    caption = media.get("caption")
    if isinstance(caption, dict) and isinstance(caption.get("text"), str):
        return caption["text"]
    if isinstance(caption, str):
        return caption
    if isinstance(media.get("text"), str):
        return media["text"]
    edges = (media.get("edge_media_to_caption") or {}).get("edges")
    if isinstance(edges, list) and edges:
        first = edges[0]
        if isinstance(first, dict):
            node = first.get("node")
            if isinstance(node, dict) and isinstance(node.get("text"), str):
                return node["text"]
    return ""


def _extract_instagram_author(media: dict[str, Any]) -> str | None:
    for key in ("user", "owner"):
        actor = media.get(key)
        if isinstance(actor, dict) and isinstance(actor.get("username"), str):
            return actor["username"]
    if isinstance(media.get("username"), str):
        return media["username"]
    return None


def normalize_instagram_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]:
    media = item.get("media") if isinstance(item.get("media"), dict) else item
    code = media.get("code") or media.get("shortcode")
    external_id = str(media.get("pk") or media.get("id") or code or "")
    author = _extract_instagram_author(media)
    url = media.get("url") or media.get("permalink")
    if not url and code:
        url = f"https://www.instagram.com/p/{code}/"
    raw_ts = (
        media.get("taken_at")
        if media.get("taken_at") is not None
        else media.get("taken_at_timestamp")
        if media.get("taken_at_timestamp") is not None
        else media.get("timestamp")
    )
    return {
        "external_id": external_id,
        "source": "instagram",
        "author": author,
        "text": _extract_instagram_text(media),
        "url": url,
        "posted_at": unix_to_iso(raw_ts),
        "collected_at": collected_at,
    }


def fetch_instagram_mentions(
    variant: str,
    api_key: str,
    collected_at: str,
    *,
    region: str = DEFAULT_REGION,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    credits: list[int | None] = []
    returned = 0
    collected: list[dict[str, Any]] = []

    try:
        reels_payload = fetch_scrapecreators_json(
            INSTAGRAM_REELS_SEARCH_PATH,
            {"query": variant},
            api_key,
            region=region,
            opener=opener,
        )
    except ScrapeCreatorsError as error:
        raise carry_attempt_context(error, credits, returned, collected) from None
    credits.append(credits_from(reels_payload))

    try:
        reels_raw = select_post_list(reels_payload, ("reels", "items", "data"))
    except ScrapeCreatorsError as error:
        raise carry_attempt_context(error, credits, returned, collected) from None
    reels_items = [
        normalize_instagram_item(item, collected_at)
        for item in reels_raw
        if isinstance(item, dict)
    ]
    returned += len(reels_raw)
    collected.extend(reels_items)
    if reels_raw and not has_usable_mentions(reels_items):
        raise ScrapeCreatorsError(
            "malformed_posts",
            credits_charged=known_credits(credits),
            counts=failure_counts(returned, collected),
        )

    hashtag = normalize_hashtag(variant)
    if hashtag:
        try:
            hashtag_payload = fetch_scrapecreators_json(
                INSTAGRAM_HASHTAG_SEARCH_PATH,
                {"hashtag": hashtag},
                api_key,
                region=region,
                opener=opener,
            )
        except ScrapeCreatorsError as error:
            raise carry_attempt_context(error, credits, returned, collected) from None
        credits.append(credits_from(hashtag_payload))
        try:
            hashtag_raw = select_post_list(hashtag_payload, ("posts", "items", "medias", "data"))
        except ScrapeCreatorsError as error:
            raise carry_attempt_context(error, credits, returned, collected) from None
        hashtag_items = [
            normalize_instagram_item(item, collected_at)
            for item in hashtag_raw
            if isinstance(item, dict)
        ]
        returned += len(hashtag_raw)
        collected.extend(hashtag_items)
        if hashtag_raw and not has_usable_mentions(hashtag_items):
            raise ScrapeCreatorsError(
                "malformed_posts",
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
    }
