"""Canonical post/comment records shared by every provider adapter."""

from __future__ import annotations

from dataclasses import dataclass, field, fields, replace
from datetime import datetime, timezone
import json
import math
import re
import unicodedata
from typing import Iterable, Literal
import urllib.parse

from sentiment_monitor.paths import repo_root
from sentiment_monitor.relevance import literal_match_status, normalize_match_text

PlatformId = Literal[
    "threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin", "x", "web"
]
ProviderId = Literal["scrapecreators", "scrapeatlas", "official_x", "off"]
Relevance = Literal["literal_match", "all_words_match", "no_match"]

# A btree index row is ~2.7 KiB, so a multi-kilobyte external id makes the
# whole platform insert fail. Keep identities well under that and truncate the
# free-text fields that are safe to shorten.
MAX_EXTERNAL_ID_BYTES = 512
MAX_TEXT_LENGTH = 20_000
MAX_TITLE_LENGTH = 1_000
MAX_AUTHOR_LENGTH = 500
MAX_URL_LENGTH = 2_048
MAX_RAW_REF_LENGTH = 2_048
MAX_HASHTAG_LENGTH = 200


@dataclass(frozen=True)
class CanonicalComment:
    external_id: str
    text: str
    author_name: str | None
    author_handle: str | None
    published_at: str | None
    likes: int | None
    replies: int | None
    source_provider: str
    raw_ref: str


@dataclass(frozen=True)
class CanonicalPost:
    platform: PlatformId
    external_id: str
    text: str
    title: str | None
    author_name: str | None
    author_handle: str | None
    url: str | None
    published_at: str | None
    thumbnail_url: str | None
    views: int | None
    likes: int | None
    replies: int | None
    shares: int | None
    top_replies: tuple[CanonicalComment, ...]
    hashtags: tuple[str, ...]
    source_provider: str
    routes: tuple[str, ...]
    raw_ref: str
    collected_at: str
    language: str = "other"
    relevance: Relevance = "no_match"
    web_index: bool = False


@dataclass(frozen=True)
class RouteCall:
    provider: str
    platform: str
    route: str
    outcome: Literal["success", "partial", "failed", "unavailable"]
    http_status: int | None = None
    credits_charged: int | None = None
    body_length: int | None = None
    latency_ms: int | None = None
    safe_detail: str = "ok"


@dataclass(frozen=True)
class PlatformFetch:
    platform: str
    provider: str = "scrapeatlas"
    posts: list[CanonicalPost] = field(default_factory=list)
    calls: list[RouteCall] = field(default_factory=list)
    state: str = "unavailable"
    safe_detail: str = "ok"
    latency_ms: int | None = None
    attempted_providers: tuple[str, ...] = ()
    next_cursor: str | None = field(default=None, repr=False)
    next_companion: str | None = field(default=None, repr=False)


_ID_WORDS = frozenset(
    {
        "aku", "anda", "apa", "banget", "banyak", "baru", "beli", "benar", "bisa",
        "dan", "dari", "dengan", "di", "dong", "enggak", "gak", "ga", "gue", "ini",
        "itu", "jadi", "jangan", "juga", "kalian", "kamu", "karena", "ke", "kita",
        "kok", "lagi", "makan", "mereka", "nya", "pada", "saja", "sangat", "saya",
        "sih", "sudah", "tidak", "untuk", "yang",
    }
)
_EN_WORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "chicken", "crispy",
        "for", "from", "good", "he", "her", "his", "i", "in", "is", "it", "its",
        "my", "not", "of", "on", "or", "our", "she", "so", "that", "the", "their",
        "them", "there", "they", "this", "to", "was", "we", "were", "with", "you",
        "your",
    }
)
_ID_SUFFIXES = ("nya", "lah", "kah", "pun")


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z]+", normalize_match_text(text))


def detect_language(text: str) -> str:
    words = _words(text)
    if len(words) < 2:
        return "other"
    indonesian = sum(1 for word in words if word in _ID_WORDS)
    indonesian += sum(
        1 for word in words if len(word) > 5 and word.endswith(_ID_SUFFIXES)
    )
    english = sum(1 for word in words if word in _EN_WORDS)
    if indonesian > english:
        return "id"
    if english > indonesian:
        return "en"
    return "other"


def _word_pattern(token: str) -> re.Pattern[str]:
    if token.startswith("#"):
        token = token[1:]
    return re.compile(rf"(?<!\w){re.escape(token)}(?!\w)", re.UNICODE)


_ANCHOR_RULES = json.loads((repo_root() / "config" / "cari-relevance.json").read_text(encoding="utf-8"))
_ENTITY_DESCRIPTORS: dict[str, list[str]] = _ANCHOR_RULES["entity_descriptors"]


def _has_entity_anchor(
    tokens: list[str], text: str, hashtags: tuple[str, ...], intent: str,
) -> bool:
    # Only verified entity aliases can stand in for a full query phrase.
    if intent != "phrase" or len(tokens) != 2:
        return False
    left, right = tokens
    for anchor, descriptor in ((left, right), (right, left)):
        if descriptor in _ENTITY_DESCRIPTORS.get(anchor, ()) and (
            _word_pattern(anchor).search(text)
            or any(normalize_match_text(tag).removeprefix("#") == anchor for tag in hashtags)
        ):
            return True
    return False


def text_relevance(
    text: str, title: str | None, keyword: str, intent: str = "phrase", *,
    hashtags: tuple[str, ...] = (),
) -> Relevance:
    for candidate in (text, title or ""):
        if literal_match_status(candidate, keyword, intent, hashtags=hashtags) == "literal_match":
            return "literal_match"
    tokens = normalize_match_text(keyword).split()
    if tokens:
        haystack = normalize_match_text(f"{text} {title or ''}")
        if all(_word_pattern(token).search(haystack) for token in tokens) or _has_entity_anchor(
            tokens, haystack, hashtags, intent
        ):
            return "all_words_match"
    return "no_match"


def keyword_relevance(post: CanonicalPost, keyword: str, intent: str = "phrase") -> Relevance:
    return text_relevance(post.text or "", post.title, keyword, intent, hashtags=post.hashtags)


MAX_DB_COUNT = 2**63 - 1
MAX_CREDIT = 1_000_000
_ASCII_INT = re.compile(r"[0-9]+")
_SURROGATES = re.compile(r"[\ud800-\udfff]")


def safe_optional_int(value: object, *, maximum: int = MAX_DB_COUNT) -> int | None:
    """Accept an ASCII integer, reject negatives/non-finite values, clamp high."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return None
        number = int(value)
    elif isinstance(value, str):
        text = value.strip()
        if not _ASCII_INT.fullmatch(text):
            return None
        number = int(text)
    else:
        return None
    if number < 0:
        return None
    return min(number, maximum)


def safe_credit(value: object) -> int | None:
    """Credits outside a sane per-call range are unknown, not clamped.

    Clamping an oversized header to a large int would let two calls overflow
    the summed credit columns and abort storage (leaving the search running).
    """
    parsed = safe_optional_int(value, maximum=MAX_CREDIT)
    if parsed is None or parsed >= MAX_CREDIT:
        return None
    return parsed


def _clean_text(value: object) -> object:
    if not isinstance(value, str):
        return value
    cleaned = _SURROGATES.sub("", value.replace("\x00", ""))
    try:
        cleaned.encode("utf-8")
    except UnicodeEncodeError:
        cleaned = cleaned.encode("utf-8", "replace").decode("utf-8")
    return cleaned


def _iso(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch_iso(value: int | float) -> str | None:
    number = float(value)
    if not math.isfinite(number):
        return None
    if abs(number) >= 1e11:
        number /= 1000.0
    try:
        parsed = datetime.fromtimestamp(number, tz=timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None
    return _iso(parsed)


def safe_published_at(value: object) -> str | None:
    """Only keep ISO-8601 or epoch seconds/milliseconds that form real dates."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _epoch_iso(value)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if _ASCII_INT.fullmatch(text):
        try:
            return _epoch_iso(int(text))
        except ValueError:
            return None
    candidate = text.replace("Z", "+00:00").replace("z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except (ValueError, OverflowError, OSError):
        return None
    # fromisoformat accepts offsets that overflow UTC (year 9999 with -14:00,
    # year 1 with +14:00). A bad date must make the post undated, not abort the
    # whole platform's search.
    try:
        return _iso(parsed)
    except (ValueError, OverflowError, OSError):
        return None


def _cap_text(value: object, limit: int) -> object:
    if not isinstance(value, str):
        return value
    return value if len(value) <= limit else value[:limit]


def sanitize_post(post: CanonicalPost) -> CanonicalPost:
    return replace(
        post,
        external_id=str(_clean_text(post.external_id) or ""),
        text=str(_cap_text(_clean_text(post.text) or "", MAX_TEXT_LENGTH)),
        title=_cap_text(_clean_text(post.title), MAX_TITLE_LENGTH),
        author_name=_cap_text(_clean_text(post.author_name), MAX_AUTHOR_LENGTH),
        author_handle=_cap_text(_clean_text(post.author_handle), MAX_AUTHOR_LENGTH),
        url=_cap_text(_clean_text(post.url), MAX_URL_LENGTH),
        thumbnail_url=_cap_text(_clean_text(post.thumbnail_url), MAX_URL_LENGTH),
        published_at=safe_published_at(post.published_at),
        views=safe_optional_int(post.views),
        likes=safe_optional_int(post.likes),
        replies=safe_optional_int(post.replies),
        shares=safe_optional_int(post.shares),
        hashtags=tuple(str(_cap_text(_clean_text(tag), MAX_HASHTAG_LENGTH)) for tag in post.hashtags),
        raw_ref=str(_cap_text(_clean_text(post.raw_ref) or "", MAX_RAW_REF_LENGTH)),
        routes=tuple(str(_clean_text(route)) for route in post.routes),
    )


# Hangul fillers are letters (Lo), so a category check keeps them. They paint blank.
_BLANK_LETTERS = frozenset({"\u115f", "\u1160", "\u3164", "\uffa0", "\ufffc", "\u2800"})


def comment_has_visible_text(value: object) -> bool:
    """False for blank, whitespace, and invisible sticker placeholders.

    Facebook photo and sticker replies often arrive as U+FFFC, a zero-width
    character, a Hangul filler, or spaces. Those still have a length, so a
    plain strip keeps an author row with nothing to read.
    """
    if not isinstance(value, str):
        return False
    for char in value:
        if char in _BLANK_LETTERS:
            continue
        category = unicodedata.category(char)
        if category[0] in {"C", "Z", "M"}:
            continue
        return True
    return False


def sanitize_comment(comment: CanonicalComment) -> CanonicalComment:
    return replace(
        comment,
        external_id=str(_clean_text(comment.external_id) or ""),
        text=str(_cap_text(_clean_text(comment.text) or "", MAX_TEXT_LENGTH)),
        author_name=_cap_text(_clean_text(comment.author_name), MAX_AUTHOR_LENGTH),
        author_handle=_cap_text(_clean_text(comment.author_handle), MAX_AUTHOR_LENGTH),
        published_at=safe_published_at(comment.published_at),
        likes=safe_optional_int(comment.likes),
        replies=safe_optional_int(comment.replies),
        raw_ref=str(_cap_text(_clean_text(comment.raw_ref) or "", MAX_RAW_REF_LENGTH)),
    )


def post_identity(post: CanonicalPost) -> tuple[str, str] | None:
    external_id = str(post.external_id or "").strip()
    if external_id:
        return (post.platform, external_id)
    url = str(post.url or "").strip()
    if not url:
        return None
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower()
    netloc = parts.netloc.lower()
    if not scheme or not netloc:
        return None
    path = parts.path.rstrip("/")
    return (post.platform, f"url:{scheme}://{netloc}{path}")


def _parse_iso(value: str | None) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00").replace("z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except Exception:
        # A provider date is untrusted input: a bad value makes the post
        # undated instead of aborting the platform's whole search.
        return None


def _timestamp(value: str | None) -> float | None:
    parsed = _parse_iso(value)
    if parsed is None:
        return None
    # Naive provider timestamps are UTC. Calling .timestamp() on a naive
    # datetime uses the host zone and raises for year 1 (or year 9999 in
    # UTC+ zones), which used to drop a whole platform.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    try:
        return parsed.timestamp()
    except Exception:
        return None


def filter_since(
    posts: Iterable[CanonicalPost], cutoff_iso: str | None
) -> list[CanonicalPost]:
    cutoff = _timestamp(cutoff_iso)
    if cutoff is None:
        return list(posts)
    kept: list[CanonicalPost] = []
    for post in posts:
        published = _timestamp(post.published_at)
        if published is None or published >= cutoff:
            kept.append(post)
    return kept


def engagement_score(post: CanonicalPost) -> int:
    return (
        (post.views or 0)
        + 3 * (post.likes or 0)
        + 2 * (post.replies or 0)
        + 2 * (post.shares or 0)
    )


def _richness(post: CanonicalPost) -> int:
    score = len(post.routes)
    for name in (
        "text", "title", "author_name", "author_handle", "url", "published_at",
        "thumbnail_url", "views", "likes", "replies", "shares",
    ):
        value = getattr(post, name)
        if value is not None and value != "" and value != ():
            score += 1
    return score


def _merge_group(group: list[CanonicalPost]) -> CanonicalPost:
    base = max(group, key=_richness)
    changes: dict[str, object] = {}
    for field in fields(CanonicalPost):
        name = field.name
        if name in ("platform", "external_id", "routes"):
            continue
        current = getattr(base, name)
        if current is None or current == "":
            for other in group:
                if other is base:
                    continue
                value = getattr(other, name)
                if value is not None and value != "":
                    changes[name] = value
                    break
    routes: list[str] = []
    for item in group:
        for route in item.routes:
            if route not in routes:
                routes.append(route)
    if tuple(routes) != base.routes:
        changes["routes"] = tuple(routes)
    return replace(base, **changes)


def dedupe_posts(posts: Iterable[CanonicalPost]) -> list[CanonicalPost]:
    groups: dict[tuple[str, str], list[CanonicalPost]] = {}
    order: list[tuple[str, str]] = []
    for post in posts:
        identity = post_identity(post)
        if identity is None:
            continue
        if identity not in groups:
            groups[identity] = []
            order.append(identity)
        groups[identity].append(post)
    return [_merge_group(groups[identity]) for identity in order]


_RELEVANCE_RANK = {"literal_match": 0, "all_words_match": 1, "no_match": 2}


def sort_posts(posts: Iterable[CanonicalPost], mode: str = "relevance") -> list[CanonicalPost]:
    dated: list[CanonicalPost] = []
    undated: list[CanonicalPost] = []
    for post in posts:
        if _parse_iso(post.published_at) is None:
            undated.append(post)
        else:
            dated.append(post)
    if mode == "newest":
        dated.sort(key=lambda item: item.external_id)
        dated.sort(key=lambda item: _timestamp(item.published_at) or 0.0, reverse=True)
    elif mode == "popular":
        dated.sort(key=lambda item: (-engagement_score(item), item.external_id))
    else:
        dated.sort(
            key=lambda item: (
                _RELEVANCE_RANK.get(item.relevance, 2),
                -engagement_score(item),
                item.external_id,
            )
        )
    undated.sort(key=lambda item: item.external_id)
    return dated + undated
