"""OpenCode Go chat-completions client for Cari summary and Q&A.

The prompts and the JSON contract stay the same as the Gemini call. This
transport only changes the HTTP shape. reasoning_content is never returned
or logged. The API key is never logged.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import json
import logging
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping

from sentiment_monitor.gemini import (
    GeminiError,
    GeminiErrorInfo,
    GeminiResult,
    _pause_delay_ms,
    _run_short,
    _take_cycle_slot,
    acquire_gemini_slot,
    record_gemini_pause,
)
from sentiment_monitor.providers.http import urlopen as safe_urlopen

_log = logging.getLogger("sentiment_monitor.opencode")

OPENCODE_URL = "https://opencode.ai/inference/go/v1/chat/completions"
OPENCODE_DEFAULT_MODEL = "deepseek-v4.1-flash"
OPENCODE_USER_AGENT = "elvsentiment-worker/1.0"
OPENCODE_TIMEOUT_SECONDS = 90
OPENCODE_DEFAULT_MAX_RPM = 10
_MESSAGE_CHARS = 500
_MODEL_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_SESSION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_FENCE_START = re.compile(r"^```(?:json)?\s*", re.IGNORECASE)
_FENCE_END = re.compile(r"\s*```$")
_QUOTA_TEXT = re.compile(
    r"usage[ _-]?limit|rate[ _-]?limit|insufficient[ _-]?quota",
    re.IGNORECASE,
)


def _model_name(env: Mapping[str, Any]) -> str:
    raw = env.get("OPENCODE_MODEL")
    if isinstance(raw, str) and _MODEL_PATTERN.fullmatch(raw.strip()):
        return raw.strip()
    return OPENCODE_DEFAULT_MODEL


def _max_rpm(env: Mapping[str, Any]) -> int:
    raw = env.get("OPENCODE_MAX_RPM")
    if not isinstance(raw, str) or not raw.strip():
        return OPENCODE_DEFAULT_MAX_RPM
    try:
        value = int(raw)
    except ValueError:
        return OPENCODE_DEFAULT_MAX_RPM
    return value if value > 0 else OPENCODE_DEFAULT_MAX_RPM


def _session_header(search_id: str | None) -> str:
    if isinstance(search_id, str) and _SESSION_ID.fullmatch(search_id):
        return f"elv-{search_id}"
    return "elv-none"


def _log_token(value: object, fallback: str) -> str:
    if isinstance(value, str) and _MODEL_PATTERN.fullmatch(value):
        return value
    return fallback


def _redact(text: str, api_key: str) -> str:
    if api_key:
        text = text.replace(api_key, "[redacted]")
    text = re.sub(r"Bearer\s+\S+", "Bearer [redacted]", text, flags=re.IGNORECASE)
    return text


def _system_with_schema(system: str, schema: Mapping[str, Any]) -> str:
    """Same system text, plus the JSON schema Gemini sends out of band."""
    encoded = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
    return (
        f"{system}\n\n"
        "Balas hanya dengan satu objek JSON yang valid, tanpa markdown, sesuai skema ini:\n"
        f"{encoded}"
    )


def _message_text(message: Mapping[str, Any]) -> str:
    """Visible assistant text. reasoning_content is intentionally unread."""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "".join(parts)
    return ""


def _load_object(text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _load_first_object(text: str) -> dict[str, Any] | None:
    """The first balanced object. A decoy '{' before the JSON must not win."""
    decoder = json.JSONDecoder()
    start = text.find("{")
    while start >= 0:
        try:
            parsed, _end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            start = text.find("{", start + 1)
            continue
        if isinstance(parsed, dict):
            return parsed
        start = text.find("{", start + 1)
    return None


def _parse_json_content(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = _FENCE_START.sub("", cleaned)
    cleaned = _FENCE_END.sub("", cleaned).strip()
    parsed = _load_object(cleaned)
    if parsed is None:
        parsed = _load_first_object(cleaned)
    if parsed is None:
        raise GeminiError("malformed_json")
    return parsed


def _finish_reason(payload: Mapping[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return "-"
    reason = choices[0].get("finish_reason")
    if isinstance(reason, str) and _MODEL_PATTERN.fullmatch(reason):
        return reason
    return "-"


def _retry_after_ms(headers: Any) -> int | None:
    if headers is None or not hasattr(headers, "get"):
        return None
    raw = headers.get("Retry-After")
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip()
    if text.isdigit():
        return int(text) * 1000
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0, int((when - datetime.now(timezone.utc)).total_seconds() * 1000))


def _error_message(raw: bytes) -> str:
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        text = raw.decode("utf-8", errors="replace")
        return " ".join(text.split())
    if not isinstance(parsed, dict):
        return ""
    error = parsed.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        code = error.get("code") or error.get("type")
        parts = [part for part in (code, message) if isinstance(part, str)]
        return " ".join(" ".join(part.split()) for part in parts)
    if isinstance(error, str):
        return " ".join(error.split())
    return ""


def _is_quota(status: int, message: str) -> bool:
    if status == 429:
        return True
    return _QUOTA_TEXT.search(message or "") is not None


class OpenCodeClient:
    def __init__(
        self,
        api_key: str,
        *,
        model: str,
        env: Mapping[str, Any],
        connect: Any = None,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.model = model
        self.env = env
        self.connect = connect
        self.opener = safe_urlopen if opener is None else opener
        self.max_rpm = _max_rpm(env)
        self._api_key = api_key

    def generate_json(
        self,
        *,
        system: str,
        user: str,
        schema: Mapping[str, Any],
        purpose: str,
        search_id: str | None = None,
        max_output_tokens: int = 4096,
    ) -> GeminiResult:
        if self.connect is not None:
            _run_short(self.connect, lambda conn: acquire_gemini_slot(
                conn, datetime.now(timezone.utc), self.max_rpm
            ))
        if not _take_cycle_slot():
            _log.info(
                "opencode_cycle_cap purpose=%s search=%s",
                _log_token(purpose, "other"),
                _log_token(search_id, "-"),
            )
            raise GeminiError("cycle_cap", counts_as_attempt=False)
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _system_with_schema(system, schema)},
                {"role": "user", "content": user},
            ],
            "response_format": {"type": "json_object"},
            "max_tokens": max_output_tokens,
            # DeepSeek V4 thinks by default, and those tokens share max_tokens.
            # On this Go gateway a long trace either comes back as empty content
            # (finish_reason=length) or holds the socket past the timeout.
            # "none" keeps the JSON in content. reasoning_content is still unread.
            "reasoning_effort": "none",
        }
        request = urllib.request.Request(
            OPENCODE_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
                "User-Agent": OPENCODE_USER_AGENT,
                "x-opencode-session": _session_header(search_id),
            },
            method="POST",
        )
        try:
            with self.opener(request, timeout=OPENCODE_TIMEOUT_SECONDS) as response:
                status = int(getattr(response, "status", 200) or 200)
                raw = response.read(2_000_001)
                response_headers = getattr(response, "headers", None)
        except TimeoutError:
            self._log_status("timeout", "timeout")
            raise GeminiError("timeout", counts_as_attempt=True) from None
        except urllib.error.HTTPError as error:
            self._raise_http(error)
        except urllib.error.URLError as error:
            reason = getattr(error, "reason", None)
            if isinstance(reason, TimeoutError):
                self._log_status("timeout", "timeout")
                raise GeminiError("timeout", counts_as_attempt=True) from None
            self._log_status("transport", "transport_error")
            raise GeminiError("transport_error") from None
        except GeminiError:
            raise
        except Exception:
            self._log_status("transport", "transport_error")
            raise GeminiError("transport_error") from None
        if status >= 400:
            self._raise_status(status, raw[:65_536], response_headers)
        return self._success(raw, purpose, search_id)

    def _raise_http(self, error: Any) -> None:
        raw = b""
        try:
            raw = error.read(65_536)
        except Exception:
            raw = b""
        self._raise_status(int(error.code), raw, getattr(error, "headers", None))

    def _raise_status(self, status: int, raw: bytes, headers: Any) -> None:
        message = _error_message(raw)
        safe = _redact(message, self._api_key)[:_MESSAGE_CHARS]
        self._log_status(status, safe)
        if status in (401, 403):
            raise GeminiError("config_error", counts_as_attempt=False)
        if _is_quota(status, message):
            self._record_pause(_retry_after_ms(headers))
            raise GeminiError("http_429", counts_as_attempt=True)
        if status in (503, 504):
            raise GeminiError(f"http_{status}", counts_as_attempt=True)
        if status >= 500:
            raise GeminiError("http_5xx", counts_as_attempt=True)
        raise GeminiError("http_4xx", counts_as_attempt=False)

    def _log_status(self, status: object, message: str) -> None:
        safe_status = status if isinstance(status, int) else _log_token(str(status), "error")
        _log.info(
            "opencode_http status=%s model=%s message=%s",
            safe_status,
            _log_token(self.model, "unknown"),
            message or "-",
        )

    def _log_parse(self, payload: Mapping[str, Any], text: str, purpose: str, search_id: str | None) -> None:
        """Shape only. The body and reasoning_content are not logged."""
        _log.info(
            "opencode_parse purpose=%s search=%s finish=%s content_chars=%s fence=%s blank=%s",
            _log_token(purpose, "other"),
            _log_token(search_id, "-"),
            _finish_reason(payload),
            len(text),
            1 if "```" in text else 0,
            1 if not text.strip() else 0,
        )

    def _record_pause(self, retry_after_ms: int | None) -> None:
        if self.connect is None:
            return
        delay_ms = _pause_delay_ms(GeminiErrorInfo(retry_after_ms, False, None, None, None))
        until = datetime.now(timezone.utc) + timedelta(milliseconds=delay_ms)
        try:
            _run_short(
                self.connect,
                lambda conn: record_gemini_pause(conn, until, kind="retry"),
            )
        except Exception:
            return

    def _success(self, raw: bytes, purpose: str, search_id: str | None) -> GeminiResult:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise GeminiError("malformed_json") from None
        if not isinstance(payload, dict):
            raise GeminiError("malformed_json")
        choices = payload.get("choices")
        message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        if not isinstance(message, dict):
            self._log_parse(payload, "", purpose, search_id)
            raise GeminiError("malformed_json")
        text = _message_text(message)
        try:
            parsed = _parse_json_content(text)
        except GeminiError:
            self._log_parse(payload, text, purpose, search_id)
            raise
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        prompt = int(usage.get("prompt_tokens") or 0)
        output = int(usage.get("completion_tokens") or 0)
        reported = payload.get("model")
        model = reported if isinstance(reported, str) and _MODEL_PATTERN.fullmatch(reported) else self.model
        _log.info(
            "opencode_ok purpose=%s search=%s model=%s input_tokens=%s output_tokens=%s",
            _log_token(purpose, "other"),
            _log_token(search_id, "-"),
            _log_token(model, "unknown"),
            prompt,
            output,
        )
        return GeminiResult(parsed, model, prompt, output, 0.0)


def create_opencode(
    env: Mapping[str, Any],
    conn: Any = None,
    opener: Callable[..., Any] | None = None,
) -> OpenCodeClient:
    key = env.get("OPENCODE_API_KEY") if isinstance(env, Mapping) else None
    if not isinstance(key, str) or not key.strip():
        raise GeminiError("missing_key")
    return OpenCodeClient(
        key.strip(),
        model=_model_name(env),
        env=env,
        connect=conn,
        opener=opener,
    )
