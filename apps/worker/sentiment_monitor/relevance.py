from __future__ import annotations

import re
import unicodedata

from sentiment_monitor.intent import hashtag_term

MATCH_STATUSES = ("literal_match", "no_literal_match", "unknown_text")


def normalize_match_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def _phrase_status(text: str, keyword: str) -> str:
    phrase = normalize_match_text(keyword)
    if phrase.startswith("#"):
        phrase = phrase[1:]
    if not phrase:
        return "unknown_text"
    pattern = re.compile(rf"(?<!\w){re.escape(phrase)}(?!\w)", re.UNICODE)
    return "literal_match" if pattern.search(text) else "no_literal_match"


def _hashtag_status(text: str, keyword: str) -> str:
    term = hashtag_term(keyword)
    if not term:
        return "unknown_text"
    pattern = re.compile(rf"(?<!\w)#?{re.escape(term)}(?!\w)", re.UNICODE)
    return "literal_match" if pattern.search(text) else "no_literal_match"


def literal_match_status(text: str, keyword: str, intent: str) -> str:
    normalized_text = normalize_match_text(text)
    if not normalized_text:
        return "unknown_text"
    if intent == "hashtag":
        return _hashtag_status(normalized_text, keyword)
    return _phrase_status(normalized_text, keyword)
