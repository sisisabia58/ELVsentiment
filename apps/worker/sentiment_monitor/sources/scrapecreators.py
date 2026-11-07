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
