from datetime import datetime, timedelta, timezone
import io
import json
import logging
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
    reset_gemini_budget,
)


@pytest.fixture(autouse=True)
def _fresh_gemini_budget():
    reset_gemini_budget()
    yield
    reset_gemini_budget()


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


def test_acquire_honors_a_daily_pause_and_clears_one_already_past(db):
    now = datetime.now(timezone.utc)
    record_gemini_pause(db, now + timedelta(seconds=30), kind="retry")
    with pytest.raises(GeminiError, match="paused"):
        acquire_gemini_slot(db, now, 10, sleep=lambda _seconds: None)
    record_gemini_pause(db, now + timedelta(seconds=27403), kind="per_day")
    with pytest.raises(GeminiError, match="paused") as caught:
        acquire_gemini_slot(db, now + timedelta(seconds=120), 10, sleep=lambda _seconds: None)
    assert caught.value.retry_after_ms > 27_000_000
    db.execute(
        "update gemini_gate set paused_until = %s where id = 1",
        (now - timedelta(seconds=5),),
    )
    acquire_gemini_slot(db, now, 10, sleep=lambda _seconds: None)
    row = db.execute("select paused_until, pause_kind from gemini_gate where id = 1")[0]
    assert row["paused_until"] is None
    assert row["pause_kind"] is None


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


class _Gate:
    def __init__(self):
        self.statements: list[tuple[str, object]] = []

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        if "select paused_until" in sql:
            return [{"paused_until": None, "last_request_at": None}]
        return []

    def commit(self):
        return None


def _reject(status: int, body: dict):
    def opener(request, timeout):
        del timeout
        raise urllib.error.HTTPError(
            request.full_url,
            status,
            "error",
            hdrs=None,
            fp=io.BytesIO(json.dumps(body).encode()),
        )

    return opener


def test_invalid_argument_is_logged_and_does_not_pause(caplog):
    gate = _Gate()
    client = create_gemini(
        {"CARI_AI_PROVIDER": "gemini", "GEMINI_API_KEY": "synthetic-key"},
        gate,
    )
    message = "Invalid JSON payload received. " + ("x" * 800)
    client.opener = _reject(400, {
        "error": {
            "status": "INVALID_ARGUMENT",
            "message": message,
            "details": [{"retryDelay": "30s"}],
        },
    })
    with caplog.at_level(logging.INFO, logger="sentiment_monitor.gemini"):
        with pytest.raises(GeminiError, match="http_4xx"):
            client.generate_json(
                system="s", user="u", schema={"type": "object", "properties": {}}, purpose="question",
            )
    assert "status=400" in caplog.text
    assert "error_status=INVALID_ARGUMENT" in caplog.text
    assert "Invalid JSON payload received." in caplog.text
    assert "retryDelay=30s" in caplog.text
    assert "x" * 600 not in caplog.text
    assert not any("paused_until" in sql and sql.strip().startswith("insert") for sql, _params in gate.statements)


def test_resource_exhausted_pauses_until_the_retry_delay(caplog):
    gate = _Gate()
    client = create_gemini(
        {"CARI_AI_PROVIDER": "gemini", "GEMINI_API_KEY": "synthetic-key"},
        gate,
    )
    client.opener = _reject(429, {
        "error": {
            "status": "RESOURCE_EXHAUSTED",
            "message": "You exceeded your current quota for synthetic-key. " + ("y" * 400),
            "details": [
                {"retryDelay": "36s"},
                {"violations": [
                    {
                        "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                        "quotaMetric": "generate_content_free_tier_requests",
                        "quotaValue": "20",
                    },
                    {
                        "quotaId": "GenerateContentInputTokensPerModelPerMinute-FreeTier",
                        "quotaMetric": "generate_content_free_tier_input_token_count",
                        "quotaValue": "1000000",
                    },
                ]},
            ],
        },
    })
    before = datetime.now(timezone.utc)
    with caplog.at_level(logging.INFO, logger="sentiment_monitor.gemini"):
        with pytest.raises(GeminiError, match="http_429") as caught:
            client.generate_json(
                system="s", user="u", schema={"type": "object", "properties": {}}, purpose="question",
            )
    assert caught.value.code == "http_429"
    inserts = [
        params for sql, params in gate.statements
        if "paused_until" in sql and sql.strip().startswith("insert")
    ]
    assert len(inserts) == 1
    until = inserts[0][0]
    assert before + timedelta(seconds=35) <= until <= before + timedelta(seconds=40)
    assert "status=429" in caplog.text
    assert "model=gemini-3.5-flash-lite" in caplog.text
    assert "error_status=RESOURCE_EXHAUSTED" in caplog.text
    assert "retryDelay=36s" in caplog.text
    assert "metric=generate_content_free_tier_requests id=GenerateRequestsPerDayPerProjectPerModel-FreeTier value=20" in caplog.text
    assert "metric=generate_content_free_tier_input_token_count id=GenerateContentInputTokensPerModelPerMinute-FreeTier value=1000000" in caplog.text
    assert "synthetic-key" not in caplog.text


def test_question_request_matches_the_summary_envelope():
    from sentiment_monitor.gemini import build_generate_content_request, build_generation_body
    from sentiment_monitor.instant_ai import (
        QUESTION_MAX_OUTPUT_TOKENS,
        QUESTION_SCHEMA,
        SUMMARY_MAX_OUTPUT_TOKENS,
        SUMMARY_SCHEMA,
        SUMMARY_SYSTEM,
        SummaryInput,
        build_question_prompt,
        build_summary_prompt,
        sample_evidence,
    )

    sample = sample_evidence(
        SummaryInput("search", "kopi", [{"id": "r1", "platform": "threads", "text": "Kopi ini enak"}], [])
    )
    question_system, question_prompt = build_question_prompt(sample, "Apa yang dipuji?")
    summary_system, summary_prompt = build_summary_prompt(sample)
    assert question_system == summary_system == SUMMARY_SYSTEM
    question_request = build_generate_content_request(
        model="gemini-3.5-flash-lite",
        system=question_system,
        user=question_prompt,
        schema=QUESTION_SCHEMA,
        max_output_tokens=QUESTION_MAX_OUTPUT_TOKENS,
    )
    summary_request = build_generate_content_request(
        model="gemini-3.5-flash-lite",
        system=summary_system,
        user=summary_prompt,
        schema=SUMMARY_SCHEMA,
        max_output_tokens=SUMMARY_MAX_OUTPUT_TOKENS,
    )
    assert question_request["url"] == summary_request["url"]
    assert question_request["url"] == (
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
    )
    for request in (question_request, summary_request):
        assert set(request["body"]) == {"systemInstruction", "contents", "generationConfig"}
        assert '"id":"r1"' in request["body"]["contents"][0]["parts"][0]["text"]
        for banned in ("tools", "toolConfig", "cachedContent", "system_instruction"):
            assert banned not in request["body"]
        config = request["body"]["generationConfig"]
        assert "thinkingConfig" not in config
        assert "serviceTier" not in request["body"] and "serviceTier" not in config

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
    assert question["generationConfig"]["responseSchema"]["type"] == summary["generationConfig"]["responseSchema"]["type"] == "object"


def test_daily_retry_delay_is_stored_in_full():
    gate = _Gate()
    client = create_gemini(
        {"CARI_AI_PROVIDER": "gemini", "GEMINI_API_KEY": "synthetic-key"},
        gate,
    )
    client.opener = _reject(429, {
        "error": {
            "status": "RESOURCE_EXHAUSTED",
            "message": "quota",
            "details": [{"retryDelay": "27403s"}],
        },
    })
    before = datetime.now(timezone.utc)
    with pytest.raises(GeminiError, match="http_429"):
        client.generate_json(
            system="s", user="u", schema={"type": "object", "properties": {}}, purpose="summary",
        )
    inserts = [
        params for sql, params in gate.statements
        if "paused_until" in sql and sql.strip().startswith("insert")
    ]
    assert len(inserts) == 1
    until = inserts[0][0]
    assert before + timedelta(seconds=27400) <= until <= before + timedelta(seconds=27410)


def test_quota_without_retry_delay_backs_off_exponentially():
    gate = _Gate()
    client = create_gemini(
        {"CARI_AI_PROVIDER": "gemini", "GEMINI_API_KEY": "synthetic-key"},
        gate,
    )
    client.opener = _reject(429, {
        "error": {"status": "RESOURCE_EXHAUSTED", "message": "quota"},
    })

    def once():
        started = datetime.now(timezone.utc)
        with pytest.raises(GeminiError, match="http_429"):
            client.generate_json(
                system="s", user="u", schema={"type": "object", "properties": {}}, purpose="question",
            )
        return started

    first_started = once()
    second_started = once()
    inserts = [
        params[0] for sql, params in gate.statements
        if "paused_until" in sql and sql.strip().startswith("insert")
    ]
    assert len(inserts) == 2
    assert first_started + timedelta(seconds=29) <= inserts[0] <= first_started + timedelta(seconds=35)
    assert second_started + timedelta(seconds=59) <= inserts[1] <= second_started + timedelta(seconds=70)


class _OkResponse:
    status = 200

    def read(self, _limit):
        return json.dumps({
            "candidates": [{"content": {"parts": [{"text": "{\"ok\": true}"}]}}],
            "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 100, "thoughtsTokenCount": 50},
        }).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_successful_call_logs_purpose_search_and_tokens(caplog):
    client = create_gemini({
        "CARI_AI_PROVIDER": "gemini",
        "GEMINI_API_KEY": "synthetic-key",
    })
    client.opener = lambda request, timeout: _OkResponse()
    search_id = "22222222-2222-4222-8222-222222222222"
    with caplog.at_level(logging.INFO, logger="sentiment_monitor.gemini"):
        client.generate_json(
            system="s", user="u", schema={}, purpose="question", search_id=search_id,
        )
    assert (
        "gemini_ok purpose=question "
        f"search={search_id} model=gemini-3.5-flash-lite input_tokens=1000 output_tokens=150"
    ) in caplog.text
    assert "synthetic-key" not in caplog.text
    assert "user" not in caplog.text.split("gemini_ok", 1)[-1]


def test_generate_json_stops_at_the_cycle_cap(monkeypatch):
    import sentiment_monitor.gemini as gemini_mod

    monkeypatch.setattr(gemini_mod, "GEMINI_CALLS_PER_CYCLE", 2)
    calls = []

    def opener(request, timeout):
        del request, timeout
        calls.append(1)
        return _OkResponse()

    client = create_gemini({
        "CARI_AI_PROVIDER": "gemini",
        "GEMINI_API_KEY": "synthetic-key",
    })
    client.opener = opener
    for _ in range(2):
        client.generate_json(system="s", user="u", schema={}, purpose="summary", search_id="search-1")
    with pytest.raises(GeminiError, match="cycle_cap"):
        client.generate_json(system="s", user="u", schema={}, purpose="summary", search_id="search-1")
    assert calls == [1, 1]
