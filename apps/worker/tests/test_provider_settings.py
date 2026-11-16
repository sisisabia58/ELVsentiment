from sentiment_monitor.providers.settings import load_provider_settings


class FakeConn:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params=None):
        return self.rows


def test_missing_rows_use_defaults_and_invalid_rows_fall_back():
    rows = [
        {"platform": "instagram", "provider": "scrapeatlas", "fallback_provider": None, "fallback_on_failure": False},
        {"platform": "youtube", "provider": "scrapeatlas", "fallback_provider": None, "fallback_on_failure": False},
    ]
    settings = load_provider_settings(FakeConn(rows))
    assert settings["youtube"].provider == "scrapeatlas"
    assert settings["instagram"].provider == "scrapecreators"
    assert settings["threads"].provider == "scrapecreators"


def test_invalid_fallback_unknown_platform_and_off_rows_are_ignored_or_applied():
    rows = [
        {"platform": "threads", "provider": "scrapecreators", "fallback_provider": "scrapeatlas", "fallback_on_failure": True},
        {"platform": "reddit", "provider": "scrapeatlas", "fallback_provider": "scrapecreators", "fallback_on_failure": True},
        {"platform": "youtube", "provider": "off", "fallback_provider": None, "fallback_on_failure": False},
        {"platform": "nope", "provider": "off", "fallback_provider": None, "fallback_on_failure": False},
        {"platform": "comments", "provider": "off", "fallback_provider": None, "fallback_on_failure": False},
    ]
    settings = load_provider_settings(FakeConn(rows))
    assert settings["threads"].fallback_provider == "scrapeatlas"
    assert settings["threads"].fallback_on_failure is True
    assert settings["reddit"].provider == "scrapeatlas"
    assert settings["reddit"].fallback_provider is None
    assert settings["youtube"].provider == "off"
    assert "nope" not in settings
    assert settings["comments"].provider == "off"
    assert settings["web"].provider == "off"


def test_fallback_enabled_without_provider_is_ignored():
    rows = [
        {"platform": "threads", "provider": "scrapecreators", "fallback_provider": None, "fallback_on_failure": True},
    ]
    settings = load_provider_settings(FakeConn(rows))
    assert settings["threads"].fallback_on_failure is False
    assert settings["threads"].provider == "scrapecreators"
