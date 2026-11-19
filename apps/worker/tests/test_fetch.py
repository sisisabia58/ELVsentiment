import pytest

from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.capabilities import ProviderSetting
from sentiment_monitor.providers.fetch import fetch_platform, provider_api_key


@pytest.mark.parametrize("provider,detail", [
    ("scrapecreators", "unsupported_provider"), ("official_x", "unsupported_provider"),
    ("off", "unsupported_provider"), ("scrapeatlas", "missing_key"),
])
def test_unavailable_never_calls_network(provider, detail):
    result = fetch_platform(
        "threads", Keyword("fixture"), {"threads": ProviderSetting("threads", provider)},
        env={"SCRAPECREATORS_API_KEY": "old", "X_BEARER_TOKEN": "old"},
        collected_at="2026-11-15T00:00:00Z", opener=lambda *_a, **_k: pytest.fail("unexpected network"),
    )
    assert result.state == "unavailable" and result.safe_detail == detail


def test_provider_api_key_maps_only_active_provider():
    env = {"SCRAPEATLAS_API_KEY": "sa", "SCRAPECREATORS_API_KEY": "sc", "X_BEARER_TOKEN": "x"}
    assert provider_api_key("scrapeatlas", env) == "sa"
    assert provider_api_key("scrapecreators", env) is None
    assert provider_api_key("official_x", env) is None


def test_facebook_phrase_is_unavailable_even_in_fixture_mode():
    result = fetch_platform("facebook", Keyword("kopi keliling"), {"facebook": ProviderSetting("facebook","scrapeatlas")},
        env={"CARI_PROVIDER_MODE":"fixture"}, collected_at="2026-11-15T00:00:00Z")
    assert result.state == "unavailable" and result.safe_detail == "hashtag_only" and not result.calls
