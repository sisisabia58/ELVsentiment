from datetime import datetime, timezone
from typing import Any


class CollectionProviderError(Exception):
    def __init__(
        self,
        code: str,
        *,
        http_status: int | None = None,
        credits_charged: int | None = None,
        counts: dict[str, int] | None = None,
        body_length: int | None = None,
        route_events: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.credits_charged = credits_charged
        self.counts = counts
        self.body_length = body_length
        self.route_events = route_events


def hashtag_field_names(value: Any) -> list[str]:
    """Collect hashtag names from common provider payload shapes."""
    names: list[str] = []

    def add(candidate: Any) -> None:
        if not isinstance(candidate, str):
            return
        text = candidate.strip()
        if not text:
            return
        names.append(text[1:] if text.startswith("#") else text)

    if isinstance(value, str):
        add(value)
    elif isinstance(value, list):
        for entry in value:
            if isinstance(entry, str):
                add(entry)
            elif isinstance(entry, dict):
                for key in ("hashtag_name", "cha_name", "name", "hashtag", "title"):
                    add(entry.get(key))
    elif isinstance(value, dict):
        for key in ("hashtag_name", "cha_name", "name", "hashtag", "title"):
            add(value.get(key))
        edges = value.get("edges")
        if isinstance(edges, list):
            for edge in edges:
                if not isinstance(edge, dict):
                    continue
                node = edge.get("node")
                if isinstance(node, dict):
                    for key in ("name", "hashtag_name", "title"):
                        add(node.get(key))

    unique: list[str] = []
    seen: set[str] = set()
    for name in names:
        folded = name.casefold()
        if folded in seen:
            continue
        seen.add(folded)
        unique.append(name)
    return unique


def _epoch_to_iso(value: int | float) -> str | None:
    number = float(value)
    # Providers mix seconds and milliseconds; values past ~year 5138 are ms.
    if abs(number) >= 1e11:
        number /= 1000.0
    try:
        return datetime.fromtimestamp(number, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, OverflowError, OSError):
        return None


def unix_to_iso(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _epoch_to_iso(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.isascii() and stripped.isdigit():
            return _epoch_to_iso(int(stripped))
        return stripped
    return None
