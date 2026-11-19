import io
import json
import urllib.error

import pytest

from sentiment_monitor.providers.scrapeatlas import (
    ScrapeAtlasError,
    credits_from_headers,
    fetch_scrapeatlas_json,
    safe_atlas_detail,
)


class Response(io.StringIO):
    def __init__(self, payload, status=200, headers=None):
        super().__init__(json.dumps(payload))
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_reads_header_credits_and_coverage_warnings():
    def opener(request, timeout=0):
        assert request.headers["X-api-key"] == "synthetic"
        assert timeout == 20
        return Response(
            {"success": True, "status": "partial", "coverage": {"warnings": ["single_window"]}},
            headers={"x-credits-charged": "1", "x-credits-remaining": "812"},
        )

    payload = fetch_scrapeatlas_json("/v1/threads/search", {"query": "barayam"}, "synthetic", opener=opener)
    assert payload.credits_charged == 1
    assert payload.credits_remaining == 812
    assert payload.coverage_warnings == ["single_window"]
    assert payload["status"] == "partial"
    assert payload.http_status == 200


def test_body_read_timeout_retains_received_http_status_and_credit_headers():
    class ReadTimeout(Response):
        def read(self, size=-1):
            raise TimeoutError("body read timed out")

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/threads/search", {}, "test", opener=lambda *a, **k: ReadTimeout(
            {}, headers={"x-credits-charged": "2", "x-credits-remaining": "12"},
        ))
    error = caught.value
    assert (error.code, error.http_status, error.credits_charged, error.credits_remaining) == ("timeout", 200, 2, 12)


def test_404_not_found_is_free_and_safe():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url, 404, "not found", {},
            io.BytesIO(json.dumps({"success": False, "status": "failed", "failure": {"code": "not_found"}}).encode()),
        )

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/youtube/search", {"query": "x"}, "synthetic", opener=opener)
    error = caught.value
    assert (error.code, error.http_status, error.credits_charged) == ("not_found", 404, 0)
    assert "synthetic" not in repr(error)
    assert "not found" not in str(error)
    assert not hasattr(error, "body")


def test_success_true_but_status_failed_is_an_error():
    def opener(request, timeout=0):
        return Response({"success": True, "status": "failed", "coverage": {"warnings": []}})

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/reddit/search", {"query": "x"}, "synthetic", opener=opener)
    assert caught.value.code == "failed_status"
    assert caught.value.http_status == 200


def test_429_reads_retry_after_from_body():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url, 429, "too many", {"Retry-After": "9"},
            io.BytesIO(json.dumps({"success": False, "failure": {"code": "busy"}, "retryAfter": 2}).encode()),
        )

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/tiktok/search/keyword", {"query": "x"}, "synthetic", opener=opener)
    error = caught.value
    assert (error.code, error.http_status, error.retry_after_ms) == ("http_429", 429, 2000)
    assert error.body_length is not None and error.body_length > 0


def test_429_falls_back_to_header_retry_after():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url, 429, "too many", {"Retry-After": "3"}, io.BytesIO(b"{}")
        )

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/reddit/search", {"query": "x"}, "synthetic", opener=opener)
    assert caught.value.retry_after_ms == 3000


def test_5xx_and_transport_errors_use_safe_codes():
    def server_error(request, timeout=0):
        raise urllib.error.HTTPError(request.full_url, 503, "down", {}, io.BytesIO(b"upstream exploded"))

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/reddit/search", {"query": "x"}, "synthetic", opener=server_error)
    assert caught.value.code == "http_5xx"

    def transport(request, timeout=0):
        raise urllib.error.URLError("connection refused")

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/reddit/search", {"query": "x"}, "synthetic", opener=transport)
    assert caught.value.code == "transport_error"


def test_malformed_json_is_safe():
    class Bad(io.StringIO):
        status = 200
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        return Bad("not-json synthetic-key prompt")

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/reddit/search", {"query": "x"}, "synthetic", opener=opener)
    error = caught.value
    assert error.code == "malformed_json"
    assert "synthetic-key" not in repr(error)
    assert "prompt" not in str(error)
    assert error.body_length == len("not-json synthetic-key prompt")


def test_provider_failure_code_with_secret_never_leaks():
    secret = "synthetic-key prompt-body-text"

    def opener(request, timeout=0):
        return Response(
            {"success": False, "status": "failed", "failure": {"code": secret, "message": secret}},
            headers={"x-credits-charged": "0"},
        )

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/facebook/hashtag", {"hashtag": "barayam"}, "synthetic", opener=opener)
    error = caught.value
    assert error.code == "failed_status"
    assert secret not in str(error)
    assert secret not in repr(error)
    assert not hasattr(error, "body")


def test_credit_helpers_ignore_missing_or_bad_values():
    assert credits_from_headers({"x-credits-charged": "2"}) == (2, None)
    assert credits_from_headers({}) == (None, None)
    assert credits_from_headers({"x-credits-charged": "abc"}) == (None, None)
    for code in ("ok", "not_found", "busy", "upstream_rate_limited", "upstream_challenged",
                 "request_limit", "timeout", "http_429", "http_5xx", "malformed_json",
                 "malformed_envelope", "failed_status", "transport_error"):
        assert safe_atlas_detail(code) == code
    assert safe_atlas_detail("synthetic-secret") == "failed_status"


def test_oversized_body_is_a_safe_failure(monkeypatch):
    from sentiment_monitor.providers import scrapeatlas

    monkeypatch.setattr(scrapeatlas, "MAX_BODY_BYTES", 16)

    def opener(request, timeout=0):
        return Response({"success": True, "posts": []}, headers={"x-credits-charged": "1"})

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/reddit/search", {"query": "x"}, "synthetic", opener=opener)
    assert caught.value.code == "body_too_large"
    assert caught.value.http_status == 200
