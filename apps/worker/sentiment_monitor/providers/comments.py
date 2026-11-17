"""ScrapeAtlas comment adapters (offline, one page per post)."""

from __future__ import annotations

from dataclasses import dataclass, replace
import time
from typing import Any, Callable, Mapping
from sentiment_monitor.providers.http import urlopen as safe_urlopen

from sentiment_monitor.providers.canonical import (
    CanonicalComment,
    CanonicalPost,
    RouteCall,
    comment_has_visible_text,
)
from sentiment_monitor.providers.capabilities import ProviderSetting, resolve_chain
from sentiment_monitor.providers.fetch import provider_api_key
from sentiment_monitor.providers.scrapeatlas import ScrapeAtlasError, fetch_scrapeatlas_json
from sentiment_monitor.sources.scrapecreators import unix_to_iso

COMMENT_ENDPOINTS = {
    "threads": "/v1/threads/post/comments",
    "tiktok": "/v1/tiktok/video/comments",
    "instagram": "/v1/instagram/post/comments",
    "youtube": "/v1/youtube/video/comments",
    "facebook": "/v1/facebook/post/comments",
    "reddit": "/v1/reddit/post/comments",
}


@dataclass(frozen=True)
class CommentFetch:
    post_id: str
    comments: list[CanonicalComment]
    call: RouteCall | None
    state: str
    safe_detail: str


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text.isascii() and text.isdigit():
            return int(text)
    return None


def _optional_text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def _has_media(item: Mapping[str, Any]) -> bool:
    for key in ("attachments", "attachment", "media", "sticker"):
        value = item.get(key)
        if isinstance(value, (list, dict)) and len(value) > 0:
            return True
        if isinstance(value, str) and value.strip():
            return True
    return False


def _threads_text(item: Mapping[str, Any]) -> str:
    text = _optional_text(item.get("text"))
    if text:
        return text
    caption = item.get("caption")
    if isinstance(caption, dict):
        return _optional_text(caption.get("text")) or ""
    if isinstance(caption, str):
        return caption.strip()
    return ""


def _reddit_replies(item: Mapping[str, Any]) -> int | None:
    replies = item.get("replies")
    if isinstance(replies, dict):
        items = replies.get("items")
        if isinstance(items, list):
            return len(items)
    if isinstance(replies, list):
        return len(replies)
    return None


def _comment(platform: str, item: Mapping[str, Any]) -> CanonicalComment:
    author = _mapping(item.get("author"))
    user = _mapping(item.get("user"))
    if platform == "threads":
        external_id = str(item.get("pk") or item.get("id") or "")
        text = _threads_text(item)
        author_handle = _optional_text(user.get("username"))
        author_name = _optional_text(user.get("full_name") or user.get("name"))
        published_at = unix_to_iso(item.get("taken_at"))
        likes = _optional_int(item.get("like_count"))
        replies = _optional_int(_mapping(item.get("text_post_app_info")).get("direct_reply_count"))
    elif platform == "tiktok":
        external_id = str(item.get("cid") or item.get("id") or "")
        text = _optional_text(item.get("text")) or ""
        author_handle = _optional_text(user.get("uniqueId") or user.get("unique_id"))
        author_name = _optional_text(user.get("nickname") or user.get("name"))
        published_at = unix_to_iso(item.get("create_time"))
        likes = _optional_int(item.get("digg_count"))
        replies = _optional_int(item.get("reply_comment_total"))
    elif platform == "instagram":
        external_id = str(item.get("id") or item.get("pk") or "")
        text = _optional_text(item.get("text")) or ""
        author_handle = _optional_text(user.get("username"))
        author_name = _optional_text(user.get("full_name") or user.get("name"))
        published_at = _optional_text(item.get("created_at"))
        likes = _optional_int(item.get("comment_like_count"))
        replies = _optional_int(item.get("child_comment_count"))
    elif platform == "youtube":
        external_id = str(item.get("id") or "")
        text = _optional_text(item.get("content")) or ""
        author_handle = _optional_text(author.get("name"))
        author_name = _optional_text(author.get("name"))
        published_at = _optional_text(item.get("publishedTime"))
        engagement = _mapping(item.get("engagement"))
        likes = _optional_int(engagement.get("likes"))
        replies = _optional_int(engagement.get("replies"))
    elif platform == "facebook":
        external_id = str(item.get("id") or "")
        text = _optional_text(item.get("text")) or ""
        author_handle = _optional_text(author.get("name"))
        author_name = _optional_text(author.get("name"))
        published_at = _optional_text(item.get("created_at"))
        likes = _optional_int(item.get("reaction_count"))
        replies = _optional_int(item.get("reply_count"))
    else:
        external_id = str(item.get("id") or "")
        text = _optional_text(item.get("body")) or ""
        author_handle = _optional_text(item.get("author"))
        author_name = _optional_text(item.get("author"))
        published_at = _optional_text(item.get("created_at_iso") or item.get("created_at"))
        likes = _optional_int(item.get("score"))
        replies = _reddit_replies(item)
    return CanonicalComment(
        external_id=external_id,
        text=text,
        author_name=author_name,
        author_handle=author_handle,
        published_at=published_at,
        likes=likes,
        replies=replies,
        source_provider="scrapeatlas",
        raw_ref=f"scrapeatlas:comments:{platform}:{external_id}",
    )


def fetch_comments(
    platform: str,
    post: CanonicalPost,
    *,
    settings: Mapping[str, ProviderSetting],
    env: Mapping[str, Any],
    opener: Callable[..., Any] = safe_urlopen,
    timeout: int = 20,
) -> CommentFetch:
    post_id = str(post.external_id or "")
    path = COMMENT_ENDPOINTS.get(platform)
    chain = resolve_chain(platform, settings, mode="comments")
    if path is None or not chain or chain[0] != "scrapeatlas":
        return CommentFetch(post_id, [], None, "unavailable", "unsupported_provider")
    api_key = provider_api_key("scrapeatlas", env)
    if api_key is None:
        return CommentFetch(post_id, [], None, "unavailable", "missing_key")
    url = _optional_text(post.url)
    if url is None:
        return CommentFetch(post_id, [], None, "unavailable", "missing_url")
    params: dict[str, Any] = {"url": url}
    if platform == "facebook":
        params["sort"] = "newest"
    route_id = f"scrapeatlas.{platform}.comments"
    started = time.monotonic()
    try:
        payload = fetch_scrapeatlas_json(path, params, api_key, opener=opener, timeout=timeout)
    except ScrapeAtlasError as error:
        latency_ms = int((time.monotonic() - started) * 1000)
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
            return CommentFetch(post_id, [], call, "answered", "not_found")
        return CommentFetch(post_id, [], call, "failed", error.code)
    latency_ms = int((time.monotonic() - started) * 1000)
    raw_comments = payload.get("comments")
    items = raw_comments if isinstance(raw_comments, list) else []
    comments = []
    for item in items:
        if not isinstance(item, dict):
            continue
        comment = _comment(platform, item)
        # A sticker or photo reply can arrive with no visible text. Skip it,
        # or label the attachment, so the card does not render a blank row.
        if comment_has_visible_text(comment.text):
            comments.append(comment)
        elif platform == "facebook" and _has_media(item):
            comments.append(replace(comment, text="lampiran media"))
    status = payload.get("status")
    call = RouteCall(
        provider="scrapeatlas",
        platform=platform,
        route=route_id,
        outcome="partial" if status == "partial" else "success",
        http_status=payload.http_status,
        credits_charged=payload.credits_charged,
        body_length=payload.body_length,
        latency_ms=latency_ms,
        safe_detail="ok",
    )
    return CommentFetch(post_id, comments, call, "answered", "ok")
