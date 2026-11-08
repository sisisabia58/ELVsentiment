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
