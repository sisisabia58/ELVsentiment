"""Gemini JSON transport, quota gate, and offline fakes.

Exceptions and this module's control flow keep only a short safe code.
Prompts, response bodies, and API keys are never stored on the exception
or written to a log.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping

from sentiment_monitor.providers.http import urlopen as safe_urlopen

GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite"
GEMINI_DEFAULT_MAX_RPM = 10
GEMINI_DEFAULT_INPUT_USD_PER_MTOK = 0.30
GEMINI_DEFAULT_OUTPUT_USD_PER_MTOK = 2.50
GEMINI_TIMEOUT_SECONDS = 20
MAX_RESPONSE_BYTES = 2_000_000
MAX_ERROR_BYTES = 65_536
_MODEL_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_RETRY_DELAY = re.compile(r"^(\d+(?:\.\d+)?)s$")
_JAKARTA = timezone(timedelta(hours=7))
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des")
_SAFE_CODE = re.compile(r"^[a-z0-9_]{1,40}$")

_DEMO_SUMMARY: dict[str, Any] = {
    "overall_summary": "Percakapan ini tercatat dari hasil pencarian.",
    "overall_stance": "campuran",
    "platforms": [],
    "quotes": [],
    "themes": [],
}


class GeminiError(Exception):
    def __init__(
        self,
        code: str,
        *,
        retry_after_ms: int | None = None,
        per_day: bool = False,
        counts_as_attempt: bool = False,
        quota_id: str | None = None,
        quota_metric: str | None = None,
        limit: str | None = None,
    ) -> None:
        safe = code if _SAFE_CODE.fullmatch(code) else "other"
        super().__init__(safe)
        self.code = safe
        self.retry_after_ms = retry_after_ms
        self.per_day = per_day
        self.counts_as_attempt = counts_as_attempt
        self.quota_id = quota_id
        self.quota_metric = quota_metric
        self.limit = limit


@dataclass(frozen=True)
class GeminiErrorInfo:
    retry_after_ms: int | None
    per_day: bool
    limit: str | None
    quota_id: str | None
    quota_metric: str | None


@dataclass(frozen=True)
class GeminiResult:
    data: dict[str, Any]
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _row_value(row: Any, key: str, index: int) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    try:
        return row[index]
    except (TypeError, KeyError, IndexError):
        return getattr(row, key, None)


def _rate(env: Mapping[str, Any], name: str, default: float) -> float:
    raw = env.get(name)
    if not isinstance(raw, str) or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if value < 0:
        return default
    return value


def _model_name(env: Mapping[str, Any]) -> str:
    raw = env.get("GEMINI_MODEL")
    if isinstance(raw, str) and _MODEL_PATTERN.fullmatch(raw.strip()):
        return raw.strip()
    return GEMINI_DEFAULT_MODEL


def _max_rpm(env: Mapping[str, Any]) -> int:
    raw = env.get("GEMINI_MAX_RPM")
    if not isinstance(raw, str) or not raw.strip():
        return GEMINI_DEFAULT_MAX_RPM
    try:
        value = int(raw)
    except ValueError:
        return GEMINI_DEFAULT_MAX_RPM
    return value if value > 0 else GEMINI_DEFAULT_MAX_RPM


def parse_gemini_error_body(payload: Any) -> GeminiErrorInfo:
    error = payload.get("error") if isinstance(payload, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    retry_after_ms = None
    per_day = False
    limit = None
    quota_id = None
    quota_metric = None
    if isinstance(details, list):
        for item in details:
            if not isinstance(item, dict):
                continue
            delay = item.get("retryDelay")
            if isinstance(delay, str) and retry_after_ms is None:
                match = _RETRY_DELAY.fullmatch(delay.strip())
                if match:
                    retry_after_ms = int(float(match.group(1)) * 1000)
            violations = item.get("violations")
            if not isinstance(violations, list):
                continue
            for violation in violations:
                if not isinstance(violation, dict):
                    continue
                found_id = violation.get("quotaId")
                if not isinstance(found_id, str) or not found_id:
                    continue
                quota_id = found_id
                metric = violation.get("quotaMetric")
                quota_metric = metric if isinstance(metric, str) else None
                value = violation.get("quotaValue")
                limit = str(value) if value is not None else None
                per_day = "perday" in found_id.lower()
                break
    return GeminiErrorInfo(retry_after_ms, per_day, limit, quota_id, quota_metric)


def format_gemini_pause(until: datetime, now: datetime) -> str:
    local = _aware(until).astimezone(_JAKARTA)
    clock = local.strftime("%H:%M")
    text = f"Kuota Gemini habis, lanjut otomatis pukul {clock} WIB"
    if local.date() == _aware(now).astimezone(_JAKARTA).date():
        return text
    return f"{text}, {local.day} {_MONTHS[local.month - 1]}"


def acquire_gemini_slot(
    conn: Any,
    now: datetime,
    max_rpm: int,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    rpm = max(1, int(max_rpm))
    interval = min(60.0, 60_000 / rpm / 1000.0)
    now = _aware(now)
    conn.execute("insert into gemini_gate (id) values (1) on conflict (id) do nothing")
    rows = conn.execute(
        "select paused_until, last_request_at from gemini_gate where id = 1 for update"
    ) or []
    if not rows:
        return
    paused = _aware_or_none(_row_value(rows[0], "paused_until", 0))
    if paused is not None and paused > now:
        raise GeminiError(
            "paused",
            retry_after_ms=max(0, int((paused - now).total_seconds() * 1000)),
            counts_as_attempt=False,
        )
    last = _aware_or_none(_row_value(rows[0], "last_request_at", 1))
    wait = 0.0
    if last is not None:
        wait = min(60.0, max(0.0, interval - (now - last).total_seconds()))
    if wait > 0:
        sleep(wait)
    conn.execute(
        "update gemini_gate set last_request_at = %s where id = 1",
        (datetime.now(timezone.utc),),
    )


def _aware_or_none(value: Any) -> datetime | None:
    if not isinstance(value, datetime):
        return None
    return _aware(value)


def record_gemini_pause(
    conn: Any,
    until: datetime,
    *,
    kind: str | None = None,
    quota_metric: str | None = None,
    quota_id: str | None = None,
    quota_limit: str | None = None,
) -> None:
    conn.execute(
        """
        insert into gemini_gate
          (id, paused_until, pause_kind, quota_metric, quota_id, quota_limit)
        values (1, %s, %s, %s, %s, %s)
        on conflict (id) do update
        set paused_until = excluded.paused_until,
            pause_kind = excluded.pause_kind,
            quota_metric = excluded.quota_metric,
            quota_id = excluded.quota_id,
            quota_limit = excluded.quota_limit
        where gemini_gate.paused_until is null
           or gemini_gate.paused_until < excluded.paused_until
        """,
        (until, kind, quota_metric, quota_id, quota_limit),
    )


def _usage_cost(payload: Mapping[str, Any], env: Mapping[str, Any]) -> tuple[int, int, float]:
    usage = payload.get("usageMetadata") if isinstance(payload, Mapping) else None
    if not isinstance(usage, Mapping):
        usage = {}
    prompt = int(usage.get("promptTokenCount") or 0)
    output = int(usage.get("candidatesTokenCount") or 0) + int(usage.get("thoughtsTokenCount") or 0)
    cost = (
        prompt * _rate(env, "GEMINI_INPUT_USD_PER_MTOK", GEMINI_DEFAULT_INPUT_USD_PER_MTOK)
        + output * _rate(env, "GEMINI_OUTPUT_USD_PER_MTOK", GEMINI_DEFAULT_OUTPUT_USD_PER_MTOK)
    ) / 1_000_000
    return prompt, output, cost


def _response_json(payload: Mapping[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise GeminiError("malformed_json")
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts or not isinstance(parts[0], dict):
        raise GeminiError("malformed_json")
    text = parts[0].get("text")
    if not isinstance(text, str):
        raise GeminiError("malformed_json")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise GeminiError("malformed_json") from None
    if not isinstance(parsed, dict):
        raise GeminiError("malformed_json")
    return parsed


def _with_property_ordering(schema: Mapping[str, Any]) -> dict[str, Any]:
    """Gemini's responseSchema accepts an object once its properties are ordered.

    The live model documents propertyOrdering as the field that makes this
    OpenAPI subset valid. Summary and questions share this builder so the
    question body cannot drift into a shape the summary call does not use.
    """
    copied: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "properties" and isinstance(value, Mapping):
            ordered: dict[str, Any] = {}
            for name, child in value.items():
                ordered[str(name)] = _with_property_ordering(child) if isinstance(child, Mapping) else child
            copied["properties"] = ordered
            copied["propertyOrdering"] = list(ordered)
        elif key == "items" and isinstance(value, Mapping):
            copied["items"] = _with_property_ordering(value)
        else:
            copied[key] = value
    return copied


def build_generation_body(
    *,
    system: str,
    user: str,
    schema: Mapping[str, Any],
    max_output_tokens: int,
) -> dict[str, Any]:
    return {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": _with_property_ordering(schema),
            "maxOutputTokens": max_output_tokens,
        },
    }


class GeminiClient:
    def __init__(
        self,
        api_key: str,
        *,
        model: str,
        env: Mapping[str, Any],
        connect: Any = None,
        opener: Callable[..., Any] = safe_urlopen,
    ) -> None:
        self.model = model
        self.env = env
        self.connect = connect
        self.opener = opener
        self.max_rpm = _max_rpm(env)
        self._api_key = api_key

    def generate_json(
        self,
        *,
        system: str,
        user: str,
        schema: Mapping[str, Any],
        purpose: str,
        max_output_tokens: int = 4096,
    ) -> GeminiResult:
        del purpose
        if self.connect is not None:
            _run_short(self.connect, lambda conn: acquire_gemini_slot(
                conn, datetime.now(timezone.utc), self.max_rpm
            ))
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        body = json.dumps(
            build_generation_body(
                system=system,
                user=user,
                schema=schema,
                max_output_tokens=max_output_tokens,
            )
        ).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={"content-type": "application/json", "x-goog-api-key": self._api_key},
            method="POST",
        )
        try:
            with self.opener(request, timeout=GEMINI_TIMEOUT_SECONDS) as response:
                status = int(getattr(response, "status", 200) or 200)
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except TimeoutError as error:
            raise GeminiError("timeout", counts_as_attempt=True) from error
        except urllib.error.HTTPError as error:
            raw = b""
            try:
                raw = error.read(MAX_ERROR_BYTES)
            except Exception:
                raw = b""
            self._raise_http(int(error.code), raw)
        except GeminiError:
            raise
        except Exception as error:
            raise GeminiError("transport_error") from error
        if status in (429, 503, 504):
            self._raise_http(status, raw[:MAX_ERROR_BYTES])
        if status >= 500:
            raise GeminiError("http_5xx", counts_as_attempt=True)
        if status >= 400:
            raise GeminiError("http_4xx")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GeminiError("malformed_json") from None
        if not isinstance(payload, dict):
            raise GeminiError("malformed_json")
        prompt, output, cost = _usage_cost(payload, self.env)
        return GeminiResult(_response_json(payload), self.model, prompt, output, cost)

    def _raise_http(self, status: int, raw: bytes) -> None:
        info = GeminiErrorInfo(None, False, None, None, None)
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
            if isinstance(parsed, dict):
                info = parse_gemini_error_body(parsed)
        except (UnicodeDecodeError, json.JSONDecodeError):
            info = GeminiErrorInfo(None, False, None, None, None)
        if info.retry_after_ms is not None or info.per_day:
            self._record_pause(info)
        if status in (429, 503, 504):
            code = f"http_{status}"
            attempt = True
        elif status >= 500:
            code = "http_5xx"
            attempt = True
        else:
            code = "http_4xx"
            attempt = False
        raise GeminiError(
            code,
            retry_after_ms=info.retry_after_ms,
            per_day=info.per_day,
            counts_as_attempt=attempt,
            quota_id=info.quota_id,
            quota_metric=info.quota_metric,
            limit=info.limit,
        )

    def _record_pause(self, info: GeminiErrorInfo) -> None:
        if self.connect is None:
            return
        delay_ms = info.retry_after_ms if info.retry_after_ms is not None else 3_600_000
        until = datetime.now(timezone.utc) + timedelta(milliseconds=delay_ms)
        try:
            _run_short(
                self.connect,
                lambda conn: record_gemini_pause(
                    conn,
                    until,
                    kind="per_day" if info.per_day else "retry",
                    quota_metric=info.quota_metric,
                    quota_id=info.quota_id,
                    quota_limit=info.limit,
                ),
            )
        except Exception:
            return


class DemoGemini:
    model = "demo"

    def generate_json(self, **kwargs: Any) -> GeminiResult:
        if kwargs.get("purpose") == "question":
            user = kwargs.get("user") if isinstance(kwargs.get("user"), str) else ""
            citations: list[str] = []
            for match in re.finditer(r'"(?:id)":"((?:result|comment):[^"]+)"', user):
                ref = match.group(1)
                if ref not in citations:
                    citations.append(ref)
                if len(citations) == 3:
                    break
            return GeminiResult(
                {
                    "answer": "Dari hasil yang tersimpan, ini yang paling sering disebut.",
                    "citations": citations,
                },
                "demo",
                0,
                0,
                0.0,
            )
        return GeminiResult(json.loads(json.dumps(_DEMO_SUMMARY)), "demo", 0, 0, 0.0)


class ScriptedGemini:
    def __init__(self, results: list[GeminiResult]) -> None:
        self._results = list(results)

    def generate_json(self, **kwargs: Any) -> GeminiResult:
        del kwargs
        if not self._results:
            raise GeminiError("script_exhausted")
        return self._results.pop(0)


def _run_short(connect: Any, fn: Callable[[Any], Any]) -> Any:
    if callable(connect) and not hasattr(connect, "execute"):
        conn = connect()
        try:
            result = fn(conn)
            commit = getattr(conn, "commit", None)
            if callable(commit):
                commit()
            return result
        except BaseException:
            rollback = getattr(conn, "rollback", None)
            if callable(rollback):
                try:
                    rollback()
                except Exception:
                    pass
            raise
        finally:
            close = getattr(conn, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
    result = fn(connect)
    commit = getattr(connect, "commit", None)
    if callable(commit):
        commit()
    return result


def create_gemini(env: Mapping[str, Any], conn: Any = None) -> Any:
    raw = env.get("CARI_AI_PROVIDER") if isinstance(env, Mapping) else None
    provider = raw.strip().lower() if isinstance(raw, str) and raw.strip() else "demo"
    if provider == "demo":
        return DemoGemini()
    if provider != "gemini":
        raise GeminiError("unsupported_provider")
    key = env.get("GEMINI_API_KEY") if isinstance(env, Mapping) else None
    if not isinstance(key, str) or not key.strip():
        raise GeminiError("missing_key")
    return GeminiClient(key.strip(), model=_model_name(env), env=env, connect=conn)
