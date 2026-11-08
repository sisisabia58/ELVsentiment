import io
import json
import urllib.error

import pytest

from sentiment_monitor.sources.scrapecreators import (
    ScrapeCreatorsError,
    credits_from,
    fetch_scrapecreators_json,
    select_post_list,
)


class Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _fetch(body, status_ok=True):
    def opener(request, timeout=0):
        if not status_ok:
            raise urllib.error.HTTPError(request.full_url, 429, "rate", {}, None)
        return Response(body)

    return fetch_scrapecreators_json("/v1/threads/search", {"query": "rahasia"}, "key", opener=opener)


def test_success_false_is_explicit_failure_with_credits():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch(json.dumps({"success": False, "message": "keyword rahasia", "credits_charged": 7}))
    error = caught.value
    assert error.code == "success_false"
    assert error.credits_charged == 7
    assert "rahasia" not in str(error)


def test_success_false_with_a_post_list_still_fails():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch(json.dumps({"success": False, "posts": [{"pk": "1"}]}))
    assert caught.value.code == "success_false"


def test_malformed_json_and_non_object_fail_safely():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch("{not-json")
    assert caught.value.code == "malformed_json"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch("[1, 2, 3]")
    assert caught.value.code == "malformed_envelope"


def test_non_2xx_becomes_http_code():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch("{}", status_ok=False)
    assert caught.value.code == "http_429"
    assert caught.value.http_status == 429


def test_credits_excludes_bool_and_absent_is_unknown():
    assert credits_from({"credits_charged": 3}) == 3
    assert credits_from({"credits_charged": 3.0}) == 3
    assert credits_from({"credits_charged": True}) is None
    assert credits_from({}) is None


def test_select_post_list_distinguishes_missing_empty_and_malformed():
    assert select_post_list({"posts": []}, ("posts", "items")) == []
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"items": []}, ("posts",))
    assert caught.value.code == "missing_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": {"bad": True}}, ("posts",))
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": [1, 2]}, ("posts",))
    assert caught.value.code == "malformed_posts"


def test_select_post_list_keeps_known_scalar_cardinality():
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": [1, 2]}, ("posts",))
    error = caught.value
    assert error.code == "malformed_posts"
    assert error.counts == {"returned": 2, "parsed": 0, "deduplicated": 0}
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": {"bad": True}}, ("posts",))
    assert caught.value.counts is None


class StatusResponse(io.StringIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_fetch_scrapecreators_keeps_known_status_on_success_and_typed_errors():
    def ok(request, timeout=0):
        return StatusResponse('{"posts": []}', status=200)

    payload = fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=ok)
    assert payload.http_status == 200

    def bad_json(request, timeout=0):
        return StatusResponse("{not-json", status=200)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=bad_json)
    assert caught.value.http_status == 200

    def envelope(request, timeout=0):
        return StatusResponse("[1, 2]", status=200)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=envelope)
    assert caught.value.http_status == 200

    def success_false(request, timeout=0):
        return StatusResponse('{"success": false}', status=200)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=success_false)
    assert caught.value.http_status == 200

    def unknown(request, timeout=0):
        return Response('{"posts": []}')

    assert fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=unknown).http_status is None


class _ReadTimeoutResponse(io.StringIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        raise TimeoutError("synthetic read timeout https://private.example/?q=secret")


def test_read_timeout_keeps_status_known_before_read_and_is_typed():
    def opener(request, timeout=0):
        return _ReadTimeoutResponse("", status=200)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=opener)
    error = caught.value
    assert error.code == "read_timeout"
    assert error.http_status == 200
    assert "synthetic" not in str(error)
    assert "private" not in str(error)
    assert "https" not in str(error)


def test_transport_failure_is_typed_and_does_not_leak_url_or_message():
    def opener(request, timeout=0):
        raise urllib.error.URLError("synthetic network failure https://private.example/?q=secret")

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=opener)
    error = caught.value
    assert error.code == "transport_error"
    assert error.http_status is None
    assert "synthetic" not in str(error)
    assert "private" not in str(error)
    assert "https" not in str(error)


def test_opener_timeout_is_typed_with_unknown_status():
    def opener(request, timeout=0):
        raise TimeoutError("synthetic connect timeout")

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=opener)
    error = caught.value
    assert error.code == "read_timeout"
    assert error.http_status is None
    assert "synthetic" not in str(error)
