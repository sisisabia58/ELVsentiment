import httpx
import respx
from harken.sources import REGISTRY
from harken.sources.base import Source

from sentiment_monitor.sources.threads import ThreadsSource, register_threads
from sentiment_monitor.collect import fetch_threads_page


@respx.mock
def test_threads_adapter_parses_a_keyword_hit_and_registers():
    route = respx.get("https://graph.threads.com/v1.0/keyword_search").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "1234567890",
                        "text": "geprek gembus enak",
                        "media_type": "TEXT",
                        "permalink": "https://www.threads.com/@ani/post/abcdefg",
                        "timestamp": "2026-11-01T05:42:03+0000",
                        "username": "ani",
                    }
                ]
            },
        )
    )
    candidates, truncated = fetch_threads_page("geprek gembus", "token", since=None, limit=25)
    sent = route.calls[0].request.url.params
    assert sent["q"] == "geprek gembus"
    assert sent["search_type"] == "RECENT"
    assert sent["search_mode"] == "KEYWORD"
    assert candidates[0].external_id == "1234567890"
    assert candidates[0].url == "https://www.threads.com/@ani/post/abcdefg"
    assert truncated is False
    register_threads()
    assert REGISTRY["threads"] is ThreadsSource
    assert issubclass(ThreadsSource, Source)
