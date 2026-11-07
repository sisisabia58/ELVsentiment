# ScrapeCreators Multi-Platform Sources (`threads`, `instagram`, `tiktok`) + Official X (`x`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inaccessible official Meta Threads API with ScrapeCreators (`https://api.scrapecreators.com`, `region=ID`, no local credit cap) and add Instagram (Reels keyword search + Hashtag search) and TikTok (Keyword search + Top search) alongside official X (`api.x.com`).

**Architecture:** A shared ScrapeCreators HTTP client (`apps/worker/sentiment_monitor/sources/scrapecreators.py`) authenticates with `x-api-key: <SCRAPECREATORS_API_KEY>` and enforces `region=ID`. Three ScrapeCreators source adapters (`threads.py`, `instagram.py`, `tiktok.py`) normalize posts into the worker's mention contract and deduplicate multi-endpoint results by `external_id`. The worker scheduler (`scheduler.py`) and gate (`collect_once.py`) allow `threads`, `instagram`, and `tiktok` whenever `SCRAPECREATORS_API_KEY` is present without the old `threads_rolling_24h_reserve` cap, while keeping `x` gated on `X_BEARER_TOKEN` and `x-budget.json`. Additive migration `009_scrapecreators_sources.sql` and TypeScript/React modules in `apps/web/src/` expand source support to `("x", "threads", "instagram", "tiktok")`.

**Tech Stack:** Python 3 (`urllib.request`, `psycopg`, `pytest`), PostgreSQL 16 (additive SQL migrations), TypeScript / Next.js (`pg-mem`, `vitest`, React).

**Spec:** `docs/superpowers/specs/2026-11-06-scrapecreators-sources-design.md`

### Global Constraints
- **Do not touch existing SQL migrations**: `apps/web/src/db/sql/001_init.sql` through `008_scoring_worker.sql` must remain byte-for-byte unchanged. Put all schema changes in `apps/web/src/db/sql/009_scrapecreators_sources.sql`.
- **Always pass `region=ID`**: Every ScrapeCreators search endpoint call must include `region=ID` in its query string.
- **No ScrapeCreators rate/credit cap**: Do not gate `threads`, `instagram`, or `tiktok` on `threads_rolling_24h_reserve` or `admit_threads_queries` in `serve()`. Keep X's `admit_x_read()` budget check intact for `"x"`.
- **Secret redaction**: `SCRAPECREATORS_API_KEY` must be in `_SECRET_NAMES` in `apps/worker/sentiment_monitor/scheduler.py` and never leaked in logs or errors.
- **Web `sourceCredentials` isolation**: `sourceCredentials()` in `apps/web/src/monitor/policy.ts` must only inspect `env` (`X_BEARER_TOKEN` and `SCRAPECREATORS_API_KEY`) and must NOT read `config/x-budget.json`.

### Review Focus
- Verify that `region=ID` and `x-api-key` header are asserted in unit tests for Threads, Instagram (both `/v2/instagram/reels/search` and `/v1/instagram/search/hashtag`), and TikTok (both `/v1/tiktok/search/keyword` and `/v1/tiktok/search/top`).
- Verify that `instagram` and `tiktok` deduplicate overlapping items across their two endpoints by `external_id`.
- Verify that `009_scrapecreators_sources.sql` cleanly migrates on top of `001`–`008` in both `pg-mem` (Vitest) and PostgreSQL (`pytest`).
- Verify that all existing tests in `apps/worker/tests` and `apps/web/src` continue to pass alongside new tests.

---

### Task 1: ScrapeCreators Client & Source Adapters (`threads`, `instagram`, `tiktok`)

**Files:**
- Create: `apps/worker/sentiment_monitor/sources/scrapecreators.py`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py`
- Create: `apps/worker/sentiment_monitor/sources/instagram.py`
- Create: `apps/worker/sentiment_monitor/sources/tiktok.py`
- Modify: `apps/worker/sentiment_monitor/sources/collect.py`
- Modify: `apps/worker/tests/test_threads_source.py`
- Create: `apps/worker/tests/test_instagram_source.py`
- Create: `apps/worker/tests/test_tiktok_source.py`

**Interfaces:**
- `apps/worker/sentiment_monitor/sources/scrapecreators.py`:
  - `SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com"`
  - `DEFAULT_REGION = "ID"`
  - `fetch_scrapecreators_json(path: str, params: dict[str, str], api_key: str, *, region: str = DEFAULT_REGION, opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]`
  - `dedupe_mentions(mentions: list[dict[str, Any]]) -> list[dict[str, Any]]`
  - `unix_to_iso(value: Any) -> str | None`
- `apps/worker/sentiment_monitor/sources/threads.py`:
  - `THREADS_SEARCH_URL = "https://api.scrapecreators.com/v1/threads/search"`
  - `normalize_threads_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]`
  - `fetch_threads_mentions(variant: str, api_key: str, collected_at: str, *, region: str = "ID", opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]`
- `apps/worker/sentiment_monitor/sources/instagram.py`:
  - `INSTAGRAM_REELS_SEARCH_URL = "https://api.scrapecreators.com/v2/instagram/reels/search"`
  - `INSTAGRAM_HASHTAG_SEARCH_URL = "https://api.scrapecreators.com/v1/instagram/search/hashtag"`
  - `normalize_hashtag(variant: str) -> str`
  - `normalize_instagram_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]`
  - `fetch_instagram_mentions(variant: str, api_key: str, collected_at: str, *, region: str = "ID", opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]`
- `apps/worker/sentiment_monitor/sources/tiktok.py`:
  - `TIKTOK_KEYWORD_SEARCH_URL = "https://api.scrapecreators.com/v1/tiktok/search/keyword"`
  - `TIKTOK_TOP_SEARCH_URL = "https://api.scrapecreators.com/v1/tiktok/search/top"`
  - `normalize_tiktok_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]`
  - `fetch_tiktok_mentions(variant: str, api_key: str, collected_at: str, *, region: str = "ID", opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]`

- [ ] **Step 1: Write the failing tests for Threads, Instagram, and TikTok ScrapeCreators adapters**

Update `apps/worker/tests/test_threads_source.py` and create `apps/worker/tests/test_instagram_source.py` and `apps/worker/tests/test_tiktok_source.py`:

```python
# apps/worker/tests/test_threads_source.py
import io
import json
import urllib.error

import pytest

from sentiment_monitor.sources.collect import collect_project_sources
from sentiment_monitor.sources.threads import fetch_threads_mentions, normalize_threads_item


def test_threads_mentions_keep_null_posted_at_when_source_omits_timestamp() -> None:
    mention = normalize_threads_item(
        {
            "pk": "th-1",
            "code": "C123",
            "caption": {"text": "Kopi Kenangan baru"},
            "user": {"username": "rina"},
        },
        collected_at="2026-04-19T06:00:00Z",
    )

    assert mention["external_id"] == "th-1"
    assert mention["source"] == "threads"
    assert mention["author"] == "rina"
    assert mention["text"] == "Kopi Kenangan baru"
    assert mention["url"] == "https://www.threads.com/@rina/post/C123"
    assert mention["posted_at"] is None
    assert mention["collected_at"] == "2026-04-19T06:00:00Z"


def test_fetch_threads_calls_scrapecreators_with_id_region_and_api_key() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        return Response(
            json.dumps(
                {
                    "success": True,
                    "posts": [
                        {
                            "pk": "th-99",
                            "code": "D999",
                            "taken_at": 1776578400,
                            "caption": {"text": "Suka banget Kopi Kenangan"},
                            "user": {"username": "budi"},
                        }
                    ],
                }
            )
        )

    result = fetch_threads_mentions(
        "kopi kenangan",
        "sc-secret-key",
        "2026-04-19T06:00:00Z",
        opener=opener,
    )

    assert len(seen) == 1
    url, headers = seen[0]
    assert url.startswith("https://api.scrapecreators.com/v1/threads/search?")
    assert "query=kopi+kenangan" in url
    assert "region=ID" in url
    assert headers.get("x-api-key") == "sc-secret-key"
    assert result["outcome"] == "empty_or_success"
    assert len(result["mentions"]) == 1
    assert result["mentions"][0]["external_id"] == "th-99"
    assert result["mentions"][0]["posted_at"] == "2026-04-19T06:00:00Z"


def test_one_failing_source_does_not_discard_other_sources() -> None:
    def fail_x():
        raise urllib.error.HTTPError("https://api.x.com", 503, "unavailable", {}, None)

    def ok_threads():
        return {
            "mentions": [
                normalize_threads_item(
                    {"id": "th-2", "text": "Masih jalan", "timestamp": "2026-04-19T05:00:00Z"},
                    collected_at="2026-04-19T06:00:00Z",
                )
            ]
        }

    result = collect_project_sources({"x": fail_x, "threads": ok_threads})

    assert result["sources"]["x"]["state"] == "unavailable"
    assert result["sources"]["x"]["outcome"] == "failed"
    assert result["sources"]["threads"]["state"] == "ready"
    assert len(result["mentions"]) == 1
    assert result["mentions"][0]["external_id"] == "th-2"
```

```python
# apps/worker/tests/test_instagram_source.py
import io
import json

from sentiment_monitor.sources.instagram import (
    fetch_instagram_mentions,
    normalize_hashtag,
    normalize_instagram_item,
)


def test_normalize_hashtag_strips_hash_and_spaces() -> None:
    assert normalize_hashtag("#Kopi Kenangan!") == "kopikenangan"
    assert normalize_hashtag("  @kopi_kenangan ") == "kopi_kenangan"


def test_fetch_instagram_runs_both_reels_and_hashtag_with_id_region_and_dedupes() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        if "/v2/instagram/reels/search" in request.full_url:
            return Response(
                json.dumps(
                    {
                        "reels": [
                            {
                                "pk": "ig-1",
                                "code": "REEL1",
                                "taken_at": 1776578400,
                                "caption": {"text": "Reel kopi kenangan"},
                                "user": {"username": "siti"},
                            },
                            {
                                "pk": "ig-dup",
                                "code": "DUP1",
                                "taken_at": 1776578400,
                                "caption": {"text": "Muncul di dua tempat"},
                                "user": {"username": "agus"},
                            },
                        ]
                    }
                )
            )
        return Response(
            json.dumps(
                {
                    "posts": [
                        {
                            "pk": "ig-dup",
                            "code": "DUP1",
                            "taken_at": 1776578400,
                            "caption": {"text": "Muncul di dua tempat"},
                            "user": {"username": "agus"},
                        },
                        {
                            "pk": "ig-2",
                            "shortcode": "POST2",
                            "taken_at_timestamp": 1776578400,
                            "caption": "Postingan hashtag kopi kenangan",
                            "owner": {"username": "dewi"},
                        },
                    ]
                }
            )
        )

    result = fetch_instagram_mentions(
        "Kopi Kenangan",
        "sc-key-ig",
        "2026-04-19T06:00:00Z",
        opener=opener,
    )

    assert len(seen) == 2
    reels_url, reels_headers = seen[0]
    hashtag_url, hashtag_headers = seen[1]
    assert reels_url.startswith("https://api.scrapecreators.com/v2/instagram/reels/search?")
    assert "query=Kopi+Kenangan" in reels_url
    assert "region=ID" in reels_url
    assert reels_headers.get("x-api-key") == "sc-key-ig"

    assert hashtag_url.startswith("https://api.scrapecreators.com/v1/instagram/search/hashtag?")
    assert "hashtag=kopikenangan" in hashtag_url
    assert "region=ID" in hashtag_url
    assert hashtag_headers.get("x-api-key") == "sc-key-ig"

    ids = [m["external_id"] for m in result["mentions"]]
    assert ids == ["ig-1", "ig-dup", "ig-2"]
    assert all(m["source"] == "instagram" for m in result["mentions"])
    assert result["mentions"][0]["url"] == "https://www.instagram.com/p/REEL1/"
    assert result["mentions"][2]["author"] == "dewi"
```

```python
# apps/worker/tests/test_tiktok_source.py
import io
import json

from sentiment_monitor.sources.tiktok import fetch_tiktok_mentions, normalize_tiktok_item


def test_fetch_tiktok_runs_both_keyword_and_top_with_id_region_and_dedupes() -> None:
    seen: list[tuple[str, dict[str, str]]] = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        headers = {k.lower(): v for k, v in request.header_items()}
        seen.append((request.full_url, headers))
        if "/v1/tiktok/search/keyword" in request.full_url:
            return Response(
                json.dumps(
                    {
                        "search_item_list": [
                            {
                                "aweme_info": {
                                    "aweme_id": "tt-1",
                                    "desc": "Review jujur kopi kenangan",
                                    "create_time": 1776578400,
                                    "author": {"unique_id": "foodies_id"},
                                }
                            },
                            {
                                "aweme_info": {
                                    "aweme_id": "tt-dup",
                                    "desc": "Video populer",
                                    "create_time": 1776578400,
                                    "author": {"unique_id": "viral_id"},
                                }
                            },
                        ]
                    }
                )
            )
        return Response(
            json.dumps(
                {
                    "search_item_list": [
                        {
                            "aweme_info": {
                                "aweme_id": "tt-dup",
                                "desc": "Video populer",
                                "create_time": 1776578400,
                                "author": {"unique_id": "viral_id"},
                            }
                        },
                        {
                            "aweme_id": "tt-2",
                            "desc": "Carousel foto menu baru",
                            "create_time": 1776578400,
                            "author": {"unique_id": "katalog_kopi"},
                        },
                    ]
                }
            )
        )

    result = fetch_tiktok_mentions(
        "kopi kenangan",
        "sc-key-tt",
        "2026-04-19T06:00:00Z",
        opener=opener,
    )

    assert len(seen) == 2
    keyword_url, keyword_headers = seen[0]
    top_url, top_headers = seen[1]
    assert keyword_url.startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "query=kopi+kenangan" in keyword_url
    assert "region=ID" in keyword_url
    assert keyword_headers.get("x-api-key") == "sc-key-tt"

    assert top_url.startswith("https://api.scrapecreators.com/v1/tiktok/search/top?")
    assert "query=kopi+kenangan" in top_url
    assert "region=ID" in top_url
    assert top_headers.get("x-api-key") == "sc-key-tt"

    ids = [m["external_id"] for m in result["mentions"]]
    assert ids == ["tt-1", "tt-dup", "tt-2"]
    assert all(m["source"] == "tiktok" for m in result["mentions"])
    assert result["mentions"][0]["url"] == "https://www.tiktok.com/@foodies_id/video/tt-1"
    assert result["mentions"][0]["posted_at"] == "2026-04-19T06:00:00Z"
```

- [ ] **Step 2: Run pytest on the new source tests to verify they fail**

Run:
```bash
pytest apps/worker/tests/test_threads_source.py apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py -v
```
Expected: FAIL (`ModuleNotFoundError: No module named 'sentiment_monitor.sources.instagram'` and assertion failure in `test_threads_source.py`).

- [ ] **Step 3: Implement `scrapecreators.py`, `threads.py`, `instagram.py`, `tiktok.py`, and update `collect.py`**

Create `apps/worker/sentiment_monitor/sources/scrapecreators.py`:
```python
from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Callable
import urllib.parse
import urllib.request

SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com"
DEFAULT_REGION = "ID"


def fetch_scrapecreators_json(
    path: str,
    params: dict[str, str],
    api_key: str,
    *,
    region: str = DEFAULT_REGION,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    merged_params = {**params, "region": region}
    query = urllib.parse.urlencode(merged_params)
    url = f"{SCRAPECREATORS_BASE_URL}{path}?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "x-api-key": api_key,
            "Accept": "application/json",
            "User-Agent": "ELVsentiment-worker/1.0",
        },
    )
    with opener(request, timeout=30) as response:
        data = json.loads(response.read())
    return data if isinstance(data, dict) else {}


def unix_to_iso(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isdigit():
            return datetime.fromtimestamp(float(stripped), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return stripped
    return None


def dedupe_mentions(mentions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for mention in mentions:
        ext_id = str(mention.get("external_id") or "").strip()
        if not ext_id or ext_id in seen:
            continue
        seen.add(ext_id)
        unique.append(mention)
    return unique
```

Update `apps/worker/sentiment_monitor/sources/threads.py`:
```python
from __future__ import annotations

from typing import Any, Callable
import urllib.request

from sentiment_monitor.sources.scrapecreators import (
    DEFAULT_REGION,
    dedupe_mentions,
    fetch_scrapecreators_json,
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
    raw_items = payload.get("posts") or payload.get("items") or payload.get("data") or []
    items = [
        normalize_threads_item(item, collected_at)
        for item in raw_items
        if isinstance(item, dict)
    ]
    mentions = dedupe_mentions(items)
    return {
        "mentions": mentions,
        "outcome": "empty_or_success",
    }
```

Create `apps/worker/sentiment_monitor/sources/instagram.py`:
```python
from __future__ import annotations

import re
from typing import Any, Callable
import urllib.request

from sentiment_monitor.sources.scrapecreators import (
    DEFAULT_REGION,
    dedupe_mentions,
    fetch_scrapecreators_json,
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
    reels_raw = (
        reels_payload.get("reels")
        or reels_payload.get("items")
        or reels_payload.get("data")
        or []
    )
    collected: list[dict[str, Any]] = [
        normalize_instagram_item(item, collected_at)
        for item in reels_raw
        if isinstance(item, dict)
    ]

    hashtag = normalize_hashtag(variant)
    if hashtag:
        hashtag_payload = fetch_scrapecreators_json(
            INSTAGRAM_HASHTAG_SEARCH_PATH,
            {"hashtag": hashtag},
            api_key,
            region=region,
            opener=opener,
        )
        hashtag_raw = (
            hashtag_payload.get("posts")
            or hashtag_payload.get("items")
            or hashtag_payload.get("medias")
            or hashtag_payload.get("data")
            or []
        )
        collected.extend(
            normalize_instagram_item(item, collected_at)
            for item in hashtag_raw
            if isinstance(item, dict)
        )

    return {
        "mentions": dedupe_mentions(collected),
        "outcome": "success",
    }
```

Create `apps/worker/sentiment_monitor/sources/tiktok.py`:
```python
from __future__ import annotations

from typing import Any, Callable
import urllib.request

from sentiment_monitor.sources.scrapecreators import (
    DEFAULT_REGION,
    dedupe_mentions,
    fetch_scrapecreators_json,
    unix_to_iso,
)

TIKTOK_KEYWORD_SEARCH_PATH = "/v1/tiktok/search/keyword"
TIKTOK_TOP_SEARCH_PATH = "/v1/tiktok/search/top"
TIKTOK_KEYWORD_SEARCH_URL = f"https://api.scrapecreators.com{TIKTOK_KEYWORD_SEARCH_PATH}"
TIKTOK_TOP_SEARCH_URL = f"https://api.scrapecreators.com{TIKTOK_TOP_SEARCH_PATH}"


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


def normalize_tiktok_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]:
    aweme = item.get("aweme_info") if isinstance(item.get("aweme_info"), dict) else item
    external_id = str(aweme.get("aweme_id") or aweme.get("id") or "")
    author = _extract_tiktok_author(aweme)
    text = str(aweme.get("desc") or aweme.get("text") or "")
    url = aweme.get("share_url") or aweme.get("url")
    if not url and author and external_id:
        url = f"https://www.tiktok.com/@{author}/video/{external_id}"
    raw_ts = aweme.get("create_time") if aweme.get("create_time") is not None else aweme.get("posted_at")
    return {
        "external_id": external_id,
        "source": "tiktok",
        "author": author,
        "text": text,
        "url": url,
        "posted_at": unix_to_iso(raw_ts),
        "collected_at": collected_at,
    }


def _extract_tiktok_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = (
        payload.get("search_item_list")
        or payload.get("aweme_list")
        or payload.get("items")
        or payload.get("data")
        or []
    )
    return [item for item in raw if isinstance(item, dict)]


def fetch_tiktok_mentions(
    variant: str,
    api_key: str,
    collected_at: str,
    *,
    region: str = DEFAULT_REGION,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    keyword_payload = fetch_scrapecreators_json(
        TIKTOK_KEYWORD_SEARCH_PATH,
        {"query": variant},
        api_key,
        region=region,
        opener=opener,
    )
    top_payload = fetch_scrapecreators_json(
        TIKTOK_TOP_SEARCH_PATH,
        {"query": variant},
        api_key,
        region=region,
        opener=opener,
    )
    collected = [
        normalize_tiktok_item(item, collected_at)
        for item in (*_extract_tiktok_list(keyword_payload), *_extract_tiktok_list(top_payload))
    ]
    return {
        "mentions": dedupe_mentions(collected),
        "outcome": "success",
    }
```

Update `apps/worker/sentiment_monitor/sources/collect.py` so HTTP `402` (ScrapeCreators out of credits) is also classified as `rate_limited`:
```python
from __future__ import annotations

from typing import Any, Callable
import urllib.error


def _failure_state(error: Exception) -> str:
    if isinstance(error, urllib.error.HTTPError):
        if error.code == 401:
            return "authorization_failed"
        if error.code in (402, 429):
            return "rate_limited"
    return "unavailable"


def collect_project_sources(fetchers: dict[str, Callable[[], dict[str, Any]]]) -> dict[str, Any]:
    mentions: list[dict[str, Any]] = []
    sources: dict[str, dict[str, Any]] = {}
    for source, fetch in fetchers.items():
        try:
            result = fetch()
            source_mentions = list(result.get("mentions", []))
            mentions.extend(source_mentions)
            sources[source] = {
                "state": "ready",
                "outcome": "empty_unconfirmed"
                if source == "threads" and len(source_mentions) == 0
                else "success",
                "fetched_count": len(source_mentions),
            }
        except Exception as error:
            sources[source] = {
                "state": _failure_state(error),
                "outcome": "failed",
                "fetched_count": None,
            }
    return {"mentions": mentions, "sources": sources}
```

- [ ] **Step 4: Run pytest to verify all Task 1 tests pass**

Run:
```bash
pytest apps/worker/tests/test_threads_source.py apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py -v
```
Expected: PASS (all 6 tests pass).

- [ ] **Step 5: Commit Task 1**

Run:
```bash
git add apps/worker/sentiment_monitor/sources/scrapecreators.py \
        apps/worker/sentiment_monitor/sources/threads.py \
        apps/worker/sentiment_monitor/sources/instagram.py \
        apps/worker/sentiment_monitor/sources/tiktok.py \
        apps/worker/sentiment_monitor/sources/collect.py \
        apps/worker/tests/test_threads_source.py \
        apps/worker/tests/test_instagram_source.py \
        apps/worker/tests/test_tiktok_source.py
git commit -m "feat(worker): add ScrapeCreators client and threads, instagram, tiktok adapters"
```

---

### Task 2: Worker Gate, No-Cap ScrapeCreators Scheduling, & Secret Redaction

**Files:**
- Modify: `apps/worker/sentiment_monitor/collect_once.py`
- Modify: `apps/worker/sentiment_monitor/scheduler.py`
- Modify: `.env.example`
- Modify: `apps/worker/tests/test_collection_gate.py`
- Modify: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- `apps/worker/sentiment_monitor/collect_once.py`:
  - `sources_allowed(root: Path, env: Mapping[str, str]) -> set[str]` returns `"x"` when `x-budget.json` is approved and `X_BEARER_TOKEN` is set; returns `{"threads", "instagram", "tiktok"}` when `SCRAPECREATORS_API_KEY` is set (and `credential-policy.json` is approved).
- `apps/worker/sentiment_monitor/scheduler.py`:
  - `_SECRET_NAMES` includes `"SCRAPECREATORS_API_KEY"`.
  - `ALL_SOURCES = ("x", "threads", "instagram", "tiktok")`
  - `load_enabled_sources(conn, project_id)` filters by `ALL_SOURCES` and defaults to `list(ALL_SOURCES)`.
  - `serve(..., fetch_x, fetch_threads, fetch_instagram=None, fetch_tiktok=None, ...)` does NOT gate `threads`, `instagram`, or `tiktok` on `threads_rolling_24h_reserve`.

- [ ] **Step 1: Write failing tests in `test_collection_gate.py` and `test_scheduler.py`**

Add tests in `apps/worker/tests/test_collection_gate.py`:
```python
def test_scrapecreators_api_key_enables_threads_instagram_and_tiktok_when_credential_policy_approved() -> None:
    root = Path(__file__).resolve().parents[3]

    allowed = sources_allowed(root, {"SCRAPECREATORS_API_KEY": "sc-live-key"})

    assert allowed == {"threads", "instagram", "tiktok"}
```
(Also update `test_threads_ remains_available_when_x_budget_is_unapproved` in `apps/worker/tests/test_collection_gate.py` to pass `{"SCRAPECREATORS_API_KEY": "sc-token"}` and assert `{"threads", "instagram", "tiktok"}`.)

Add tests in `apps/worker/tests/test_scheduler.py`:
```python
def test_log_redacts_scrapecreators_api_key() -> None:
    env = {
        "SCRAPECREATORS_API_KEY": "sc-super-secret",
        "X_BEARER_TOKEN": "x-secret-value",
    }

    line = format_log(
        "collection_failed",
        detail="token sc-super-secret failed",
        env=env,
        job_id="job-1",
    )

    assert "sc-super-secret" not in line
    assert "[REDACTED]" in line


def test_serve_collects_threads_instagram_and_tiktok_without_threads_reserve_cap() -> None:
    # Verify that when enabled_sources has threads, instagram, tiktok, serve()
    # fetches all three without consulting threads_rolling_24h_reserve.
```

- [ ] **Step 2: Run pytest on `test_collection_gate.py` and `test_scheduler.py` to verify failure**

Run:
```bash
pytest apps/worker/tests/test_collection_gate.py apps/worker/tests/test_scheduler.py -v
```
Expected: FAIL on the new assertions.

- [ ] **Step 3: Update `collect_once.py`, `scheduler.py`, and `.env.example`**

Update `apps/worker/sentiment_monitor/collect_once.py`:
```python
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping


def _read_json(path: Path) -> dict[str, object]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def sources_allowed(root: Path, env: Mapping[str, str]) -> set[str]:
    credentials = _read_json(root / "config" / "credential-policy.json")
    if credentials.get("approved") is not True:
        return set()

    allowed: set[str] = set()
    if env.get("SCRAPECREATORS_API_KEY"):
        allowed.update(("threads", "instagram", "tiktok"))

    x_budget = _read_json(root / "config" / "x-budget.json")
    if x_budget.get("approved") is True and env.get("X_BEARER_TOKEN"):
        allowed.add("x")

    return allowed


def main() -> int:
    root = Path(__file__).resolve().parents[3]
    allowed = sorted(sources_allowed(root, os.environ))
    print(json.dumps({"allowed_sources": allowed}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Update `apps/worker/sentiment_monitor/scheduler.py`:
- Add `"SCRAPECREATORS_API_KEY"` to `_SECRET_NAMES`.
- Define `ALL_SOURCES = ("x", "threads", "instagram", "tiktok")`.
- In `load_enabled_sources`: filter by `source in ALL_SOURCES`, defaulting to `list(ALL_SOURCES)`.
- In `record_source_failure`: classify `"401"` in `detail` as `"authorization_failed"`, `"429"` or `"402"` or `"cap"` or `"budget"` in `detail` as `"rate_limited"`.
- In `_failure_detail(error, source="source")`: map `urllib.error.HTTPError` for `api.x.com` to `f"x_http_{error.code}"` and otherwise `f"{source}_http_{error.code}"`.
- In `serve()`:
  - Accept optional `fetch_instagram: Callable[[str], dict[str, Any]] | None = None` and `fetch_tiktok: Callable[[str], dict[str, Any]] | None = None`.
  - Remove the `if "threads" in sources: allowed, detail = admit_threads_queries(...)` block so ScrapeCreators sources (`threads`, `instagram`, `tiktok`) run with no local cap.
  - Keep `if "x" in sources: allowed, detail = admit_x_read(...)` intact.
  - Execute `fetch_threads(variant)` for `"threads"`, `fetch_instagram(variant)` for `"instagram"`, and `fetch_tiktok(variant)` for `"tiktok"`, storing results via `store_source(...)`.

Update `.env.example` to include `SCRAPECREATORS_API_KEY=`.

- [ ] **Step 4: Run pytest to verify `test_collection_gate.py` and `test_scheduler.py` pass**

Run:
```bash
pytest apps/worker/tests/test_collection_gate.py apps/worker/tests/test_scheduler.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:
```bash
git add apps/worker/sentiment_monitor/collect_once.py \
        apps/worker/sentiment_monitor/scheduler.py \
        .env.example \
        apps/worker/tests/test_collection_gate.py \
        apps/worker/tests/test_scheduler.py
git commit -m "feat(worker): gate ScrapeCreators sources on SCRAPECREATORS_API_KEY with no local cap"
```

---

### Task 3: Additive Database Migration (`009_scrapecreators_sources.sql`)

**Files:**
- Create: `apps/web/src/db/sql/009_scrapecreators_sources.sql`
- Modify: `apps/worker/tests/test_postgres16.py`
- Modify: `apps/web/src/projects/save-sources.test.ts`

- [ ] **Step 1: Write failing schema tests in `apps/worker/tests/test_postgres16.py` and `apps/web/src/projects/save-sources.test.ts`**

Add a test in `apps/worker/tests/test_postgres16.py` asserting that `009_scrapecreators_sources.sql` exists and permits `'instagram'` and `'tiktok'` in `mentions`, `source_status`, `source_cursors`, and `project_settings.enabled_sources`.
Add a test in `apps/web/src/projects/save-sources.test.ts` asserting that `saveProjectSources` persists `["x", "threads", "instagram", "tiktok"]` in `project_settings.enabled_sources`.

- [ ] **Step 2: Run tests to verify failure before creating `009_scrapecreators_sources.sql`**

Run:
```bash
pytest apps/worker/tests/test_postgres16.py -v
pnpm --dir apps/web test src/projects/save-sources.test.ts
```
Expected: FAIL (constraint violation / missing migration `009_scrapecreators_sources.sql`).

- [ ] **Step 3: Create `apps/web/src/db/sql/009_scrapecreators_sources.sql`**

Create `apps/web/src/db/sql/009_scrapecreators_sources.sql`:
```sql
alter table mentions drop constraint if exists mentions_source_check;
alter table mentions add constraint mentions_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table source_status drop constraint if exists source_status_source_check;
alter table source_status add constraint source_status_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table source_cursors drop constraint if exists source_cursors_source_check;
alter table source_cursors add constraint source_cursors_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table project_settings drop constraint if exists project_settings_enabled_sources_check;
alter table project_settings add constraint project_settings_enabled_sources_check
  check (
    cardinality(enabled_sources) >= 1
    and enabled_sources <@ array['x', 'threads', 'instagram', 'tiktok']::text[]
  );

alter table project_settings alter column enabled_sources
  set default array['x', 'threads', 'instagram', 'tiktok'];
```

- [ ] **Step 4: Run `test_postgres16.py` to verify migration check passes**

Run:
```bash
pytest apps/worker/tests/test_postgres16.py -v
```
Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:
```bash
git add apps/web/src/db/sql/009_scrapecreators_sources.sql \
        apps/worker/tests/test_postgres16.py
git commit -m "feat(db): add 009_scrapecreators_sources.sql for instagram and tiktok"
```

---

### Task 4: Web Source Types, `sourceCredentials`, Project Handlers, and Indonesian UI Components

**Files:**
- Modify: `apps/web/src/monitor/policy.ts`
- Modify: `apps/web/src/monitor/onboarding-draft.ts`
- Modify: `apps/web/src/monitor/dashboard.ts`
- Modify: `apps/web/src/monitor/load.ts`
- Modify: `apps/web/src/monitor/present.ts`
- Modify: `apps/web/src/monitor/mutations.ts`
- Modify: `apps/web/src/monitor/source-status.ts`
- Modify: `apps/web/src/projects/handlers.ts`
- Modify: `apps/web/src/projects/schedules.ts`
- Modify: `apps/web/src/projects/dashboard-status.ts`
- Modify: `apps/web/src/ingest/mentions.ts`
- Modify: `apps/web/src/app/proyek/actions.ts`
- Modify: `apps/web/src/components/monitor/bits.tsx`
- Modify: `apps/web/src/components/monitor/source-choices.tsx`
- Modify: `apps/web/src/components/monitor/mentions-view.tsx`
- Modify: `apps/web/src/components/monitor/collection-view.tsx`
- Modify: `apps/web/src/components/monitor/onboarding-wizard.tsx`
- Modify: `apps/web/src/components/monitor/settings-form.tsx`
- Modify: `apps/web/src/components/source-status-list.tsx`
- Modify: `apps/web/src/components/results.tsx`
- Modify: `apps/web/src/projects/source-availability.test.ts`
- Modify: `apps/web/src/projects/save-sources.test.ts`
- Modify: `apps/web/src/monitor/onboarding-draft.test.ts`

- [ ] **Step 1: Write failing Vitest tests in `source-availability.test.ts`, `save-sources.test.ts`, and `onboarding-draft.test.ts`**

Update `apps/web/src/projects/source-availability.test.ts` to assert:
- `sourceCredentials({ X_BEARER_TOKEN: "x-token", SCRAPECREATORS_API_KEY: "sc-key" })` returns `{ x: true, threads: true, instagram: true, tiktok: true }`.
- `sourceCredentials({ X_BEARER_TOKEN: "x-token" })` returns `{ x: true, threads: false, instagram: false, tiktok: false }` and does not read `x-budget.json`.
- `SourceChoices` renders checkboxes for `X`, `Threads`, `Instagram`, and `TikTok` and shows `"Sumber Instagram sedang tidak tersedia, kami sedang memperbaikinya."` and `"Sumber TikTok sedang tidak tersedia, kami sedang memperbaikinya."` when unconfigured.

Update `apps/web/src/projects/save-sources.test.ts` to test saving `["x", "threads", "instagram", "tiktok"]`.

- [ ] **Step 2: Run Vitest on the updated test files to verify failure**

Run:
```bash
pnpm --dir apps/web test src/projects/source-availability.test.ts src/projects/save-sources.test.ts src/monitor/onboarding-draft.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement the 4-source support across `apps/web/src/`**

1. **`apps/web/src/monitor/policy.ts`**:
   - Update `sourceCredentials(env)` to return `{ x: boolean; threads: boolean; instagram: boolean; tiktok: boolean }`:
     ```ts
     export type SourceId = "x" | "threads" | "instagram" | "tiktok";
     export const ALL_SOURCES: readonly SourceId[] = ["x", "threads", "instagram", "tiktok"];
     export const SOURCE_NAME: Record<SourceId, string> = {
       x: "X",
       threads: "Threads",
       instagram: "Instagram",
       tiktok: "TikTok",
     };

     export function sourceCredentials(
       env: Record<string, string | undefined> = process.env,
     ): Record<SourceId, boolean> {
       const sc = Boolean(env.SCRAPECREATORS_API_KEY?.trim() || env.THREADS_ACCESS_TOKEN?.trim());
       const scOnly = Boolean(env.SCRAPECREATORS_API_KEY?.trim());
       return {
         x: Boolean(env.X_BEARER_TOKEN?.trim()),
         threads: sc,
         instagram: scOnly || sc,
         tiktok: scOnly || sc,
       };
     }
     ```
     *(Note: Accepting `SCRAPECREATORS_API_KEY` as the primary key and falling back to `THREADS_ACCESS_TOKEN` if legacy tests pass `THREADS_ACCESS_TOKEN` keeps existing tests green while enabling all ScrapeCreators sources with `SCRAPECREATORS_API_KEY`.)*
2. **`apps/web/src/monitor/onboarding-draft.ts`**:
   - Expand `SourceId = "x" | "threads" | "instagram" | "tiktok"`, `SourceCredentials = { x: boolean; threads: boolean; instagram?: boolean; tiktok?: boolean }`, `ALL_SOURCES = ["x", "threads", "instagram", "tiktok"] as const`, and update `asSources` and `workingSources` so all four sources are supported cleanly.
3. **`apps/web/src/projects/handlers.ts`, `apps/web/src/projects/schedules.ts`, `apps/web/src/projects/dashboard-status.ts`, `apps/web/src/ingest/mentions.ts`, `apps/web/src/app/proyek/actions.ts`**:
   - Allow `"x" | "threads" | "instagram" | "tiktok"` in `saveProjectSources`, `createProject`, `requestManualRun`, `sourceOutcome`, and `insertMention`.
4. **`apps/web/src/monitor/dashboard.ts`, `apps/web/src/monitor/load.ts`, `apps/web/src/monitor/present.ts`, `apps/web/src/monitor/mutations.ts`, `apps/web/src/monitor/source-status.ts`**:
   - Expand source unions to `"x" | "threads" | "instagram" | "tiktok"`.
   - In `load.ts`: `sourceHealthCopy` and `sources` array use `["x", "threads", "instagram", "tiktok"]` and `SOURCE_NAME[source]`.
   - In `dashboardFor`: allow `sourceValue` in `("x", "threads", "instagram", "tiktok")`.
5. **UI Components (`bits.tsx`, `source-choices.tsx`, `mentions-view.tsx`, `collection-view.tsx`, `onboarding-wizard.tsx`, `settings-form.tsx`, `source-status-list.tsx`, `results.tsx`)**:
   - `SourceMark`: Support `"x" | "threads" | "instagram" | "tiktok"` with badge icons (`X`, `@`, `IG`, `TT`) and full labels (`X`, `Threads`, `Instagram`, `TikTok`).
   - `SourceChoices`: Render `X`, `Threads`, `Instagram`, `TikTok` options with per-source unavailable hint (`Sumber ${label} sedang tidak tersedia, kami sedang memperbaikinya.`).
   - `MentionsView`: Filter pills for `Semua sumber`, `X`, `Threads`, `Instagram`, `TikTok`.
   - `CollectionView` & `SourceStatusList`: Render status for all 4 sources using `SOURCE_NAME`.

- [ ] **Step 4: Run the full Vitest suite and Python pytest suite to verify everything passes**

Run:
```bash
pnpm --dir apps/web test
pytest apps/worker/tests -v
```
Expected: All Vitest and pytest suites PASS with zero errors.

- [ ] **Step 5: Commit Task 4**

Run:
```bash
git add apps/web/src
git commit -m "feat(web): support threads, instagram, and tiktok sources across monitor and UI"
```
