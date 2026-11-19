"""ScrapeAtlas HTTP client with fail-closed metadata.

Only route, outcome, HTTP status, credits, body length, latency and a
whitelisted safe detail code leave this module. Provider bodies, error text,
headers and keys are never retained or exposed.
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Mapping
import urllib.error
import urllib.parse
import urllib.request
from sentiment_monitor.providers.http import urlopen as safe_urlopen

from sentiment_monitor.providers.canonical import safe_credit

SCRAPEATLAS_BASE_URL = "https://api.scrapeatlas.com"
MAX_ERROR_BODY_CHARS = 65536
MAX_BODY_BYTES = 10 * 1024 * 1024

SAFE_DETAILS = frozenset(
    {
        "ok",
        "not_found",
        "busy",
        "upstream_rate_limited",
        "upstream_challenged",
        "request_limit",
        "timeout",
        "http_3xx",
        "http_429",
        "http_5xx",
        "malformed_json",
        "malformed_envelope",
        "body_too_large",
        "failed_status",
        "transport_error",
    }
)


def safe_atlas_detail(code: Any) -> str:
    if isinstance(code, str) and code in SAFE_DETAILS:
        return code
    return "failed_status"


class ScrapeAtlasError(Exception):
    def __init__(
        self,
        code: str,
        *,
        http_status: int | None = None,
        credits_charged: int | None = None,
        credits_remaining: int | None = None,
        body_length: int | None = None,
        latency_ms: int | None = None,
        retry_after_ms: int | None = None,
    ) -> None:
        safe = safe_atlas_detail(code)
        super().__init__(safe)
        self.code = safe
        self.http_status = http_status
        self.credits_charged = credits_charged
        self.credits_remaining = credits_remaining
        self.body_length = body_length
        self.latency_ms = latency_ms
        self.retry_after_ms = retry_after_ms


class ScrapeAtlasJSON(dict):
    def __init__(
        self,
        data: dict[str, Any],
        http_status: int | None,
        body_length: int | None,
        *,
        credits_charged: int | None,
        credits_remaining: int | None,
        coverage_warnings: list[str],
    ) -> None:
        super().__init__(data)
        self.http_status = http_status
        self.body_length = body_length
        self.credits_charged = credits_charged
        self.credits_remaining = credits_remaining
        self.coverage_warnings = coverage_warnings


def _header(headers: Any, name: str) -> Any:
    getter = getattr(headers, "get", None)
    if not callable(getter):
        return None
    for key in (name.lower(), name, name.title(), name.upper()):
        try:
            value = getter(key)
        except TypeError:
            value = None
        if value is not None:
            return value
    return None


def _header_int(headers: Any, name: str) -> int | None:
    value = _header(headers, name)
    if isinstance(value, bool):
        return None
    return safe_credit(value)


def credits_from_headers(headers: Any) -> tuple[int | None, int | None]:
    return (
        _header_int(headers, "x-credits-charged"),
        _header_int(headers, "x-credits-remaining"),
    )


def _body_length(raw: Any) -> int | None:
    if isinstance(raw, (bytes, str)):
        return len(raw)
    return None


def _decode_body(raw: Any) -> str | None:
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")[:MAX_ERROR_BODY_CHARS]
    if isinstance(raw, str):
        return raw[:MAX_ERROR_BODY_CHARS]
    return None


def _read_http_error_body(error: urllib.error.HTTPError) -> tuple[str | None, int | None]:
    read = getattr(error, "read", None)
    if not callable(read):
        return None, None
    try:
        raw = read()
    except Exception:
        return None, None
    return _decode_body(raw), _body_length(raw)


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


def _retry_after_ms(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < 0:
        return None
    if number >= 1000:
        return int(number)
    return int(number * 1000)


def _parse_json(body: str | None) -> Any:
    if not body:
        return None
    try:
        return json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return None


def fetch_scrapeatlas_json(
    path: str,
    params: Mapping[str, Any],
    api_key: str,
    *,
    opener: Callable[..., Any] = safe_urlopen,
    timeout: int = 20,
) -> ScrapeAtlasJSON:
    query = urllib.parse.urlencode(dict(params))
    url = f"{SCRAPEATLAS_BASE_URL}{path}"
    if query:
        url = f"{url}?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "x-api-key": api_key,
            "Accept": "application/json",
            "User-Agent": "ELVsentiment-worker/1.0",
        },
    )
    started = time.monotonic()
    http_status: int | None = None
    try:
        with opener(request, timeout=timeout) as response:
            http_status = _response_status(response)
            headers = getattr(response, "headers", None)
            raw = response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as error:
        latency_ms = int((time.monotonic() - started) * 1000)
        body, body_length = _read_http_error_body(error)
        charged, remaining = credits_from_headers(error.headers)
        if 300 <= error.code < 400:
            raise ScrapeAtlasError(
                "http_3xx",
                http_status=error.code,
                credits_charged=charged,
                credits_remaining=remaining,
                body_length=body_length,
                latency_ms=latency_ms,
            ) from None
        if error.code == 404:
            raise ScrapeAtlasError(
                "not_found",
                http_status=404,
                credits_charged=charged if charged is not None else 0,
                credits_remaining=remaining,
                body_length=body_length,
                latency_ms=latency_ms,
            ) from None
        if error.code == 429:
            payload = _parse_json(body)
            retry_value = None
            if isinstance(payload, dict):
                retry_value = payload.get("retryAfter", payload.get("retry_after"))
            if retry_value is None:
                retry_value = _header(error.headers, "Retry-After")
            raise ScrapeAtlasError(
                "http_429",
                http_status=429,
                credits_charged=charged,
                credits_remaining=remaining,
                body_length=body_length,
                latency_ms=latency_ms,
                retry_after_ms=_retry_after_ms(retry_value),
            ) from None
        code = "http_5xx" if 500 <= error.code <= 599 else "transport_error"
        raise ScrapeAtlasError(
            code,
            http_status=error.code,
            credits_charged=charged,
            credits_remaining=remaining,
            body_length=body_length,
            latency_ms=latency_ms,
        ) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        code = "timeout" if isinstance(error, TimeoutError) else "transport_error"
        raise ScrapeAtlasError(
            code,
            http_status=http_status,
            latency_ms=int((time.monotonic() - started) * 1000),
        ) from None

    latency_ms = int((time.monotonic() - started) * 1000)
    body_length = _body_length(raw)
    charged, remaining = credits_from_headers(headers)
    if isinstance(raw, (bytes, str)) and len(raw) > MAX_BODY_BYTES:
        raise ScrapeAtlasError(
            "body_too_large",
            http_status=http_status,
            credits_charged=charged,
            credits_remaining=remaining,
            body_length=body_length,
            latency_ms=latency_ms,
        ) from None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        raise ScrapeAtlasError(
            "malformed_json",
            http_status=http_status,
            credits_charged=charged,
            credits_remaining=remaining,
            body_length=body_length,
            latency_ms=latency_ms,
        ) from None
    if not isinstance(data, dict):
        raise ScrapeAtlasError(
            "malformed_envelope",
            http_status=http_status,
            credits_charged=charged,
            credits_remaining=remaining,
            body_length=body_length,
            latency_ms=latency_ms,
        )
    if data.get("success") is False or data.get("status") == "failed":
        failure = data.get("failure")
        code = failure.get("code") if isinstance(failure, dict) else None
        safe = safe_atlas_detail(code) if isinstance(code, str) else "failed_status"
        raise ScrapeAtlasError(
            safe,
            http_status=http_status,
            credits_charged=0 if charged is None and safe == "not_found" else charged,
            credits_remaining=remaining,
            body_length=body_length,
            latency_ms=latency_ms,
        )
    coverage = data.get("coverage")
    warnings = coverage.get("warnings") if isinstance(coverage, dict) else None
    coverage_warnings = (
        [str(item) for item in warnings] if isinstance(warnings, list) else []
    )
    return ScrapeAtlasJSON(
        data,
        http_status,
        body_length,
        credits_charged=charged,
        credits_remaining=remaining,
        coverage_warnings=coverage_warnings,
    )
