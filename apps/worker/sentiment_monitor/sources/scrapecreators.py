from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request

SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com"


class ScrapeCreatorsError(Exception):
    def __init__(
        self,
        code: str,
        *,
        http_status: int | None = None,
        credits_charged: int | None = None,
        counts: dict[str, int] | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.credits_charged = credits_charged
        self.counts = counts


def credits_from(payload: dict[str, Any]) -> int | None:
    value = payload.get("credits_charged")
    if type(value) is int:
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


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


def select_post_list(payload: dict[str, Any], keys: tuple[str, ...]) -> list[Any]:
    for key in keys:
        if key not in payload:
            continue
        value = payload[key]
        if not isinstance(value, list):
            raise ScrapeCreatorsError("malformed_posts")
        if value and not any(isinstance(item, dict) for item in value):
            raise ScrapeCreatorsError(
                "malformed_posts",
                counts={"returned": len(value), "parsed": 0, "deduplicated": 0},
            )
        return value
    raise ScrapeCreatorsError("missing_posts")


def known_credits(values: list[int | None]) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None


def failure_counts(
    returned: int | None, collected: list[dict[str, Any]]
) -> dict[str, int]:
    unique = dedupe_mentions(collected)
    counts = {
        "parsed": len(collected),
        "deduplicated": len(collected) - len(unique),
    }
    if returned is not None:
        counts["returned"] = returned
    return counts


def has_usable_mentions(mentions: list[dict[str, Any]]) -> bool:
    return any(str(mention.get("external_id") or "").strip() for mention in mentions)


def carry_attempt_context(
    error: ScrapeCreatorsError,
    credits: list[int | None],
    returned: int | None,
    collected: list[dict[str, Any]],
    *,
    http_status: int | None = None,
    parsed: int | None = None,
    error_credits_already_counted: bool = False,
) -> ScrapeCreatorsError:
    if error.credits_charged is not None and not error_credits_already_counted:
        credits.append(error.credits_charged)
    error.credits_charged = known_credits(credits)
    extra_returned = None
    if isinstance(error.counts, dict):
        known_returned = error.counts.get("returned")
        if type(known_returned) is int and known_returned >= 0:
            extra_returned = known_returned
    if returned is None and extra_returned is None:
        total_returned = None
    else:
        total_returned = (returned or 0) + (extra_returned or 0)
    error.counts = failure_counts(total_returned, collected)
    if parsed is not None:
        error.counts["parsed"] = parsed
    if error.http_status is None and http_status is not None:
        error.http_status = http_status
    return error


class FetchedJSON(dict):
    """Decoded JSON object plus the transport status that produced it."""

    def __init__(self, data: dict[str, Any], http_status: int | None) -> None:
        super().__init__(data)
        self.http_status = http_status


def _response_status(response: Any) -> int | None:
    status = getattr(response, "status", None)
    if type(status) is int:
        return status
    getcode = getattr(response, "getcode", None)
    if callable(getcode):
        value = getcode()
        if type(value) is int:
            return value
    return None


def fetch_scrapecreators_json(
    path: str,
    params: dict[str, str],
    api_key: str,
    *,
    region: str | None = None,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    merged_params = dict(params)
    if region is not None:
        merged_params["region"] = region
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
    http_status: int | None = None
    try:
        with opener(request, timeout=30) as response:
            # Capture the status before reading so a read failure still knows
            # which response produced it.
            http_status = _response_status(response)
            raw = response.read()
    except urllib.error.HTTPError as error:
        raise ScrapeCreatorsError(f"http_{error.code}", http_status=error.code) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        code = "read_timeout" if isinstance(error, TimeoutError) else "transport_error"
        raise ScrapeCreatorsError(code, http_status=http_status) from None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ScrapeCreatorsError("malformed_json", http_status=http_status) from None
    if not isinstance(data, dict):
        raise ScrapeCreatorsError("malformed_envelope", http_status=http_status)
    if data.get("success") is False:
        raise ScrapeCreatorsError(
            "success_false",
            http_status=http_status,
            credits_charged=credits_from(data),
        )
    return FetchedJSON(data, http_status)


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
    seen: dict[str, dict[str, Any]] = {}
    unique: list[dict[str, Any]] = []
    for mention in mentions:
        ext_id = str(mention.get("external_id") or "").strip()
        if not ext_id:
            continue
        route_id = mention.get("route_id")
        existing = seen.get(ext_id)
        if existing is not None:
            if route_id:
                route_ids = existing.setdefault(
                    "route_ids", [existing["route_id"]] if existing.get("route_id") else []
                )
                if route_id not in route_ids:
                    route_ids.append(route_id)
            continue
        kept = dict(mention)
        if route_id:
            kept["route_ids"] = [route_id]
        seen[ext_id] = kept
        unique.append(kept)
    return unique
