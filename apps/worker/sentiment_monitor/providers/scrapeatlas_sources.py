"""ScrapeAtlas source adapters producing canonical posts."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
import re
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from typing import Any, Callable, Mapping
from sentiment_monitor.providers.http import urlopen as safe_urlopen

from sentiment_monitor.intent import Keyword, parse_keyword
from sentiment_monitor.providers.canonical import (
    MAX_EXTERNAL_ID_BYTES,
    CanonicalPost,
    RouteCall,
    detect_language,
    filter_since,
    keyword_relevance,
    sanitize_post,
)
from sentiment_monitor.providers.scrapeatlas import ScrapeAtlasError, fetch_scrapeatlas_json
from sentiment_monitor.providers.canonical import PlatformFetch
from sentiment_monitor.sources.normalization import unix_to_iso
from sentiment_monitor.sources.tiktok import normalize_tiktok_item
from sentiment_monitor.sources.threads import normalize_threads_item

DEFAULT_TIMEOUT = 20
X_SEARCH_ROUTE = "scrapeatlas.twitter.posts"
X_TUKULILING_ROUTE = "scrapeatlas.twitter.posts.tukuliling"


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
    identity = item.get("external_id")
    external_id = str(identity).strip() if type(identity) in (str, int) else ""
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


_WEB_SEARCH_CURSOR = r"(?:serper:(?:[1-9]|1[01])|(?:atlas|brave):(?:[1-9]|10))"
_CURSOR_PATTERNS = {
    "tiktok": r"[0-9]{1,24}",
    "instagram": _WEB_SEARCH_CURSOR,
    "x": _WEB_SEARCH_CURSOR,
    "youtube": r"[A-Za-z0-9+/=%_-]{16,4096}",
    "reddit": r"[A-Za-z0-9_.=-]+",
    "linkedin": r"(?:[1-9]|10)",
}


def continuation_values(platform: str, cursor: Any, companion: Any) -> tuple[str | None, str | None]:
    """Validate the ScrapeAtlas request contract and the shorter storage bound."""
    if not isinstance(cursor, str) or not cursor.strip() or not cursor.isprintable():
        return None, None
    if len(cursor.encode("utf-8")) > 4096:
        return None, None
    if platform != "facebook" and not re.fullmatch(_CURSOR_PATTERNS.get(platform, r"(?!)"), cursor):
        return None, None
    if platform == "tiktok":
        if int(cursor) <= 0 or not isinstance(companion, str) or not re.fullmatch(r"[0-9A-Za-z_-]{8,64}", companion):
            return None, None
    elif companion is not None:
        return None, None
    return cursor, companion


def _next_page(
    platform: str,
    payload: Mapping[str, Any],
    cursor_field: str | None,
    search_id: str | None,
    web_index: bool,
) -> tuple[str | None, str | None]:
    if cursor_field is None or payload.get("has_more") in (False, 0):
        return None, None
    raw_cursor = payload.get(cursor_field)
    if platform == "tiktok":
        if payload.get("has_more") not in (True, 1):
            return None, None
        if type(raw_cursor) is int and 0 < raw_cursor < 10**24:
            raw_cursor = str(raw_cursor)
        return continuation_values(platform, raw_cursor, search_id or payload.get("search_id"))
    if platform == "linkedin" and not web_index:
        return None, None
    return continuation_values(platform, raw_cursor, None)


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
    search_id: str | None = None,
) -> PlatformFetch:
    if date_window_days is not None and platform in {"threads", "tiktok", "youtube", "reddit", "linkedin"}:
        since = _cutoff(collected_at, date_window_days)
        if since:
            params = {**params, "since": since, "until": collected_at}
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
                credits_charged=error.credits_charged,
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
    outcome = "partial" if payload.partial else "success"
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
    if search_id is not None and "search_session_expired" in payload.coverage_warnings:
        detail = "search_session_expired"
        return PlatformFetch(
            platform, "scrapeatlas", [], [replace(call, outcome="failed", safe_detail=detail)],
            "failed", detail, latency_ms,
        )
    list_keys = {"youtube": ("videos", "shorts"), "tiktok": ("search_item_list", "item_list", "data")}.get(platform, ("posts",))
    present = [key for key in list_keys if isinstance(payload.get(key), list)]
    if not present:
        call = replace(call, outcome="failed", safe_detail="malformed_envelope")
        return PlatformFetch(platform, "scrapeatlas", [], [call], "failed", "malformed_envelope", latency_ms)
    # TikTok aliases describe a single collection. YouTube has two independent collections.
    if platform == "tiktok":
        present = [next((key for key in present if payload[key]), present[0])]
    raw_items = [(key, item) for key in present for item in payload[key]]
    try:
        posts: list[CanonicalPost] = []
        for key, raw in raw_items:
            try:
                item, = extract({key: [raw]}, collected_at)
                post = sanitize_post(_canonical_from(
                    platform,
                    item,
                    keyword,
                    collected_at,
                    route_id,
                    web_index=web_index,
                ))
                if post.external_id.strip() and len(post.external_id.encode("utf-8")) <= MAX_EXTERNAL_ID_BYTES:
                    posts.append(post)
            except Exception:
                # One malformed record is dropped; its siblings survive.
                continue
        if raw_items and not posts:
            call = replace(call, outcome="failed", safe_detail="malformed_records")
            return PlatformFetch(platform, "scrapeatlas", [], [call], "failed", "malformed_records", latency_ms)
        partial = outcome == "partial" or len(posts) < len(raw_items)
        if partial:
            call = replace(call, outcome="partial")
        if date_window_days is not None:
            cutoff = _cutoff(collected_at, date_window_days)
            if cutoff is not None:
                posts = filter_since(posts, cutoff)
    except Exception:
        return PlatformFetch(
            platform, "scrapeatlas", [], [call], "failed", "storage_failed", latency_ms
        )
    next_cursor, next_companion = _next_page(platform, payload, cursor_field, search_id, web_index)
    return PlatformFetch(
        platform, "scrapeatlas", posts, [call], "answered",
        "web_index_selection" if web_index else "partial_coverage" if partial else "ok", latency_ms,
        next_cursor=next_cursor, next_companion=next_companion,
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
    cursor: str | None = None,
    search_id: str | None = None,
) -> PlatformFetch:
    params = {"query": str(keyword), "region": "ID", "sort_by": "relevance"}
    if cursor is not None and search_id is not None:
        params.update({"cursor": cursor, "search_id": search_id})
    return _fetch(
        "tiktok",
        "/v1/tiktok/search/keyword",
        params,
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.tiktok.keyword",
        extract=_tiktok_items,
        date_window_days=date_window_days,
        cursor_field="cursor",
        search_id=search_id,
    )


def _youtube_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for key in ("videos", "shorts"):
        for item in _list_items(payload, key):
            channel = item.get("channel") if isinstance(item.get("channel"), dict) else {}
            title = _optional_text(item.get("title"))
            text = title or ""
            video_id = _optional_text(item.get("id"))
            url = _optional_text(item.get("url"))
            if not url and video_id and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                url = (f"https://www.youtube.com/shorts/{video_id}" if key == "shorts"
                       else f"https://www.youtube.com/watch?v={video_id}")
            items.append(
                {
                    "external_id": item.get("id"),
                    "text": text,
                    "title": title,
                    "author_name": channel.get("title"),
                    "author_handle": channel.get("handle"),
                    "url": url,
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
    # For link submissions, "url" points to the submitted site.
    permalink = _optional_text(item.get("permalink"))
    if permalink and not permalink.startswith("//"):
        if permalink.startswith("/"):
            return f"https://www.reddit.com{permalink}"
        return permalink
    raw_id = _optional_text(item.get("id") or item.get("post_id"))
    post_id = raw_id.removeprefix("t3_") if raw_id else ""
    if re.fullmatch(r"[a-z0-9]+", post_id):
        return f"https://www.reddit.com/comments/{post_id}/"
    return None


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


def _linkedin_activity_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    urn = re.fullmatch(r"urn:li:activity:([0-9]+)", value)
    if urn:
        return urn.group(1)
    try:
        url = urlsplit(value)
    except ValueError:
        return None
    if url.scheme != "https" or not (url.hostname == "linkedin.com" or (url.hostname or "").endswith(".linkedin.com")):
        return None
    match = re.search(r"(?:-activity-|/urn:li:activity:)([0-9]+)(?:[-/]|$)", url.path)
    return match.group(1) if match else None


def _linkedin_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in _list_items(payload, "posts"):
        author = item.get("author") if isinstance(item.get("author"), dict) else {}
        url = _optional_text(item.get("url"))
        if not url:
            urn = _optional_text(item.get("urn")) or _optional_text(item.get("id"))
            if urn and re.fullmatch(r"urn:li:activity:[0-9]+", urn):
                url = f"https://www.linkedin.com/feed/update/{urn}/"
        items.append(
            {
                "external_id": (_linkedin_activity_id(item.get("id"))
                                or _linkedin_activity_id(item.get("urn"))
                                or _linkedin_activity_id(item.get("url"))
                                or item.get("id") or item.get("urn")),
                "text": _optional_text(item.get("description")) or "",
                "title": None,
                "author_name": author.get("name"),
                "author_handle": None,
                "url": url,
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
    cursor: str | None = None,
) -> PlatformFetch:
    params = {"query": str(keyword), "region": "ID", "sortBy": "relevance"}
    if cursor is not None:
        params["continuationToken"] = cursor
    return _fetch(
        "youtube",
        "/v1/youtube/search",
        params,
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.youtube.search",
        extract=_youtube_items,
        date_window_days=date_window_days,
        cursor_field="continuationToken",
    )


def fetch_scrapeatlas_reddit(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
    cursor: str | None = None,
) -> PlatformFetch:
    params = {"query": str(keyword), "sort": "relevance", "filter": "posts"}
    if cursor is not None:
        params["after"] = cursor
    return _fetch(
        "reddit",
        "/v1/reddit/search",
        params,
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.reddit.search",
        extract=_reddit_items,
        date_window_days=date_window_days,
        cursor_field="after",
    )


def facebook_hashtag(keyword: Keyword) -> str | None:
    tag = str(keyword).removeprefix("#")
    intent = getattr(keyword, "intent", "hashtag" if str(keyword).startswith("#") else "phrase")
    return tag if intent == "hashtag" and re.fullmatch(r"\w+", tag) else None


def fetch_scrapeatlas_facebook(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
    cursor: str | None = None,
) -> PlatformFetch:
    tag = facebook_hashtag(keyword)
    if tag is None:
        return PlatformFetch("facebook", "scrapeatlas", state="unavailable", safe_detail="hashtag_only")
    params = {"hashtag": tag}
    if cursor is not None:
        params["cursor"] = cursor
    return _fetch(
        "facebook",
        "/v1/facebook/hashtag",
        params,
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.facebook.hashtag",
        extract=_facebook_items,
        date_window_days=date_window_days,
        cursor_field="cursor",
    )


def fetch_scrapeatlas_linkedin(
    keyword: Keyword,
    *,
    api_key: str,
    collected_at: str,
    opener: Callable[..., Any] = safe_urlopen,
    date_window_days: int | None = None,
    cursor: str | None = None,
) -> PlatformFetch:
    params = {"query": str(keyword)}
    if cursor is not None:
        params["cursor"] = cursor
    return _fetch(
        "linkedin",
        "/v1/linkedin/search/posts",
        params,
        api_key,
        opener=opener,
        keyword=keyword,
        collected_at=collected_at,
        route_id="scrapeatlas.linkedin.posts",
        extract=_linkedin_items,
        date_window_days=date_window_days,
        web_index_from_warnings=True,
        cursor_field="cursor",
    )


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, dict) else {}


def _instagram_items(payload: Mapping[str, Any], collected_at: str) -> list[dict[str, Any]]:
    posts = []
    for item in _list_items(payload, "posts"):
        owner = _mapping(item.get("owner"))
        edges = _list_items(_mapping(item.get("edge_media_to_caption")), "edges")
        caption = _mapping(edges[0].get("node")) if edges else {}
        url = _optional_text(item.get("url"))
        shortcode = _optional_text(item.get("shortcode"))
        if not url and shortcode and re.fullmatch(r"[A-Za-z0-9_-]+", shortcode):
            kind = "reel" if item.get("product_type") == "clips" else "p"
            url = f"https://www.instagram.com/{kind}/{shortcode}/"
        posts.append({
            "external_id": item.get("id"),
            "text": caption.get("text"),
            "url": url,
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
        tweet_id = item.get("rest_id") or legacy.get("id_str")
        url = _optional_text(item.get("url"))
        if not url and type(tweet_id) in (str, int) and re.fullmatch(r"[0-9]{1,20}", str(tweet_id)):
            url = f"https://x.com/i/web/status/{tweet_id}"
        posts.append({
            "external_id": tweet_id,
            "text": legacy.get("full_text"),
            "url": url,
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
    continuation_route: str | None = None,
) -> PlatformFetch:
    # The indexed search has returned direct brand mentions with this phrase.
    # Keep the query variant with the cursor so older raw-query pages still work.
    route = continuation_route or (
        X_TUKULILING_ROUTE if is_tukuliling_phrase(keyword) else X_SEARCH_ROUTE
    )
    params = {"query": "tukuliling kopi" if route == X_TUKULILING_ROUTE else str(keyword)}
    if cursor is not None:
        params["cursor"] = cursor
    return _fetch(
        "x", "/v1/twitter/search/posts", params, api_key,
        opener=opener, keyword=keyword, collected_at=collected_at,
        route_id=route, extract=_x_items,
        date_window_days=date_window_days, web_index_from_warnings=True, cursor_field="cursor",
    )


def is_tukuliling_phrase(keyword: str) -> bool:
    text, intent = parse_keyword(keyword, getattr(keyword, "intent", None))
    return intent == "phrase" and text.casefold() == "tukuliling"
