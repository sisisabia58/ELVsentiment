from datetime import datetime, timedelta, timezone
import io
import json
import logging
import urllib.error

import pytest

from sentiment_monitor.gemini import GeminiClient, GeminiError, create_gemini, reset_gemini_budget
from sentiment_monitor.instant_ai import SUMMARY_SYSTEM
from sentiment_monitor.instant_search import (
    _create_llm,
    _question_detail,
    claim_instant_search,
    finish_search,
    insert_posts,
    run_question_cycle,
    summarize_search,
)
from sentiment_monitor.opencode import (
    OPENCODE_TIMEOUT_SECONDS,
    OPENCODE_URL,
    OPENCODE_USER_AGENT,
    OpenCodeClient,
    create_opencode,
)
from sentiment_monitor.providers.canonical import CanonicalPost

SEARCH = "22222222-2222-4222-8222-222222222222"
CUSTOMER = "11111111-1111-4111-8111-111111111111"
KEY = "synthetic-opencode-key"


@pytest.fixture(autouse=True)
def _fresh_budget():
    reset_gemini_budget()
    yield
    reset_gemini_budget()


def _post() -> CanonicalPost:
    return CanonicalPost(
        platform="threads",
        external_id="th-1",
        text="antrean panjang",
        title=None,
        author_name="Rina",
        author_handle="rina",
        url="https://example.invalid/th-1",
        published_at="2026-11-14T00:00:00Z",
        thumbnail_url=None,
        views=1,
        likes=1,
        replies=0,
        shares=0,
        top_replies=(),
        hashtags=(),
        source_provider="fixture",
        routes=("fixture.threads.search",),
        raw_ref="fixture:th-1",
        collected_at="2026-11-15T00:00:00Z",
        language="id",
        relevance="literal_match",
        web_index=False,
    )


class _Headers(dict):
    def get(self, key, default=None):
        for name, value in self.items():
            if name.lower() == key.lower():
                return value
        return default


class _Response:
    def __init__(self, payload, status=200):
        self.status = status
        self._raw = json.dumps(payload).encode()

    def read(self, _limit):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _chat(content, reasoning="DO-NOT-SHOW-REASONING", usage=None):
    return {
        "model": "deepseek-v4.1-flash",
        "choices": [{
            "message": {
                "role": "assistant",
                "content": content,
                "reasoning_content": reasoning,
            },
        }],
        "usage": usage or {"prompt_tokens": 11, "completion_tokens": 7},
    }


def _reject(status, body, headers=None):
    def opener(request, timeout):
        del timeout
        raise urllib.error.HTTPError(
            request.full_url,
            status,
            "error",
            hdrs=_Headers(headers or {}),
            fp=io.BytesIO(json.dumps(body).encode()),
        )

    return opener


class _Gate:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        if "select paused_until" in sql:
            return [{"paused_until": None, "last_request_at": None}]
        return []

    def commit(self):
        return None


def test_gemini_provider_is_unchanged_and_opencode_is_a_separate_client():
    gemini = create_gemini({"CARI_AI_PROVIDER": "gemini", "GEMINI_API_KEY": "synthetic-key"})
    assert isinstance(gemini, GeminiClient)
    with pytest.raises(GeminiError, match="unsupported_provider"):
        create_gemini({"CARI_AI_PROVIDER": "opencode", "OPENCODE_API_KEY": KEY})
    client = _create_llm({"CARI_AI_PROVIDER": "opencode", "OPENCODE_API_KEY": KEY})
    assert isinstance(client, OpenCodeClient)
    assert client.model == "deepseek-v4.1-flash"
    with pytest.raises(GeminiError, match="missing_key"):
        create_opencode({"CARI_AI_PROVIDER": "opencode"})


def test_opencode_request_uses_the_go_endpoint_and_ignores_reasoning(caplog):
    captured = {}

    def opener(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["authorization"] = request.get_header("Authorization")
        captured["user_agent"] = request.get_header("User-agent")
        captured["session"] = request.get_header("X-opencode-session")
        captured["body"] = json.loads(request.data.decode())
        return _Response(_chat('{"answer":"Antrean.","citations":[]}'))

    client = create_opencode(
        {"OPENCODE_API_KEY": KEY, "OPENCODE_MODEL": "deepseek-v4.1-flash"},
        opener=opener,
    )
    with caplog.at_level(logging.INFO, logger="sentiment_monitor.opencode"):
        result = client.generate_json(
            system=SUMMARY_SYSTEM,
            user="Pertanyaan: Apa keluhannya?",
            schema={"type": "object"},
            purpose="question",
            search_id=SEARCH,
            max_output_tokens=2048,
        )
    assert captured["url"] == OPENCODE_URL
    assert captured["timeout"] == OPENCODE_TIMEOUT_SECONDS
    assert captured["authorization"] == f"Bearer {KEY}"
    assert captured["user_agent"] == OPENCODE_USER_AGENT
    assert "Python-urllib" not in captured["user_agent"]
    assert captured["session"] == f"elv-{SEARCH}"
    assert KEY not in captured["url"]
    body = captured["body"]
    assert body["model"] == "deepseek-v4.1-flash"
    assert body["messages"][1]["content"] == "Pertanyaan: Apa keluhannya?"
    assert body["messages"][0]["content"].startswith(SUMMARY_SYSTEM)
    assert body["response_format"] == {"type": "json_object"}
    assert body["max_tokens"] == 2048
    assert result.data == {"answer": "Antrean.", "citations": []}
    assert result.input_tokens == 11
    assert result.output_tokens == 7
    assert "DO-NOT-SHOW-REASONING" not in caplog.text
    assert KEY not in caplog.text
    assert (
        f"opencode_ok purpose=question search={SEARCH} "
        "model=deepseek-v4.1-flash input_tokens=11 output_tokens=7"
    ) in caplog.text


def test_opencode_strips_json_fences_and_a_leading_sentence():
    def opener(request, timeout):
        del request, timeout
        return _Response(_chat('Catatan.\n```json\n{"overall_summary":"Ringkas."}\n```'))

    client = create_opencode({"OPENCODE_API_KEY": KEY}, opener=opener)
    result = client.generate_json(
        system="s", user="u", schema={}, purpose="summary", search_id="search-1",
    )
    assert result.data == {"overall_summary": "Ringkas."}
    assert "DO-NOT-SHOW-REASONING" not in json.dumps(result.data)


def test_usage_limit_pauses_for_retry_after_and_hides_the_key(caplog):
    gate = _Gate()
    client = create_opencode({"OPENCODE_API_KEY": KEY}, gate, opener=_reject(
        429,
        {"error": {"message": f"usage limit for {KEY}", "code": "usage_limit"}},
        {"Retry-After": "90"},
    ))
    before = datetime.now(timezone.utc)
    with caplog.at_level(logging.INFO, logger="sentiment_monitor.opencode"):
        with pytest.raises(GeminiError, match="http_429"):
            client.generate_json(system="s", user="u", schema={}, purpose="summary", search_id=SEARCH)
    inserts = [
        params for sql, params in gate.statements
        if "paused_until" in sql and sql.strip().startswith("insert")
    ]
    assert len(inserts) == 1
    until = inserts[0][0]
    assert before + timedelta(seconds=89) <= until <= before + timedelta(seconds=95)
    assert "opencode_http status=429" in caplog.text
    assert KEY not in caplog.text
    assert "[redacted]" in caplog.text


def test_unauthorized_is_a_config_error_and_does_not_pause():
    gate = _Gate()
    client = create_opencode({"OPENCODE_API_KEY": KEY}, gate, opener=_reject(
        401,
        {"error": {"message": "invalid api key"}},
    ))
    with pytest.raises(GeminiError, match="config_error") as caught:
        client.generate_json(system="s", user="u", schema={}, purpose="question")
    assert caught.value.counts_as_attempt is False
    assert _question_detail("config_error") == "config_error"
    assert not any(
        "paused_until" in sql and sql.strip().startswith("insert")
        for sql, _params in gate.statements
    )


def test_forbidden_is_a_config_error():
    client = create_opencode({"OPENCODE_API_KEY": KEY}, opener=_reject(403, {"error": {"message": "forbidden"}}))
    with pytest.raises(GeminiError, match="config_error"):
        client.generate_json(system="s", user="u", schema={}, purpose="summary")


def test_opencode_stops_at_the_cycle_cap(monkeypatch):
    import sentiment_monitor.gemini as gemini_mod

    monkeypatch.setattr(gemini_mod, "GEMINI_CALLS_PER_CYCLE", 2)
    calls = []

    def opener(request, timeout):
        del request, timeout
        calls.append(1)
        return _Response(_chat('{"ok": true}'))

    client = create_opencode({"OPENCODE_API_KEY": KEY}, opener=opener)
    for _ in range(2):
        client.generate_json(system="s", user="u", schema={}, purpose="summary", search_id="search-1")
    with pytest.raises(GeminiError, match="cycle_cap"):
        client.generate_json(system="s", user="u", schema={}, purpose="summary", search_id="search-1")
    assert calls == [1, 1]


def test_summary_and_question_use_opencode_without_showing_reasoning(db, monkeypatch):
    job = claim_instant_search(db, "worker-1")
    insert_posts(db, job, [_post()])
    finish_search(db, job, "succeeded")
    db.execute("delete from gemini_gate")
    seen = []

    def opener(request, timeout):
        body = json.loads(request.data.decode())
        seen.append({
            "session": request.get_header("X-opencode-session"),
            "agent": request.get_header("User-agent"),
            "user": body["messages"][1]["content"],
            "timeout": timeout,
        })
        if body["max_tokens"] == 2048:
            content = json.dumps({"answer": "Keluhan utamanya antrean.", "citations": []})
        else:
            content = json.dumps({
                "overall_summary": "Ringkasan antrean.",
                "overall_stance": "campuran",
                "platforms": [],
                "quotes": [],
                "themes": [],
            })
        return _Response(_chat(content, reasoning="hidden chain of thought"))

    monkeypatch.setattr("sentiment_monitor.opencode.safe_urlopen", opener)
    env = {"CARI_AI_PROVIDER": "opencode", "OPENCODE_API_KEY": KEY}
    summarize_search(db, job, now=datetime.now(timezone.utc), env=env)
    summary = db.execute(
        "select summary_status, overall_stance from instant_searches where id=%s",
        (job.id,),
    )[0]
    stored = db.execute(
        "select overall_summary, model from instant_search_ai where search_id=%s",
        (job.id,),
    )[0]
    assert summary["summary_status"] == "done"
    assert stored["overall_summary"] == "Ringkasan antrean."
    assert stored["model"] == "deepseek-v4.1-flash"
    assert "hidden chain of thought" not in stored["overall_summary"]

    db.execute(
        """
        insert into instant_search_questions
          (id, search_id, customer_id, question, status, user_credits)
        values (%s, %s, %s, %s, 'queued', 1)
        """,
        ("33333333-3333-4333-8333-333333333361", SEARCH, CUSTOMER, "Apa keluhan utama?"),
    )
    claimed = run_question_cycle(db, env=env, now=datetime.now(timezone.utc))
    row = db.execute(
        "select status, answer, model from instant_search_questions"
    )[0]
    assert claimed == 1
    assert row["status"] == "done"
    assert row["answer"] == "Keluhan utamanya antrean."
    assert "hidden chain of thought" not in row["answer"]
    assert seen[0]["session"] == f"elv-{job.id}"
    assert seen[1]["session"] == f"elv-{job.id}"
    assert seen[0]["agent"] == OPENCODE_USER_AGENT
    assert seen[0]["timeout"] == OPENCODE_TIMEOUT_SECONDS
    assert "<<<DATA>>>" in seen[0]["user"]
    assert seen[0]["user"].startswith("Tugas:")
    assert seen[1]["user"].startswith("Pertanyaan: Apa keluhan utama?")
