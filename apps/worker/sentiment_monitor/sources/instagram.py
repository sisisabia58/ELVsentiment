from __future__ import annotations

import re
from typing import Any, Callable
import urllib.request

from sentiment_monitor.sources.scrapecreators import (
    DEFAULT_REGION,
    ScrapeCreatorsError,
    credits_from,
    dedupe_mentions,
    fetch_scrapecreators_json,
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
    reels_payload = fetch_scrapecreators_json(
        INSTAGRAM_REELS_SEARCH_PATH,
        {"query": variant},
        api_key,
        region=region,
        opener=opener,
    )
    reels_raw = select_post_list(reels_payload, ("reels", "items", "data"))
    collected: list[dict[str, Any]] = [
        normalize_instagram_item(item, collected_at)
        for item in reels_raw
        if isinstance(item, dict)
    ]
    credits = [credits_from(reels_payload)]
    returned = len(reels_raw)

    hashtag = normalize_hashtag(variant)
    if hashtag:
        hashtag_payload = fetch_scrapecreators_json(
            INSTAGRAM_HASHTAG_SEARCH_PATH,
            {"hashtag": hashtag},
            api_key,
            region=region,
            opener=opener,
        )
        hashtag_raw = select_post_list(hashtag_payload, ("posts", "items", "medias", "data"))
        returned += len(hashtag_raw)
        credits.append(credits_from(hashtag_payload))
        collected.extend(
            normalize_instagram_item(item, collected_at)
            for item in hashtag_raw
            if isinstance(item, dict)
        )

    mentions = dedupe_mentions(collected)
    if returned and not mentions:
        raise ScrapeCreatorsError("malformed_posts")
    known_credits = [value for value in credits if value is not None]
    return {
        "mentions": mentions,
        "outcome": "success",
        "counts": {
            "returned": returned,
            "parsed": len(collected),
            "deduplicated": len(collected) - len(mentions),
        },
        "credits_charged": sum(known_credits) if known_credits else None,
    }
