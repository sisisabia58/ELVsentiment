from __future__ import annotations

import re
import unicodedata
from typing import Sequence

from sentiment_monitor.intent import hashtag_term

MATCH_STATUSES = ("literal_match", "no_literal_match", "unknown_text")


def normalize_match_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def hashtags_in_text(text: str) -> list[str]:
    return re.findall(r"#(\w+)", str(text or ""), flags=re.UNICODE)


def _without_marks(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _fold_term(value: str) -> str:
    """Case- and accent-insensitive compact form used only for hashtag equality."""
    folded = _without_marks(unicodedata.normalize("NFKC", str(value or "")).casefold())
    return "".join(ch for ch in folded if ch.isalnum() or ch == "_")


def _phrase_status(text: str, keyword: str, hashtags: list[str]) -> str:
    phrase = normalize_match_text(keyword)
    if phrase.startswith("#"):
        phrase = phrase[1:]
    if not phrase:
        return "unknown_text"
    pattern = re.compile(rf"(?<!\w){re.escape(phrase)}(?!\w)", re.UNICODE)
    if pattern.search(text):
        return "literal_match"
    folded = _fold_term(phrase)
    if folded and (" " in phrase or len(folded) >= 2):
        if any(_fold_term(tag) == folded for tag in hashtags):
            return "literal_match"
    return "no_literal_match"


def _hashtag_status(text: str, keyword: str, hashtags: list[str]) -> str:
    term = hashtag_term(keyword)
    if not term:
        return "unknown_text"
    pattern = re.compile(rf"(?<!\w)#?{re.escape(term)}(?!\w)", re.UNICODE)
    if pattern.search(text):
        return "literal_match"
    folded = _fold_term(term)
    if folded and any(_fold_term(tag) == folded for tag in hashtags):
        return "literal_match"
    return "no_literal_match"


def literal_match_status(
    text: str,
    keyword: str,
    intent: str,
    *,
    hashtags: Sequence[str] | None = None,
) -> str:
    normalized_text = normalize_match_text(text)
    names = hashtags_in_text(normalized_text)
    if hashtags:
        names.extend(str(tag) for tag in hashtags if str(tag).strip())
    if not normalized_text and not names:
        return "unknown_text"
    if intent == "hashtag":
        return _hashtag_status(normalized_text, keyword, names)
    return _phrase_status(normalized_text, keyword, names)
