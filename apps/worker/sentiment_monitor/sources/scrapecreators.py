from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request

SCRAPECREATORS_BASE_URL = "https://api.scrapecreators.com"
DEFAULT_REGION = "ID"


class ScrapeCreatorsError(Exception):
    def __init__(
        self,
        code: str,
        *,
        http_status: int | None = None,
        credits_charged: int | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.credits_charged = credits_charged


def credits_from(payload: dict[str, Any]) -> int | None:
    value = payload.get("credits_charged")
    if type(value) is int:
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def select_post_list(payload: dict[str, Any], keys: tuple[str, ...]) -> list[Any]:
    for key in keys:
        if key not in payload:
            continue
        value = payload[key]
        if not isinstance(value, list):
            raise ScrapeCreatorsError("malformed_posts")
        if value and not any(isinstance(item, dict) for item in value):
            raise ScrapeCreatorsError("malformed_posts")
        return value
    raise ScrapeCreatorsError("missing_posts")


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
    try:
        with opener(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raise ScrapeCreatorsError(f"http_{error.code}", http_status=error.code) from None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ScrapeCreatorsError("malformed_json") from None
    if not isinstance(data, dict):
        raise ScrapeCreatorsError("malformed_envelope")
    if data.get("success") is False:
        raise ScrapeCreatorsError("success_false", credits_charged=credits_from(data))
    return data


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
