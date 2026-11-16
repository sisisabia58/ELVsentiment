import pytest

from sentiment_monitor.providers.capabilities import (
    DEFAULT_SETTINGS,
    resolve_chain,
    supported_providers,
    validate_choice,
)


def test_instagram_keyword_is_scrapecreators_only():
    assert supported_providers("instagram", "keyword") == ("scrapecreators",)
    with pytest.raises(ValueError, match="unsupported_provider"):
        validate_choice("instagram", "scrapeatlas", None, False)


def test_new_platforms_default_to_scrapeatlas_and_x_is_project_only():
    assert DEFAULT_SETTINGS["youtube"].provider == "scrapeatlas"
    assert DEFAULT_SETTINGS["reddit"].provider == "scrapeatlas"
    assert DEFAULT_SETTINGS["facebook"].provider == "scrapeatlas"
    assert DEFAULT_SETTINGS["linkedin"].provider == "scrapeatlas"
    assert resolve_chain("x", DEFAULT_SETTINGS, mode="keyword") == ()


def test_off_is_a_valid_choice_and_resolves_to_no_chain():
    validate_choice("youtube", "off", None, False)
    settings = {
        **DEFAULT_SETTINGS,
        "youtube": DEFAULT_SETTINGS["youtube"].__class__(platform="youtube", provider="off"),
    }
    assert resolve_chain("youtube", settings) == ()


def test_threads_fallback_is_off_until_enabled():
    assert resolve_chain("threads", DEFAULT_SETTINGS) == ("scrapecreators",)
    enabled = {
        **DEFAULT_SETTINGS,
        "threads": DEFAULT_SETTINGS["threads"].__class__(
            platform="threads",
            provider="scrapecreators",
            fallback_provider="scrapeatlas",
            fallback_on_failure=True,
        ),
    }
    assert resolve_chain("threads", enabled) == ("scrapecreators", "scrapeatlas")


def test_fallback_requires_a_provider_and_must_be_supported():
    with pytest.raises(ValueError, match="fallback_requires_provider"):
        validate_choice("threads", "scrapecreators", None, True)
    with pytest.raises(ValueError, match="unsupported_provider"):
        validate_choice("instagram", "scrapecreators", "scrapeatlas", True)
    with pytest.raises(ValueError, match="unsupported_provider"):
        validate_choice("youtube", "off", "scrapeatlas", True)


def test_fallback_is_ignored_when_disabled_or_unsupported():
    disabled = {
        **DEFAULT_SETTINGS,
        "threads": DEFAULT_SETTINGS["threads"].__class__(
            platform="threads",
            provider="scrapecreators",
            fallback_provider="scrapeatlas",
            fallback_on_failure=False,
        ),
    }
    assert resolve_chain("threads", disabled) == ("scrapecreators",)
    unsupported = {
        **DEFAULT_SETTINGS,
        "youtube": DEFAULT_SETTINGS["youtube"].__class__(
            platform="youtube",
            provider="scrapeatlas",
            fallback_provider="scrapecreators",
            fallback_on_failure=True,
        ),
    }
    assert resolve_chain("youtube", unsupported) == ("scrapeatlas",)


def test_comments_mode_and_off_platforms():
    assert supported_providers("threads", "comments") == ("scrapeatlas",)
    assert supported_providers("youtube", "comments") == ("scrapeatlas",)
    assert supported_providers("linkedin", "comments") == ()
    assert supported_providers("x", "comments") == ()
    assert supported_providers("web", "keyword") == ()
    assert DEFAULT_SETTINGS["web"].provider == "off"
    assert DEFAULT_SETTINGS["comments"].provider == "scrapeatlas"
    assert resolve_chain("linkedin", DEFAULT_SETTINGS, mode="comments") == ()
