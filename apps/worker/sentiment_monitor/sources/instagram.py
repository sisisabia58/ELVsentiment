from __future__ import annotations

import re
from typing import Any, Callable
import urllib.request

from sentiment_monitor.intent import Keyword
from sentiment_monitor.relevance import literal_match_status
from sentiment_monitor.sources.routes import request_params, routes_for, within_overlap
from sentiment_monitor.sources.scrapecreators import (
    ScrapeCreatorsError,
    carry_attempt_context,
    credits_from,
    dedupe_mentions,
    failure_counts,
    fetch_scrapecreators_json,
    hashtag_field_names,
    has_usable_mentions,
    known_credits,
    select_post_list,
    unix_to_iso,
)


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
        "hashtags": [
            *hashtag_field_names(media.get("hashtags")),
            *hashtag_field_names(media.get("edge_media_to_hashtag")),
        ],
        "url": url,
        "posted_at": unix_to_iso(raw_ts),
        "collected_at": collected_at,
    }


INSTAGRAM_PAGE2_LITERAL_MIN_PERCENT = 60
INSTAGRAM_PAGE2_MIN_PAGE_SIZE = 5


def should_fetch_instagram_page2(
    literal_count: int, total: int, cursor: Any
) -> bool:
    if cursor is None or (isinstance(cursor, str) and not cursor.strip()):
        return False
    if total < INSTAGRAM_PAGE2_MIN_PAGE_SIZE:
        return False
    return literal_count * 100 >= total * INSTAGRAM_PAGE2_LITERAL_MIN_PERCENT


def _post_keys(route) -> tuple[str, ...]:
    if route.id == "instagram.reels":
        return ("reels", "items", "data")
    return ("posts", "items", "medias", "data")


def _literal_page_count(items: list[dict[str, Any]], keyword: Keyword) -> int:
    return sum(
        1
        for item in items
        if literal_match_status(
            item["text"], str(keyword), "hashtag", hashtags=item.get("hashtags")
        ) == "literal_match"
    )


def fetch_instagram_mentions(
    variant: str,
    api_key: str,
    collected_at: str,
    *,
    intent: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    keyword = variant if isinstance(variant, Keyword) else Keyword(str(variant), intent or "phrase")
    routes = routes_for("instagram", keyword)
    credits: list[int | None] = []
    returned: int | None = None
    parsed_total = 0
    retained_total = 0
    collected: list[dict[str, Any]] = []
    http_status: int | None = None
    page2_route = None
    page2_cursor: str | None = None
    route_errors: list[ScrapeCreatorsError] = []

    for route in routes:
        if route.conditional:
            page2_route = route
            continue

        try:
            payload = fetch_scrapecreators_json(
                route.path,
                request_params(route, keyword, now=collected_at),
                api_key,
                opener=opener,
            )
        except ScrapeCreatorsError as error:
            if credits or returned is not None or parsed_total:
                raise carry_attempt_context(
                    error, credits, returned, collected, parsed=parsed_total
                ) from None
            if error.credits_charged is not None:
                credits.append(error.credits_charged)
            route_errors.append(error)
            continue
        http_status = getattr(payload, "http_status", None)
        credits.append(credits_from(payload))
        try:
            raw_items = select_post_list(payload, _post_keys(route))
        except ScrapeCreatorsError as error:
            raise carry_attempt_context(
                error, credits, returned, collected, http_status=http_status, parsed=parsed_total
            ) from None
        returned = len(raw_items) if returned is None else returned + len(raw_items)
        normalized_items = [
            normalize_instagram_item(item, collected_at)
            for item in raw_items
            if isinstance(item, dict)
        ]
        parsed_total += len(normalized_items)
        retained_items = [
            {**item, "route_id": route.id}
            for item in normalized_items
            if within_overlap(item["posted_at"], collected_at, route)
        ]
        retained_total += len(retained_items)
        collected.extend(retained_items)
        if raw_items and not has_usable_mentions(normalized_items):
            counts = failure_counts(returned, collected)
            counts["parsed"] = parsed_total
            raise ScrapeCreatorsError(
                "malformed_posts",
                http_status=http_status,
                credits_charged=known_credits(credits),
                counts=counts,
            )

        if route.id == "instagram.hashtag":
            cursor = payload.get("cursor")
            if isinstance(cursor, int):
                cursor = str(cursor)
            if should_fetch_instagram_page2(
                _literal_page_count(normalized_items, keyword),
                len(normalized_items),
                cursor,
            ):
                page2_cursor = str(cursor)

    if returned is None and route_errors:
        first_error = route_errors[0]
        if credits or collected or parsed_total:
            # The continue path already appended this first route's credits.
            raise carry_attempt_context(
                first_error,
                credits,
                returned,
                collected,
                parsed=parsed_total,
                error_credits_already_counted=True,
            ) from None
        raise first_error

    if page2_route is not None and page2_cursor is not None:
        params = request_params(page2_route, keyword, now=collected_at)
        params["cursor"] = page2_cursor
        try:
            payload = fetch_scrapecreators_json(
                page2_route.path,
                params,
                api_key,
                opener=opener,
            )
        except ScrapeCreatorsError as error:
            raise carry_attempt_context(
                error,
                credits,
                returned,
                collected,
                parsed=parsed_total,
            ) from None
        http_status = getattr(payload, "http_status", None)
        credits.append(credits_from(payload))
        try:
            raw_items = select_post_list(payload, _post_keys(page2_route))
        except ScrapeCreatorsError as error:
            raise carry_attempt_context(
                error,
                credits,
                returned,
                collected,
                http_status=http_status,
                parsed=parsed_total,
            ) from None
        returned = len(raw_items) if returned is None else returned + len(raw_items)
        normalized_items = [
            normalize_instagram_item(item, collected_at)
            for item in raw_items
            if isinstance(item, dict)
        ]
        parsed_total += len(normalized_items)
        retained_items = [
            {**item, "route_id": page2_route.id}
            for item in normalized_items
            if within_overlap(item["posted_at"], collected_at, page2_route)
        ]
        retained_total += len(retained_items)
        collected.extend(retained_items)
        if raw_items and not has_usable_mentions(normalized_items):
            counts = failure_counts(returned, collected)
            counts["parsed"] = parsed_total
            raise ScrapeCreatorsError(
                "malformed_posts",
                http_status=http_status,
                credits_charged=known_credits(credits),
                counts=counts,
            )

    mentions = dedupe_mentions(collected)
    counts = {
        "returned": returned,
        "parsed": parsed_total,
        "deduplicated": retained_total - len(mentions),
    }
    dropped = parsed_total - retained_total
    if dropped > 0:
        counts["dropped_out_of_window"] = dropped
    return {
        "mentions": mentions,
        "outcome": "success",
        "counts": counts,
        "credits_charged": known_credits(credits),
        "http_status": http_status,
    }
