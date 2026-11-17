from datetime import datetime, timedelta, timezone
import io
import json
import urllib.error

import pytest

from sentiment_monitor.gemini import (
    DemoGemini,
    GeminiError,
    GeminiResult,
    ScriptedGemini,
    acquire_gemini_slot,
    create_gemini,
    format_gemini_pause,
    parse_gemini_error_body,
    record_gemini_pause,
)


def test_create_gemini_defaults_to_demo_and_requires_explicit_live_mode():
    assert isinstance(create_gemini({"CARI_AI_PROVIDER": "demo"}), DemoGemini)
    with pytest.raises(GeminiError, match="missing_key"):
        create_gemini({"CARI_AI_PROVIDER": "gemini"})


def test_scripted_gemini_returns_prewritten_json_and_cost():
    client = ScriptedGemini([
        GeminiResult(data={"ok": True}, model="scripted", input_tokens=10, output_tokens=5, cost_usd=0.01)
    ])
    result = client.generate_json(system="s", user="u", schema={}, purpose="summary")
    assert result.data == {"ok": True}
    assert result.cost_usd == 0.01


def test_429_body_parses_retry_delay_and_daily_kind():
    parsed = parse_gemini_error_body({
        "error": {
            "message": "Quota exceeded",
            "details": [{
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                "retryDelay": "42s",
            }, {
                "violations": [{
                    "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                    "quotaMetric": "generate_requests",
                    "quotaValue": "50",
                }],
            }],
        },
    })
    assert parsed.retry_after_ms == 42000
    assert parsed.per_day is True
    assert parsed.limit == "50"


def test_pause_text_uses_jakarta_and_adds_the_date_on_another_day():
    now = datetime(2026, 11, 17, 2, 0, tzinfo=timezone.utc)
    same_day = datetime(2026, 11, 17, 7, 30, tzinfo=timezone.utc)
    next_day = datetime(2026, 11, 17, 18, 5, tzinfo=timezone.utc)
    assert format_gemini_pause(same_day, now) == "Kuota Gemini habis, lanjut otomatis pukul 14:30 WIB"
    assert format_gemini_pause(next_day, now) == "Kuota Gemini habis, lanjut otomatis pukul 01:05 WIB, 18 Nov"


def test_gemini_http_error_keeps_the_body_out_of_the_exception():
    secret = "prompt-echo-do-not-store"

    def opener(request, timeout):
        del timeout
        assert request.get_header("X-goog-api-key") == "synthetic-key"
        assert "synthetic-key" not in request.full_url
        raise urllib.error.HTTPError(
            request.full_url,
            429,
            "Too Many Requests",
            hdrs=None,
            fp=io.BytesIO(json.dumps({
                "error": {"message": secret, "details": [{"retryDelay": "5s"}]},
            }).encode()),
        )

    client = create_gemini(
        {"CARI_AI_PROVIDER": "gemini", "GEMINI_API_KEY": "synthetic-key"},
    )
    client.opener = opener
    with pytest.raises(GeminiError, match="http_429") as caught:
        client.generate_json(system="s", user=secret, schema={}, purpose="summary")
    assert secret not in str(caught.value)
    assert caught.value.retry_after_ms == 5000
    assert caught.value.counts_as_attempt is True


def test_gemini_cost_includes_thought_tokens():
    class Response:
        status = 200

        def read(self, _limit):
            return json.dumps({
                "candidates": [{"content": {"parts": [{"text": "{\"ok\": true}"}]}}],
                "usageMetadata": {
                    "promptTokenCount": 1000,
                    "candidatesTokenCount": 100,
                    "thoughtsTokenCount": 50,
                },
            }).encode()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    client = create_gemini({
        "CARI_AI_PROVIDER": "gemini",
        "GEMINI_API_KEY": "synthetic-key",
        "GEMINI_INPUT_USD_PER_MTOK": "0.30",
        "GEMINI_OUTPUT_USD_PER_MTOK": "2.50",
    })
    client.opener = lambda request, timeout: Response()
    result = client.generate_json(system="s", user="u", schema={}, purpose="summary")
    assert result.data == {"ok": True}
    assert result.input_tokens == 1000
    assert result.output_tokens == 150
    assert result.cost_usd == pytest.approx(0.000675)


def test_acquire_honors_a_pause_and_a_later_pause_replaces_an_earlier_one(db):
    now = datetime.now(timezone.utc)
    record_gemini_pause(db, now + timedelta(minutes=30), kind="retry")
    with pytest.raises(GeminiError, match="paused"):
        acquire_gemini_slot(db, now, 10, sleep=lambda _seconds: None)
    record_gemini_pause(db, now + timedelta(minutes=5), kind="retry")
    row = db.execute("select paused_until from gemini_gate where id = 1")[0]
    assert row["paused_until"] > now + timedelta(minutes=20)
    record_gemini_pause(db, now + timedelta(hours=2), kind="per_day")
    row = db.execute("select pause_kind from gemini_gate where id = 1")[0]
    assert row["pause_kind"] == "per_day"


def test_acquire_caps_the_spacing_sleep_at_sixty_seconds(db):
    now = datetime.now(timezone.utc)
    db.execute("delete from gemini_gate")
    db.execute(
        "insert into gemini_gate (id, last_request_at) values (1, %s)",
        (now,),
    )
    slept = []
    acquire_gemini_slot(db, now, 10, sleep=slept.append)
    assert slept == [pytest.approx(6.0)]
    slept.clear()
    db.execute("update gemini_gate set last_request_at = %s where id = 1", (now,))
    acquire_gemini_slot(db, now, 1, sleep=slept.append)
    assert slept == [pytest.approx(60.0)]


def test_question_request_matches_the_summary_envelope():
    from sentiment_monitor.gemini import build_generation_body
    from sentiment_monitor.instant_ai import (
        QUESTION_MAX_OUTPUT_TOKENS,
        QUESTION_SCHEMA,
        SUMMARY_MAX_OUTPUT_TOKENS,
        SUMMARY_SCHEMA,
    )

    question = build_generation_body(
        system="sistem",
        user="tanya",
        schema=QUESTION_SCHEMA,
        max_output_tokens=QUESTION_MAX_OUTPUT_TOKENS,
    )
    summary = build_generation_body(
        system="sistem",
        user="ringkas",
        schema=SUMMARY_SCHEMA,
        max_output_tokens=SUMMARY_MAX_OUTPUT_TOKENS,
    )
    assert set(question) == set(summary) == {"systemInstruction", "contents", "generationConfig"}
    assert question["systemInstruction"] == {"parts": [{"text": "sistem"}]}
    assert question["contents"] == [{"role": "user", "parts": [{"text": "tanya"}]}]
    assert set(question["generationConfig"]) == set(summary["generationConfig"]) == {
        "responseMimeType",
        "responseSchema",
        "maxOutputTokens",
    }
    assert question["generationConfig"]["responseMimeType"] == "application/json"
    assert question["generationConfig"]["maxOutputTokens"] == 2048
    assert summary["generationConfig"]["maxOutputTokens"] == 4096

    schema_keys = {
        "type",
        "properties",
        "items",
        "required",
        "enum",
        "propertyOrdering",
        "description",
        "format",
        "nullable",
    }

    def keywords(node, found=None):
        found = set() if found is None else found
        if isinstance(node, dict):
            for key, value in node.items():
                if key in schema_keys:
                    found.add(key)
                if key == "properties" and isinstance(value, dict):
                    for child in value.values():
                        keywords(child, found)
                elif key == "items":
                    keywords(value, found)
        return found

    question_schema = question["generationConfig"]["responseSchema"]
    summary_schema = summary["generationConfig"]["responseSchema"]
    assert keywords(question_schema) <= keywords(summary_schema)
    encoded = json.dumps(question_schema)
    for banned in ("additionalProperties", "$ref", '"const"', "anyOf", "oneOf"):
        assert banned not in encoded
    assert question_schema["propertyOrdering"] == ["answer", "citations"]
    assert question_schema["properties"]["citations"]["items"]["type"] == "string"
