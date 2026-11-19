from typing import Any

from sentiment_monitor.sources.normalization import hashtag_field_names, unix_to_iso


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
    if isinstance(value, str):
        text = value.strip()
        if text.isascii() and text.isdigit():
            return int(text)
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
    external_id = item.get("pk") or item.get("id") or item.get("code")
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
