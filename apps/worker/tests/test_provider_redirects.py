"""Provider calls must never follow redirects (and never forward x-api-key)."""

import io
import urllib.error
import urllib.request

import pytest

from sentiment_monitor.providers import http as provider_http
from sentiment_monitor.providers.scrapeatlas import ScrapeAtlasError, fetch_scrapeatlas_json


def test_redirect_handler_refuses_to_follow():
    handler = provider_http.NoRedirectHandler()
    request = urllib.request.Request(
        "https://api.scrapeatlas.com/v1/reddit/search",
        headers={"x-api-key": "synthetic"},
    )
    assert handler.redirect_request(
        request, None, 302, "Found", {}, "https://evil.example.invalid/internal"
    ) is None


def test_client_defaults_use_the_no_redirect_opener():
    assert any(
        isinstance(handler, provider_http.NoRedirectHandler)
        for handler in provider_http.DEFAULT_OPENER.handlers
    )
    from sentiment_monitor.providers import fetch

    assert fetch.fetch_platform.__kwdefaults__["opener"] is provider_http.urlopen


def test_scrapeatlas_treats_3xx_as_a_safe_failure():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url,
            302,
            "Found",
            {"x-credits-charged": "1"},
            io.BytesIO(b""),
        )

    with pytest.raises(ScrapeAtlasError) as caught:
        fetch_scrapeatlas_json("/v1/reddit/search", {"query": "x"}, "synthetic", opener=opener)
    assert caught.value.code == "http_3xx"
    assert caught.value.http_status == 302
    assert caught.value.credits_charged == 1
    assert "evil" not in str(caught.value)
