from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable
import urllib.request

from harken.models import Mention
from harken.sources import REGISTRY
from harken.sources.base import FetchPage, Source

from sentiment_monitor.sources.scrapecreators import (
    DEFAULT_REGION,
    credits_from,
    dedupe_mentions,
    fetch_scrapecreators_json,
    select_post_list,
    unix_to_iso,
)

THREADS_SEARCH_PATH = "/v1/threads/search"
THREADS_SEARCH_URL = f"https://api.scrapecreators.com{THREADS_SEARCH_PATH}"


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


def normalize_threads_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]:
    external_id = str(item.get("pk") or item.get("id") or item.get("code") or "")
    author = _extract_threads_author(item)
    code = item.get("code")
    url = item.get("url") or item.get("permalink")
    if not url and author and code:
        url = f"https://www.threads.com/@{author}/post/{code}"
    posted_at = unix_to_iso(item.get("taken_at") if item.get("taken_at") is not None else item.get("timestamp"))
    return {
        "external_id": external_id,
        "source": "threads",
        "author": author,
        "text": _extract_threads_text(item),
        "url": url,
        "posted_at": posted_at,
        "collected_at": collected_at,
    }


def fetch_threads_mentions(
    variant: str,
    api_key: str,
    collected_at: str,
    *,
    region: str = DEFAULT_REGION,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    payload = fetch_scrapecreators_json(
        THREADS_SEARCH_PATH,
        {"query": variant},
        api_key,
        region=region,
        opener=opener,
    )
    raw_items = select_post_list(payload, ("posts", "items", "data"))
    items = [
        normalize_threads_item(item, collected_at)
        for item in raw_items
        if isinstance(item, dict)
    ]
    mentions = dedupe_mentions(items)
    return {
        "mentions": mentions,
        "outcome": "empty_or_success",
        "counts": {
            "returned": len(raw_items),
            "parsed": len(items),
            "deduplicated": len(items) - len(mentions),
        },
        "credits_charged": credits_from(payload),
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
        result = fetch_threads_mentions(query, self.access_token, now_iso)
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
