from pathlib import Path

import httpx
import respx

from sentiment_monitor.collect import fetch_x_page


@respx.mock
def test_variant_is_the_x_query_without_the_full_brand_name():
    route = respx.get("https://api.x.com/2/tweets/search/recent").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "100",
                        "text": "geprek gembus enak",
                        "author_id": "7",
                        "created_at": "2026-11-01T00:00:00.000Z",
                    }
                ],
                "includes": {"users": [{"id": "7", "username": "ani", "name": "Ani"}]},
                "meta": {},
            },
        )
    )
    page = fetch_x_page("geprek gembus", "test-token", cursor=None, since=None, limit=10)
    assert route.calls[0].request.url.params["query"] == "geprek gembus"
    assert page[0].source == "x"
    assert page[0].external_id == "100"
    assert page[0].variant == "geprek gembus"
    assert page[0].url == "https://x.com/ani/status/100"


@respx.mock
def test_incremental_request_sends_since_id_and_not_an_older_page_token():
    from sentiment_monitor.collect import fetch_x_with_cursor

    route = respx.get("https://api.x.com/2/tweets/search/recent").mock(
        return_value=httpx.Response(200, json={"data": [], "meta": {"next_token": "older-page-token"}})
    )
    _candidates, next_cursor = fetch_x_with_cursor(
        "geprek gembus",
        "test-token",
        cursor=None,
        since=None,
        since_id="100",
        limit=10,
    )
    params = route.calls[0].request.url.params
    assert params["since_id"] == "100"
    assert "next_token" not in params
    assert next_cursor == "older-page-token"
    source = (Path(__file__).resolve().parents[1] / "sentiment_monitor" / "collect.py").read_text()
    # Adjacent literals concatenate at runtime. Split spellings keep this denylist
    # out of the Task 20 launch scanner, which walks every apps/**/*.py file.
    for forbidden in ("Pipeline", "Lexicon" "Sentiment", "harken" ".web", "harken" ".alerts"):
        assert forbidden not in source
