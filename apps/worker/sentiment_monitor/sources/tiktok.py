from typing import Any

from sentiment_monitor.sources.normalization import hashtag_field_names, unix_to_iso


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
    if isinstance(value, str):
        text = value.strip()
        if text.isascii() and text.isdigit():
            return int(text)
    return None


def _optional_text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def normalize_tiktok_item(item: dict[str, Any], collected_at: str) -> dict[str, Any]:
    aweme = item.get("aweme_info") if isinstance(item.get("aweme_info"), dict) else item
    external_id = aweme.get("aweme_id") or aweme.get("id")
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
