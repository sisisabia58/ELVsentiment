"""ScrapeAtlas source adapters producing canonical posts."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
import re
import time
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Mapping
from sentiment_monitor.providers.http import urlopen as safe_urlopen

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import (
    CanonicalPost,
    RouteCall,
    detect_language,
    filter_since,
    keyword_relevance,
    sanitize_post,
)
from sentiment_monitor.providers.scrapeatlas import ScrapeAtlasError, fetch_scrapeatlas_json
from sentiment_monitor.providers.canonical import PlatformFetch
from sentiment_monitor.sources.scrapecreators import unix_to_iso
from sentiment_monitor.sources.tiktok import normalize_tiktok_item
from sentiment_monitor.sources.threads import normalize_threads_item

DEFAULT_TIMEOUT = 20


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


def _cutoff(collected_at: str, date_window_days: int) -> str | None:
    try:
        parsed = datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        return None
    return (parsed - timedelta(days=date_window_days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _canonical_from(
    platform: str,
    item: Mapping[str, Any],
    keyword: Keyword,
    collected_at: str,
    route_id: str,
    *,
    web_index: bool = False,
) -> CanonicalPost:
    text = str(item.get("text") or "")
    external_id = str(item.get("external_id") or "")
    draft = CanonicalPost(
        platform=platform,
        external_id=external_id,
        text=text,
        title=_optional_text(item.get("title")),
        author_name=_optional_text(item.get("author_name")),
        author_handle=_optional_text(item.get("author_handle") or item.get("author")),
        url=_optional_text(item.get("url")),
        published_at=_optional_text(item.get("posted_at")),
        thumbnail_url=_optional_text(item.get("thumbnail_url")),
        views=_optional_int(item.get("views")),
        likes=_optional_int(item.get("likes")),
        replies=_optional_int(item.get("replies")),
        shares=_optional_int(item.get("shares")),
        top_replies=(),
        hashtags=tuple(str(tag) for tag in item.get("hashtags") or ()),
        source_provider="scrapeatlas",
        routes=(route_id,),
        raw_ref=f"scrapeatlas:{platform}:{external_id}",
        collected_at=collected_at,
        language=detect_language(text),
        web_index=web_index,
    )
    return replace(
        draft,
        relevance=keyword_relevance(draft, str(keyword), getattr(keyword, "intent", "phrase")),
    )


def _list_items(payload: Mapping[str, Any], key: str) -> list[dict[str, Any]]:
    value = payload.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _first_list(payload: Mapping[str, Any], keys: tuple[str, ...]) -> list[dict[str, Any]]:
    for key in keys:
        items = _list_items(payload, key)
        if items:
            return items
    return []


def _fetch(
    platform: str,
    path: str,
    params: Mapping[str, Any],
    api_key: str,
    *,
    opener: Callable[..., Any],
    keyword: Keyword,
    collected_at: str,
    route_id: str,
    extract: Callable[[Mapping[str, Any], str], list[dict[str, Any]]],
    date_window_days: int | None,
    web_index_from_warnings: bool = False,
    cursor_field: str | None = None,
) -> PlatformFetch:
    started = time.monotonic()
    try:
        payload = fetch_scrapeatlas_json(path, params, api_key, opener=opener)
    except ScrapeAtlasError as error:
        latency_ms = int((time.monotonic() - started) * 1000)
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
            return PlatformFetch(
                platform, "scrapeatlas", [], [call], "answered", "not_found", latency_ms
            )
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
        return PlatformFetch(
            platform, "scrapeatlas", [], [call], "failed", error.code, latency_ms
        )
    latency_ms = int((time.monotonic() - started) * 1000)
    web_index = (
        web_index_from_warnings
        and "web_index_selection" in payload.coverage_warnings
    )
    status = payload.get("status")
    outcome = "partial" if status == "partial" else "success"
    # The paid call is durable before any post is parsed: a poisoned record or
    # a filter error must still return the ledger row to the caller.
    call = RouteCall(
        provider="scrapeatlas",
        platform=platform,
        route=route_id,
        outcome=outcome,
        http_status=payload.http_status,
        credits_charged=payload.credits_charged,
        body_length=payload.body_length,
        latency_ms=latency_ms,
        safe_detail="ok",
    )
    try:
        posts: list[CanonicalPost] = []
        for item in extract(payload, collected_at):
            try:
                post = _canonical_from(
                    platform,
                    item,
                    keyword,
                    collected_at,
                    route_id,
                    web_index=web_index,
                )
                if post.external_id:
                    posts.append(sanitize_post(post))
            except Exception:
                # One malformed record is dropped; its siblings survive.
                continue
        if date_window_days is not None:
            cutoff = _cutoff(collected_at, date_window_days)
            if cutoff is not None:
                posts = filter_since(posts, cutoff)
    except Exception:
        return PlatformFetch(
            platform, "scrapeatlas", [], [call], "failed", "storage_failed", latency_ms
        )
    return PlatformFetch(
        platform, "scrapeatlas", posts, [call], "answered",
        "web_index_selection" if web_index else "ok", latency_ms,
        next_cursor=payload.get(cursor_field) if isinstance(payload.get(cursor_field), str) else None,
    )


def _threads_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    return [
        normalize_threads_item(item, collected_at)
        for item in _list_items(payload, "posts")
    ]


def _tiktok_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items = []
    for item in _first_list(payload, ("search_item_list", "item_list", "data")):
        if "create_time" not in item and "createTime" in item:
            item = {**item, "create_time": item["createTime"]}
        items.append(normalize_tiktok_item(item, collected_at))
    return items


def fetch_scrapeatlas_threads(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    return _fetch(
        "threads",
        "/v1/threads/search",
        {"query": str(keyword), "recent": "true"},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.threads.recent",
        extract=_threads_items,
        date_window_days=date_window_days,
    )


def fetch_scrapeatlas_tiktok(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    return _fetch(
        "tiktok",
        "/v1/tiktok/search/keyword",
        {"query": str(keyword), "region": "ID"},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.tiktok.keyword",
        extract=_tiktok_items,
        date_window_days=date_window_days,
    )


def _youtube_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for key in ("videos", "shorts"):
        for item in _list_items(payload, key):
            channel = item.get("channel") if isinstance(item.get("channel"), dict) else {}
            title = _optional_text(item.get("title"))
            text = title or ""
            items.append(
                {
                    "external_id": item.get("id"),
                    "text": text,
                    "title": title,
                    "author_name": channel.get("title"),
                    "author_handle": channel.get("handle"),
                    "url": item.get("url"),
                    "posted_at": item.get("publishedTime"),
                    "thumbnail_url": item.get("thumbnail"),
                    "views": item.get("viewCountInt"),
                    "likes": None,
                    "replies": None,
                    "shares": None,
                    "hashtags": tuple(re.findall(r"#(\w+)", text)),
                }
            )
    return items


def _reddit_url(item: Mapping[str, Any]) -> str | None:
    url = _optional_text(item.get("url"))
    if url:
        return url
    permalink = _optional_text(item.get("permalink"))
    if not permalink:
        return None
    if permalink.startswith("/"):
        return f"https://www.reddit.com{permalink}"
    return permalink


def _reddit_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(payload, "posts"):
        title = _optional_text(item.get("title"))
        selftext = _optional_text(item.get("selftext"))
        text = title or ""
        if selftext:
            text = f"{text}\n\n{selftext}" if text else selftext
        items.append(
            {
                "external_id": item.get("id") or item.get("post_id"),
                "text": text,
                "title": title,
                "author_name": item.get("author"),
                "author_handle": None,
                "url": _reddit_url(item),
                "posted_at": item.get("created_at_iso") or item.get("created_at"),
                "thumbnail_url": item.get("thumbnail"),
                "views": None,
                "likes": item.get("score"),
                "replies": item.get("num_comments"),
                "shares": None,
                "hashtags": (),
            }
        )
    return items


def _first_image_url(item: Mapping[str, Any]) -> str | None:
    images = item.get("images")
    if isinstance(images, list):
        for image in images:
            if isinstance(image, dict):
                url = _optional_text(image.get("url"))
                if url:
                    return url
            elif isinstance(image, str) and image.strip():
                return image.strip()
    image = item.get("image")
    if isinstance(image, str) and image.strip():
        return image.strip()
    attachments = item.get("mediaAttachments")
    if isinstance(attachments, list):
        for attachment in attachments:
            if isinstance(attachment, dict):
                url = _optional_text(attachment.get("url") or attachment.get("thumbnailUrl"))
                if url:
                    return url
    return None


def _facebook_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(payload, "posts"):
        author = item.get("author") if isinstance(item.get("author"), dict) else {}
        published = item.get("publishTime")
        if published is None:
            published = item.get("creation_time")
        items.append(
            {
                "external_id": item.get("id"),
                "text": _optional_text(item.get("text")) or "",
                "title": None,
                "author_name": author.get("name"),
                "author_handle": None,
                "url": item.get("url") or item.get("permalink"),
                "posted_at": unix_to_iso(published),
                "thumbnail_url": _first_image_url(item),
                "views": item.get("videoViewCount"),
                "likes": item.get("reactionCount"),
                "replies": item.get("commentCount"),
                "shares": None,
                "hashtags": (),
            }
        )
    return items


def _linkedin_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(payload, "posts"):
        author = item.get("author") if isinstance(item.get("author"), dict) else {}
        items.append(
            {
                "external_id": item.get("id") or item.get("urn"),
                "text": _optional_text(item.get("description")) or "",
                "title": None,
                "author_name": author.get("name"),
                "author_handle": None,
                "url": item.get("url"),
                "posted_at": item.get("datePublished"),
                "thumbnail_url": _first_image_url(item),
                "views": None,
                "likes": item.get("likeCount"),
                "replies": item.get("commentCount"),
                "shares": None,
                "hashtags": (),
            }
        )
    return items


def fetch_scrapeatlas_youtube(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    return _fetch(
        "youtube",
        "/v1/youtube/search",
        {"query": str(keyword), "region": "ID"},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.youtube.search",
        extract=_youtube_items,
        date_window_days=date_window_days,
    )


def fetch_scrapeatlas_reddit(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    return _fetch(
        "reddit",
        "/v1/reddit/search",
        {"query": str(keyword), "sort": "relevance"},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.reddit.search",
        extract=_reddit_items,
        date_window_days=date_window_days,
    )


def fetch_scrapeatlas_facebook(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    tag = str(keyword).removeprefix("#")
    intent = getattr(keyword, "intent", "hashtag" if str(keyword).startswith("#") else "phrase")
    if intent != "hashtag" or not re.fullmatch(r"\w+", tag):
        return PlatformFetch("facebook", "scrapeatlas", state="unavailable", safe_detail="hashtag_only")
    return _fetch(
        "facebook",
        "/v1/facebook/hashtag",
        {"hashtag": tag},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.facebook.hashtag",
        extract=_facebook_items,
        date_window_days=date_window_days,
    )


def fetch_scrapeatlas_linkedin(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
) -> PlatformFetch:
    return _fetch(
        "linkedin",
        "/v1/linkedin/search/posts",
        {"query": str(keyword), "date_posted": "last-week"},
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.linkedin.posts",
        extract=_linkedin_items,
        date_window_days=date_window_days,
        web_index_from_warnings=True,
    )


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def _instagram_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    posts = []
    for item in _list_items(payload, "posts"):
        owner = _mapping(item.get("owner"))
        edges = _list_items(_mapping(item.get("edge_media_to_caption")), "edges")
        caption = _mapping(edges[0].get("node")) if edges else {}
        posts.append({
            "external_id": item.get("id"),
            "text": caption.get("text"),
            "url": item.get("url"),
            "author_handle": owner.get("username"),
            "author_name": owner.get("full_name"),
            "posted_at": unix_to_iso(item.get("taken_at_timestamp")) or item.get("created_at"),
            "thumbnail_url": item.get("thumbnail_src") or item.get("display_url"),
            "views": item.get("video_play_count"),
            "likes": _mapping(item.get("edge_media_preview_like")).get("count"),
            "replies": item.get("comment_count"),
        })
    return posts


def _x_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    posts = []
    for item in _list_items(payload, "posts"):
        legacy = _mapping(item.get("legacy"))
        user = _mapping(_mapping(item.get("core")).get("user_results"))
        author = _mapping(_mapping(user.get("result")).get("legacy"))
        try:
            posted_at = parsedate_to_datetime(legacy.get("created_at")).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (TypeError, ValueError, OverflowError):
            posted_at = None
        media = _list_items(_mapping(legacy.get("extended_entities")), "media")
        posts.append({
            "external_id": item.get("rest_id") or legacy.get("id_str"),
            "text": legacy.get("full_text"),
            "url": item.get("url"),
            "author_handle": author.get("screen_name"),
            "author_name": author.get("name"),
            "posted_at": posted_at,
            "thumbnail_url": media[0].get("media_url_https") if media else None,
            "views": _mapping(item.get("views")).get("count"),
            "likes": legacy.get("favorite_count"),
            "replies": legacy.get("reply_count"),
            "shares": legacy.get("retweet_count"),
        })
    return posts


def fetch_scrapeatlas_instagram(
    keyword: Keyword, *, api_key: str, collected_at: str,
    opener: Callable[..., Any] = safe_urlopen, date_window_days: int | None = None,
    cursor: str | None = None,
) -> PlatformFetch:
    params = {"query": str(keyword), "trim": "false"}
    if cursor is not None:
        params["cursor"] = cursor
    return _fetch(
        "instagram", "/v1/instagram/search/posts", params, api_key,
        opener=opener, keyword=keyword, collected_at=collected_at,
        route_id="scrapeatlas.instagram.posts", extract=_instagram_items,
        date_window_days=date_window_days, web_index_from_warnings=True, cursor_field="cursor",
    )


def fetch_scrapeatlas_x(
    keyword: Keyword, *, api_key: str, collected_at: str,
    opener: Callable[..., Any] = safe_urlopen, date_window_days: int | None = None,
    cursor: str | None = None,
) -> PlatformFetch:
    params = {"query": str(keyword)}
    if cursor is not None:
        params["cursor"] = cursor
    return _fetch(
        "x", "/v1/twitter/search/posts", params, api_key,
        opener=opener, keyword=keyword, collected_at=collected_at,
        route_id="scrapeatlas.twitter.posts", extract=_x_items,
        date_window_days=date_window_days, web_index_from_warnings=True, cursor_field="cursor",
    )
