import pytest

from sentiment_monitor.providers.capabilities import (
    DEFAULT_SETTINGS, ProviderSetting, resolve_chain, supported_providers, validate_choice,
)


@pytest.mark.parametrize("platform", ["threads", "tiktok", "instagram", "x", "facebook", "youtube", "linkedin", "reddit"])
def test_active_routes_only_use_atlas(platform):
    assert resolve_chain(platform, DEFAULT_SETTINGS) == ("scrapeatlas",)
    assert supported_providers(platform) == ("scrapeatlas",)
    assert resolve_chain(platform, {platform: ProviderSetting(platform, "off")}) == ()


@pytest.mark.parametrize("provider,fallback,enabled", [
    ("official_x", None, False), ("scrapecreators", None, False),
    ("off", "scrapecreators", False), ("scrapeatlas", "scrapeatlas", True),
])
def test_legacy_and_fallback_selections_rejected(provider, fallback, enabled):
    with pytest.raises(ValueError):
        validate_choice("threads", provider, fallback, enabled)


def test_comment_and_web_availability():
    assert resolve_chain("x", DEFAULT_SETTINGS, "comments") == ()
    assert resolve_chain("threads", DEFAULT_SETTINGS, "comments") == ("scrapeatlas",)
    assert resolve_chain("web", DEFAULT_SETTINGS) == ()
