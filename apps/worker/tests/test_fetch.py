from sentiment_monitor.intent import Keyword
from sentiment_monitor.providers.capabilities import ProviderSetting
from sentiment_monitor.providers.fetch import PlatformFetch, fetch_platform, provider_api_key


def test_unsupported_instagram_scrapeatlas_never_calls_network():
    called = []

    result = fetch_platform(
        "instagram", Keyword("barayam"),
        {"instagram": ProviderSetting("instagram", "scrapeatlas")},
        env={"SCRAPEATLAS_API_KEY": "synthetic"},
        collected_at="2026-11-15T00:00:00Z",
        primary=lambda *a, **k: called.append(1),
    )
    assert result.state == "unavailable"
    assert result.safe_detail == "unsupported_provider"
    assert called == []


def test_fallback_runs_only_when_enabled_and_primary_fails():
    def primary(**kwargs):
        return PlatformFetch("threads", "scrapecreators", [], [], "failed", "http_500", 10)

    def fallback(**kwargs):
        return PlatformFetch("threads", "scrapeatlas", [], [], "answered", "ok", 20)

    result = fetch_platform(
        "threads", Keyword("barayam"),
        {"threads": ProviderSetting("threads", "scrapecreators", "scrapeatlas", True)},
        env={"SCRAPECREATORS_API_KEY": "synthetic", "SCRAPEATLAS_API_KEY": "synthetic"},
        collected_at="2026-11-15T00:00:00Z", primary=primary, fallback=fallback,
    )
    assert result.provider == "scrapeatlas"
    assert result.state == "answered"
    assert result.attempted_providers == ("scrapecreators", "scrapeatlas")


def test_fallback_does_not_run_when_disabled():
    called = []

    def primary(**kwargs):
        return PlatformFetch("threads", "scrapecreators", [], [], "failed", "http_429", 10)

    def fallback(**kwargs):
        called.append(1)
        return PlatformFetch("threads", "scrapeatlas", [], [], "answered", "ok", 20)

    result = fetch_platform(
        "threads", Keyword("barayam"),
        {"threads": ProviderSetting("threads", "scrapecreators", "scrapeatlas", False)},
        env={"SCRAPECREATORS_API_KEY": "synthetic", "SCRAPEATLAS_API_KEY": "synthetic"},
        collected_at="2026-11-15T00:00:00Z", primary=primary, fallback=fallback,
    )
    assert result.provider == "scrapecreators"
    assert result.state == "failed"
    assert called == []


def test_no_fallback_after_not_found():
    called = []

    def primary(**kwargs):
        return PlatformFetch("threads", "scrapecreators", [], [], "answered", "not_found", 10)

    def fallback(**kwargs):
        called.append(1)
        return PlatformFetch("threads", "scrapeatlas", [], [], "answered", "ok", 20)

    result = fetch_platform(
        "threads", Keyword("barayam"),
        {"threads": ProviderSetting("threads", "scrapecreators", "scrapeatlas", True)},
        env={"SCRAPECREATORS_API_KEY": "synthetic", "SCRAPEATLAS_API_KEY": "synthetic"},
        collected_at="2026-11-15T00:00:00Z", primary=primary, fallback=fallback,
    )
    assert result.provider == "scrapecreators"
    assert result.safe_detail == "not_found"
    assert called == []


def test_missing_key_is_unavailable_without_network():
    called = []

    result = fetch_platform(
        "threads", Keyword("barayam"),
        {"threads": ProviderSetting("threads", "scrapecreators")},
        env={"SCRAPECREATORS_API_KEY": "  "},
        collected_at="2026-11-15T00:00:00Z",
        primary=lambda *a, **k: called.append(1),
    )
    assert result.state == "unavailable"
    assert result.safe_detail == "missing_key"
    assert called == []


def test_fallback_missing_key_is_unavailable_without_network():
    called = []

    def primary(**kwargs):
        return PlatformFetch("threads", "scrapecreators", [], [], "failed", "timeout", 10)

    result = fetch_platform(
        "threads", Keyword("barayam"),
        {"threads": ProviderSetting("threads", "scrapecreators", "scrapeatlas", True)},
        env={"SCRAPECREATORS_API_KEY": "synthetic"},
        collected_at="2026-11-15T00:00:00Z", primary=primary,
        fallback=lambda *a, **k: called.append(1),
    )
    assert result.state == "unavailable"
    assert result.safe_detail == "missing_key"
    assert called == []
    assert result.attempted_providers == ("scrapecreators", "scrapeatlas")


def test_primary_success_never_touches_fallback():
    called = []

    def primary(**kwargs):
        return PlatformFetch("threads", "scrapecreators", [], [], "answered", "ok", 10)

    result = fetch_platform(
        "threads", Keyword("barayam"),
        {"threads": ProviderSetting("threads", "scrapecreators", "scrapeatlas", True)},
        env={"SCRAPECREATORS_API_KEY": "synthetic", "SCRAPEATLAS_API_KEY": "synthetic"},
        collected_at="2026-11-15T00:00:00Z", primary=primary,
        fallback=lambda *a, **k: called.append(1),
    )
    assert result.provider == "scrapecreators"
    assert result.attempted_providers == ("scrapecreators",)
    assert called == []


def test_off_setting_is_unavailable():
    result = fetch_platform(
        "threads", Keyword("barayam"),
        {"threads": ProviderSetting("threads", "off")},
        env={"SCRAPECREATORS_API_KEY": "synthetic"},
        collected_at="2026-11-15T00:00:00Z",
    )
    assert result.state == "unavailable"
    assert result.safe_detail == "unsupported_provider"


def test_provider_api_key_maps_only_known_providers():
    env = {
        "SCRAPECREATORS_API_KEY": "sc",
        "SCRAPEATLAS_API_KEY": "sa",
        "X_BEARER_TOKEN": "x",
    }
    assert provider_api_key("scrapecreators", env) == "sc"
    assert provider_api_key("scrapeatlas", env) == "sa"
    assert provider_api_key("official_x", env) == "x"
    assert provider_api_key("off", env) is None
    assert provider_api_key("scrapeatlas", {"SCRAPEATLAS_API_KEY": "   "}) is None
