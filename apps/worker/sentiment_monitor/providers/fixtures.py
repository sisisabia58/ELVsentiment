"""Deterministic synthetic provider backend for QA and fixture-mode runs."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.canonical import (
    CanonicalComment,
    CanonicalPost,
    RouteCall,
    detect_language,
    keyword_relevance,
)
from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch

FIXTURE_ROUTE = "fixture"


def _published(collected_at: str, days_ago: int) -> str | None:
    try:
        base = datetime.fromisoformat(collected_at.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        return None
    return (base - timedelta(days=days_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _draft(
    platform: str,
    index: int,
    keyword: Keyword,
    collected_at: str,
    *,
    published_at: str | None,
    thumbnail_url: str | None = None,
    likes: int | None = None,
    views: int | None = None,
    replies: int | None = None,
    shares: int | None = None,
) -> CanonicalPost:
    external_id = f"fixture-{platform}-{index}"
    text = f"{keyword} contoh {platform} {index}"
    draft = CanonicalPost(
        platform=platform,
        external_id=external_id,
        text=text,
        title=f"Contoh {platform}" if platform == "youtube" else None,
        author_name=f"Akun {platform} {index}",
        author_handle=f"@fixture_{platform}_{index}",
        url=f"https://example.invalid/{platform}/{index}",
        published_at=published_at,
        thumbnail_url=thumbnail_url,
        views=views,
        likes=likes,
        replies=replies,
        shares=shares,
        top_replies=(),
        hashtags=(),
        source_provider="fixture",
        routes=(f"fixture.{platform}.search",),
        raw_ref=f"fixture:{platform}:{external_id}",
        collected_at=collected_at,
        language=detect_language(text),
        relevance="no_match",
        web_index=False,
    )
    return replace(draft, relevance=keyword_relevance(draft, str(keyword), getattr(keyword, "intent", "phrase")))


def fixture_platform_fetch(
    platform: str,
    keyword: Keyword,
    *,
    collected_at: str,
    date_window_days: int | None = None,
) -> PlatformFetch:
    del date_window_days
    posts = [
        _draft(
            platform,
            1,
            keyword,
            collected_at,
            published_at=_published(collected_at, 1),
            thumbnail_url=f"https://example.invalid/media/{platform}-1.jpg",
        ),
        _draft(
            platform,
            2,
            keyword,
            collected_at,
            published_at=_published(collected_at, 2),
            likes=12,
            views=120,
            replies=2,
            shares=1,
        ),
        _draft(
            platform,
            3,
            keyword,
            collected_at,
            published_at=None if platform == "youtube" else _published(collected_at, 3),
        ),
    ]
    route = f"fixture.{platform}.search"
    call = RouteCall(
        provider=FIXTURE_ROUTE,
        platform=platform,
        route=route,
        outcome="success",
        http_status=None,
        credits_charged=0,
        body_length=None,
        latency_ms=0,
        safe_detail="ok",
    )
    return PlatformFetch(
        platform=platform,
        provider=FIXTURE_ROUTE,
        posts=posts,
        calls=[call],
        state="answered",
        safe_detail="ok",
        latency_ms=0,
        attempted_providers=(FIXTURE_ROUTE,),
    )


def fixture_comment_fetch(platform: str, post: CanonicalPost):
    from sentiment_monitor.providers.comments import CommentFetch

    post_id = str(post.external_id or "")
    comments = [
        CanonicalComment(
            external_id=f"fixture-{platform}-comment-{index}",
            text=f"komentar contoh {index}",
            author_name=f"Pengomentar {index}",
            author_handle=f"@komentar_{index}",
            published_at=None,
            likes=index,
            replies=None,
            source_provider=FIXTURE_ROUTE,
            raw_ref=f"fixture:{platform}:comment:{index}",
        )
        for index in (1, 2)
    ]
    call = RouteCall(
        provider=FIXTURE_ROUTE,
        platform=platform,
        route=f"fixture.{platform}.comments",
        outcome="success",
        http_status=None,
        credits_charged=0,
        body_length=None,
        latency_ms=0,
        safe_detail="ok",
    )
    return CommentFetch(post_id, comments, call, "answered", "ok")
