from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
import urllib.request

from harken.models import Mention
from harken.sources import REGISTRY
from harken.sources.base import FetchPage, Source

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


def _extract_threads_text(item: dict[str, Any]) -> str:
    caption = item.get("caption")
    if isinstance(caption, dict) and isinstance(caption.get("text"), str):
        return caption["text"]
    if isinstance(caption, str):
        return caption
    if isinstance(item.get("text"), str):
        return item["text"]
    app_info = item.get("text_post_app_info")
    if isinstance(app_info, dict):
        fragments = (app_info.get("text_fragments") or {}).get("fragments")
        if isinstance(fragments, list):
            parts = [str(f.get("plaintext") or "") for f in fragments if isinstance(f, dict)]
            joined = "".join(parts).strip()
            if joined:
                return joined
    return ""


def _extract_threads_author(item: dict[str, Any]) -> str | None:
    user = item.get("user")
    if isinstance(user, dict) and isinstance(user.get("username"), str):
        return user["username"]
    if isinstance(item.get("username"), str):
        return item["username"]
    return None


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


def _threads_thumbnail(item: dict[str, Any]) -> str | None:
    images = item.get("image_versions2")
    if isinstance(images, dict):
        candidates = images.get("candidates")
        if isinstance(candidates, list):
            for candidate in candidates:
                if isinstance(candidate, dict):
                    url = _optional_text(candidate.get("url"))
                    if url:
                        return url
    videos = item.get("video_versions")
    if isinstance(videos, list):
        for video in videos:
            if isinstance(video, dict):
                url = _optional_text(video.get("url"))
                if url:
                    return url
    return None


def normalize_threads_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]:
    external_id = str(item.get("pk") or item.get("id") or item.get("code") or "")
    author = _extract_threads_author(item)
    user = item.get("user") if isinstance(item.get("user"), dict) else {}
    app_info = (
        item.get("text_post_app_info")
        if isinstance(item.get("text_post_app_info"), dict)
        else {}
    )
    code = item.get("code")
    url = item.get("url") or item.get("permalink")
    if not url and author and code:
        url = f"https://www.threads.com/@{author}/post/{code}"
    posted_at = unix_to_iso(item.get("taken_at") if item.get("taken_at") is not None else item.get("timestamp"))
    return {
        "external_id": external_id,
        "source": "threads",
        "author": author,
        "author_handle": author,
        "author_name": _optional_text(user.get("full_name") or user.get("name")),
        "title": None,
        "text": _extract_threads_text(item),
        "hashtags": hashtag_field_names(item.get("hashtags")),
        "url": url,
        "posted_at": posted_at,
        "thumbnail_url": _threads_thumbnail(item),
        "views": _optional_int(item.get("view_count") or item.get("play_count")),
        "likes": _optional_int(item.get("like_count")),
        "replies": _optional_int(app_info.get("direct_reply_count")),
        "shares": _optional_int(app_info.get("repost_count")),
        "collected_at": collected_at,
    }


def fetch_threads_mentions(
    variant: str,
    api_key: str,
    collected_at: str,
    *,
    intent: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    keyword = variant if isinstance(variant, Keyword) else Keyword(str(variant), intent or "phrase")
    route = routes_for("threads", keyword)[0]
    params = request_params(route, keyword, now=collected_at)
    credits: list[int | None] = []
    route_events: list[dict[str, Any]] = []
    try:
        payload = fetch_scrapecreators_json(
            route.path, params, api_key, opener=opener
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
        status = error.http_status
        if not (type(status) is int and 500 <= status <= 599):
            raise attach_route_events(error, route_events) from None
        if error.credits_charged is not None:
            credits.append(error.credits_charged)
        try:
            payload = fetch_scrapecreators_json(
                route.path, params, api_key, opener=opener
            )
        except ScrapeCreatorsError as retry_error:
            route_events.append(
                route_event(
                    route.id,
                    "failed",
                    http_status=retry_error.http_status,
                    credits_charged=retry_error.credits_charged,
                    detail=retry_error.code,
                    body_length=getattr(retry_error, "body_length", None),
                )
            )
            raise carry_attempt_context(
                retry_error,
                credits,
                None,
                [],
                body_length=getattr(retry_error, "body_length", None),
                route_events=route_events,
            ) from None

    http_status = getattr(payload, "http_status", None)
    payload_credits = credits_from(payload)
    credits.append(payload_credits)
    route_events.append(
        route_event(
            route.id,
            "success",
            http_status=http_status,
            credits_charged=payload_credits,
            detail="ok",
            body_length=getattr(payload, "body_length", None),
        )
    )
    returned: int | None = None
    try:
        raw_items = select_post_list(payload, ("posts", "items", "data"))
    except ScrapeCreatorsError as error:
        route_events[-1] = route_event(
            route.id,
            "failed",
            http_status=http_status,
            credits_charged=payload_credits,
            detail=error.code,
            body_length=getattr(error, "body_length", None),
        )
        raise carry_attempt_context(
            error,
            credits,
            returned,
            [],
            http_status=http_status,
            route_events=route_events,
        ) from None
    returned = len(raw_items)
    try:
        normalized_items = [
            normalize_threads_item(item, collected_at)
            for item in raw_items
            if isinstance(item, dict)
        ]
        items = [
            {**item, "route_id": route.id}
            for item in normalized_items
            if within_overlap(item["posted_at"], collected_at, route)
        ]
        mentions = dedupe_mentions(items)
    except Exception as error:
        route_events[-1] = route_event(
            route.id,
            "failed",
            http_status=http_status,
            credits_charged=payload_credits,
            detail=_route_error_detail(error),
            body_length=getattr(error, "body_length", None),
        )
        raise carry_attempt_context(
            error,
            credits,
            returned,
            [],
            http_status=http_status,
            route_events=route_events,
        ) from None
    if raw_items and not has_usable_mentions(normalized_items):
        route_events[-1] = route_event(
            route.id,
            "failed",
            http_status=http_status,
            credits_charged=payload_credits,
            detail="malformed_posts",
            body_length=getattr(payload, "body_length", None),
        )
        raise ScrapeCreatorsError(
            "malformed_posts",
            http_status=http_status,
            credits_charged=known_credits(credits),
            counts=failure_counts(returned, items),
            body_length=getattr(payload, "body_length", None),
            route_events=route_events,
        )
    counts = {
        "returned": len(raw_items),
        "parsed": len(normalized_items),
        "deduplicated": len(items) - len(mentions),
    }
    dropped = len(normalized_items) - len(items)
    if dropped > 0:
        counts["dropped_out_of_window"] = dropped
    return {
        "mentions": mentions,
        "outcome": "empty_or_success",
        "counts": counts,
        "credits_charged": known_credits(credits),
        "http_status": http_status,
        "route_events": route_events,
    }


class ThreadsSource(Source):
    name = "threads"
    label = "Threads"
    needs_config = True

    def __init__(self, access_token: str | None = None, **options):
        super().__init__(**options)
        self.access_token = access_token

    def fetch(self, query: str, limit: int = 25) -> list[Mention]:
        return self.fetch_page(query, limit=limit).mentions

    def fetch_page(
        self,
        query: str,
        limit: int = 25,
        *,
        cursor: str | None = None,
        since: datetime | None = None,
    ) -> FetchPage:
        del cursor, limit, since
        if not self.access_token:
            raise RuntimeError("Threads requires an API key")
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        result = fetch_threads_mentions(
            query,
            self.access_token,
            now_iso,
            intent=getattr(query, "intent", "phrase"),
        )
        mentions: list[Mention] = []
        for item in result.get("mentions", []):
            ext_id = item.get("external_id")
            if not ext_id:
                continue
            posted = item.get("posted_at")
            created_at = _parse_timestamp(posted) if isinstance(posted, str) else datetime.now(timezone.utc)
            mentions.append(
                Mention(
                    id=str(ext_id),
                    source=self.name,
                    query=query,
                    author=item.get("author"),
                    text=item.get("text") or "",
                    url=item.get("url"),
                    created_at=created_at,
                )
            )
        return FetchPage(mentions, None)


def register_threads() -> None:
    REGISTRY["threads"] = ThreadsSource


def _parse_timestamp(value: str | None) -> datetime:
    if value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00").replace("+0000", "+00:00"))
        except ValueError:
            pass
    return datetime.now(timezone.utc)
