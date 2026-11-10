import io
import json
import os
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import unquote

import pytest

from sentiment_monitor.intent import Keyword
from sentiment_monitor.scheduler import _log_route_events, _safe_error_label
from sentiment_monitor.sources.instagram import fetch_instagram_mentions
from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

KNOWN = "qa_security_known_1234567890"
UNKNOWN = "qa_security_unknown_1234567890"


def _enc(value: str) -> str:
    return "".join(f"%{byte:02X}" for byte in value.encode())


def _uni(value: str) -> str:
    return "".join(f"\\u{ord(char):04x}" for char in value)


def _decoded_spellings(value: str) -> str:
    decoded = value
    for _ in range(5):
        decoded = unquote(decoded)
    return decoded


def _assert_no_known_text(line: str, marker: str, case_id: str, *, prefix: bool = False) -> None:
    needle = marker[:12] if prefix else marker
    if needle in line or needle in _decoded_spellings(line):
        pytest.fail(f"{case_id}: provider_text_leaked=true")


def _assert_body_contract(line: str, expected_length: int, case_id: str) -> None:
    if " body=-" not in line:
        pytest.fail(f"{case_id}: body_field_was_not_dash")
    if f"body_length={expected_length}" not in line:
        pytest.fail(f"{case_id}: body_length_mismatch")


def _log_one(body: str) -> str:
    lines = []
    with patch.dict(os.environ, {"SCRAPECREATORS_API_KEY": KNOWN}):
        _log_route_events(
            lines.append,
            {"id": "qa-job", "project_id": "qa-project"},
            "instagram",
            [
                {
                    "route": "qa.route",
                    "outcome": "failed",
                    "http_status": 404,
                    "credits_charged": 0,
                    "detail": "http_404",
                    "body": body,
                }
            ],
        )
    assert len(lines) == 1
    return lines[0]


def _ig404_events(body: str):
    calls = []

    def opener(request, timeout=0):
        calls.append(request.full_url)
        raise HTTPError(
            request.full_url,
            404,
            "synthetic",
            {},
            io.BytesIO(body.encode("utf-8")),
        )

    with patch.dict(os.environ, {"SCRAPECREATORS_API_KEY": KNOWN}):
        with pytest.raises(ScrapeCreatorsError) as caught:
            fetch_instagram_mentions(
                Keyword("#barayam", "hashtag"),
                "synthetic",
                "2026-11-10T00:00:00Z",
                opener=opener,
            )
    error = caught.value
    if error.http_status != 404 or len(calls) != 1:
        pytest.fail("ig404_full_pipeline_harness_failed")
    return error.route_events


CASES = [
    ("plain_known_message", json.dumps({"message": KNOWN}), KNOWN, False),
    ("authorization_header", "Authorization: Bearer " + UNKNOWN, UNKNOWN, False),
    ("api_key_header", "x-api-key: " + UNKNOWN, UNKNOWN, False),
    ("cookie_header", "Cookie: session=" + UNKNOWN, UNKNOWN, False),
    (
        "query_key",
        "https://example.invalid/?key=" + UNKNOWN,
        UNKNOWN,
        False,
    ),
    (
        "nested_json_token",
        json.dumps({"err": {"token": UNKNOWN}}),
        UNKNOWN,
        False,
    ),
    (
        "unicode_json_key",
        '{"' + _uni("x-api-key") + '":"' + UNKNOWN + '"}',
        UNKNOWN,
        False,
    ),
    (
        "unicode_known_value",
        '{"message":"' + _uni(KNOWN) + '"}',
        KNOWN,
        False,
    ),
    (
        "json_escaped_known",
        json.dumps({"message": json.dumps({"key": KNOWN})}),
        KNOWN,
        False,
    ),
    ("200_boundary", " " * 185 + "key=" + KNOWN, KNOWN, False),
    ("long_body_known", " " * 3000 + "key=" + KNOWN + " " * 1000, KNOWN, False),
    (
        "encoded_entire_authorization",
        _enc("Authorization: Bearer " + UNKNOWN),
        UNKNOWN,
        False,
    ),
    (
        "encoded_entire_query",
        _enc("https://example.invalid/?api_key=" + UNKNOWN),
        UNKNOWN,
        True,
    ),
    (
        "encoded_parameter_name",
        "https://example.invalid/?api%5Fkey=" + UNKNOWN,
        UNKNOWN,
        False,
    ),
    ("encoded_known_in_message", "message=" + _enc(KNOWN), KNOWN, False),
    (
        "double_json_unknown_xapikey",
        json.dumps({"error": json.dumps({"x-api-key": UNKNOWN})}),
        UNKNOWN,
        False,
    ),
    (
        "unicode_nonjson_key",
        "x" + _uni("-api-key") + ": " + UNKNOWN,
        UNKNOWN,
        False,
    ),
    ("cookie_bracket_tail", "Cookie: session=]" + UNKNOWN, UNKNOWN, False),
    ("cookie_brace_tail", "Set-Cookie: session=}" + UNKNOWN, UNKNOWN, False),
    (
        "deep_triple_encoded_known",
        _enc(_enc(_enc(KNOWN))),
        KNOWN,
        False,
    ),
    (
        "nested_json_string_four",
        json.dumps(
            {
                "error": json.dumps(
                    {"error": json.dumps({"x-api-key": UNKNOWN})}
                )
            }
        ),
        UNKNOWN,
        False,
    ),
    (
        "unicode_escaped_key_name",
        '{"' + _uni("x-api-key") + '":"' + UNKNOWN + '"}',
        UNKNOWN,
        False,
    ),
    (
        "malicious_nonjson",
        '}}}###' + UNKNOWN + '\\u0000{{{ Cookie: session=}' + UNKNOWN,
        UNKNOWN,
        False,
    ),
    (
        "over_8192_direct",
        " " * 8178 + KNOWN + " trailing",
        KNOWN,
        True,
    ),
]


@pytest.mark.parametrize(
    "case_id,body,marker,prefix",
    CASES,
    ids=[case[0] for case in CASES],
)
def test_route_log_never_contains_provider_body_text(case_id, body, marker, prefix):
    line = _log_one(body)
    _assert_no_known_text(line, marker, case_id, prefix=prefix)
    _assert_body_contract(line, len(body), case_id)
    if "http_status=404" not in line:
        pytest.fail(f"{case_id}: status_missing")


@pytest.mark.parametrize(
    "case_id,body,marker",
    [
        (
            "ig404_json_body",
            json.dumps({"error": "Not found", "x-api-key": UNKNOWN}),
            UNKNOWN,
        ),
        (
            "ig404_internal_8192_boundary",
            " " * 8178 + KNOWN + " trailing",
            KNOWN,
        ),
        (
            "ig404_encoded_known_message",
            "message=" + _enc(KNOWN),
            KNOWN,
        ),
        (
            "ig404_double_json_xapikey",
            json.dumps({"error": json.dumps({"x-api-key": UNKNOWN})}),
            UNKNOWN,
        ),
        (
            "ig404_encoded_query_name",
            "https://example.invalid/?api%5Fkey=" + UNKNOWN,
            UNKNOWN,
        ),
        (
            "ig404_cookie_brace",
            "Set-Cookie: session=}" + UNKNOWN,
            UNKNOWN,
        ),
    ],
    ids=[
        "ig404_json_body",
        "ig404_internal_8192_boundary",
        "ig404_encoded_known_message",
        "ig404_double_json_xapikey",
        "ig404_encoded_query_name",
        "ig404_cookie_brace",
    ],
)
def test_ig404_full_pipeline_never_logs_provider_body_text(case_id, body, marker):
    events = _ig404_events(body)
    lines = []
    with patch.dict(os.environ, {"SCRAPECREATORS_API_KEY": KNOWN}):
        _log_route_events(
            lines.append,
            {"id": "qa-job", "project_id": "qa-project"},
            "instagram",
            events,
        )
    assert len(lines) == 1
    _assert_no_known_text(lines[0], marker, case_id, prefix=case_id.endswith("8192_boundary"))
    _assert_body_contract(lines[0], len(body.encode("utf-8")), case_id)
    if "http_status=404" not in lines[0]:
        pytest.fail(f"{case_id}: status_missing")


def test_exception_message_and_repr_are_not_used_as_error_labels():
    class ReprError(RuntimeError):
        def __repr__(self):
            return UNKNOWN

    label = _safe_error_label(ReprError(UNKNOWN))
    if UNKNOWN in label or UNKNOWN[:12] in label:
        pytest.fail("exception_repr_leaked=true")
    if label != "Exception other":
        pytest.fail("exception_label_not_safe_enum")
