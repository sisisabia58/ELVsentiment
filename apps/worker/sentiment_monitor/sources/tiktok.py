from __future__ import annotations

from typing import Any, Callable
import urllib.request

from sentiment_monitor.intent import Keyword
from sentiment_monitor.sources.routes import request_params, routes_for, within_overlap
from sentiment_monitor.sources.scrapecreators import (
    ScrapeCreatorsError,
    attach_route_events,
    carry_attempt_context,
    credits_from,
    dedupe_mentions,
    failure_counts,
    fetch_scrapecreators_json,
    hashtag_field_names,
    has_usable_mentions,
    known_credits,
    route_event,
    select_post_list,
    unix_to_iso,
)


def _route_error_detail(error: Exception) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) else "collection_failed"


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


def _tiktok_hashtags(aweme: dict[str, Any]) -> list[str]:
    values: list[Any] = []
    for key in ("text_extra", "challenges"):
        value = aweme.get(key)
        if isinstance(value, list):
            values.extend(value)
    return hashtag_field_names(values)


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


def normalize_tiktok_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]:
    aweme = item.get("aweme_info") if isinstance(item.get("aweme_info"), dict) else item
    external_id = str(aweme.get("aweme_id") or aweme.get("id") or "")
    author = _extract_tiktok_author(aweme)
    author_info = aweme.get("author") if isinstance(aweme.get("author"), dict) else {}
    stats = aweme.get("stats") if isinstance(aweme.get("stats"), dict) else {}
    video = aweme.get("video") if isinstance(aweme.get("video"), dict) else {}
    text = str(aweme.get("desc") or aweme.get("text") or "")
    url = aweme.get("share_url") or aweme.get("url")
    if not url and author and external_id:
        url = f"https://www.tiktok.com/@{author}/video/{external_id}"
    raw_ts = aweme.get("create_time") if aweme.get("create_time") is not None else aweme.get("posted_at")
    return {
        "external_id": external_id,
        "source": "tiktok",
        "author": author,
        "author_handle": author,
        "author_name": _optional_text(author_info.get("nickname") or author_info.get("name")),
        "title": None,
        "text": text,
        "hashtags": _tiktok_hashtags(aweme),
        "url": url,
        "posted_at": unix_to_iso(raw_ts),
        "thumbnail_url": _optional_text(video.get("cover") or video.get("originCover")),
        "views": _optional_int(stats.get("playCount")),
        "likes": _optional_int(stats.get("diggCount")),
        "replies": _optional_int(stats.get("commentCount")),
        "shares": _optional_int(stats.get("shareCount")),
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
    parsed_total = 0
    retained_total = 0
    collected: list[dict[str, Any]] = []
    http_status: int | None = None
    route_errors: list[ScrapeCreatorsError] = []
    route_events: list[dict[str, Any]] = []

    for route in routes:
        try:
            payload = fetch_scrapecreators_json(
                route.path,
                request_params(route, keyword),
                api_key,
                opener=opener,
            )
        except ScrapeCreatorsError as error:
            route_events.append(
                route_event(
                    route.id,
                    "failed",
                    http_status=error.http_status,
                    credits_charged=error.credits_charged,
                    detail=error.code,
                    body_length=getattr(error, "body_length", None),
                )
            )
            if credits or returned is not None or parsed_total:
                raise carry_attempt_context(
                    error,
                    credits,
                    returned,
                    collected,
                    parsed=parsed_total,
                    route_events=route_events,
                ) from None
            if error.credits_charged is not None:
                credits.append(error.credits_charged)
            route_errors.append(error)
            continue
        http_status = getattr(payload, "http_status", None)
        route_credits = credits_from(payload)
        credits.append(route_credits)
        route_events.append(
            route_event(
                route.id,
                "success",
                http_status=http_status,
                credits_charged=route_credits,
                detail="ok",
                body_length=getattr(payload, "body_length", None),
            )
        )
        try:
            raw = _extract_tiktok_list(payload)
        except ScrapeCreatorsError as error:
            route_events[-1] = route_event(
                route.id,
                "failed",
                http_status=http_status,
                credits_charged=route_credits,
                detail=error.code,
                body_length=getattr(error, "body_length", None),
            )
            raise carry_attempt_context(
                error,
                credits,
                returned,
                collected,
                http_status=http_status,
                parsed=parsed_total,
                route_events=route_events,
            ) from None
        except Exception as error:
            route_events[-1] = route_event(
                route.id,
                "failed",
                http_status=http_status,
                credits_charged=route_credits,
                detail=_route_error_detail(error),
                body_length=getattr(error, "body_length", None),
            )
            raise carry_attempt_context(
                error,
                credits,
                returned,
                collected,
                http_status=http_status,
                parsed=parsed_total,
                route_events=route_events,
            ) from None
        try:
            normalized_items = [
                normalize_tiktok_item(item, collected_at)
                for item in raw
                if isinstance(item, dict)
            ]
        except Exception as error:
            route_events[-1] = route_event(
                route.id,
                "failed",
                http_status=http_status,
                credits_charged=route_credits,
                detail=_route_error_detail(error),
                body_length=getattr(error, "body_length", None),
            )
            raise carry_attempt_context(
                error,
                credits,
                returned,
                collected,
                http_status=http_status,
                parsed=parsed_total,
                route_events=route_events,
            ) from None
        returned = len(raw) if returned is None else returned + len(raw)
        try:
            parsed_total += len(normalized_items)
            retained = [
                {**item, "route_id": route.id}
                for item in normalized_items
                if within_overlap(item["posted_at"], collected_at, route)
            ]
            retained_total += len(retained)
            collected.extend(retained)
        except Exception as error:
            route_events[-1] = route_event(
                route.id,
                "failed",
                http_status=http_status,
                credits_charged=route_credits,
                detail=_route_error_detail(error),
                body_length=getattr(error, "body_length", None),
            )
            raise carry_attempt_context(
                error,
                credits,
                returned,
                collected,
                http_status=http_status,
                parsed=parsed_total,
                route_events=route_events,
            ) from None
        if raw and not has_usable_mentions(normalized_items):
            counts = failure_counts(returned, collected)
            counts["parsed"] = parsed_total
            route_events[-1] = route_event(
                route.id,
                "failed",
                http_status=http_status,
                credits_charged=route_credits,
                detail="malformed_posts",
                body_length=getattr(payload, "body_length", None),
            )
            raise ScrapeCreatorsError(
                "malformed_posts",
                http_status=http_status,
                credits_charged=known_credits(credits),
                counts=counts,
                body_length=getattr(payload, "body_length", None),
                route_events=route_events,
            )

    if returned is None and route_errors:
        first_error = route_errors[0]
        if credits or collected or parsed_total:
            # Keep parity with Instagram: an error already appended by the
            # continue path must not have its credit counted a second time.
            raise carry_attempt_context(
                first_error,
                credits,
                returned,
                collected,
                parsed=parsed_total,
                error_credits_already_counted=True,
                route_events=route_events,
            ) from None
        raise attach_route_events(first_error, route_events)

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
        "route_events": route_events,
    }
