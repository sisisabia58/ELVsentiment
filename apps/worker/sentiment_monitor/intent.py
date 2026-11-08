from __future__ import annotations

import unicodedata

VALID_INTENTS = ("phrase", "hashtag")


def canonical_keyword_text(raw: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(raw))
    return " ".join(normalized.split())


def parse_keyword(raw: str, intent: str | None = None) -> tuple[str, str]:
    text = canonical_keyword_text(raw)
    if intent is None:
        resolved = "hashtag" if text.startswith("#") and len(text) > 1 else "phrase"
    else:
        if intent not in VALID_INTENTS:
            raise ValueError("keyword_intent")
        resolved = intent
    return text, resolved


def hashtag_term(raw: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(raw)).casefold()
    return "".join(ch for ch in normalized if ch.isalnum() or ch == "_")


class Keyword(str):
    intent: str

    def __new__(cls, value: str, intent: str = "phrase") -> "Keyword":
        if intent not in VALID_INTENTS:
            raise ValueError("keyword_intent")
        instance = super().__new__(cls, value)
        instance.intent = intent
        return instance
