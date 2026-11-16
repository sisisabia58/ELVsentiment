"""Load provider routing from the database, falling back to code defaults."""

from __future__ import annotations

from typing import Any

from sentiment_monitor.providers.capabilities import (
    DEFAULT_SETTINGS,
    ProviderSetting,
    validate_choice,
)

SELECT_SQL = (
    "select platform, provider, fallback_provider, fallback_on_failure "
    "from provider_settings"
)


def load_provider_settings(conn: Any) -> dict[str, ProviderSetting]:
    rows = conn.execute(SELECT_SQL)
    settings = dict(DEFAULT_SETTINGS)
    for row in rows or ():
        try:
            platform = row["platform"]
            if platform not in DEFAULT_SETTINGS:
                continue
            provider = row["provider"]
            fallback_provider = row["fallback_provider"]
            fallback_on_failure = bool(row["fallback_on_failure"])
            validate_choice(platform, provider, fallback_provider, fallback_on_failure)
        except (KeyError, TypeError, ValueError):
            # Invalid rows never reach routing; the code default stands.
            continue
        settings[platform] = ProviderSetting(
            platform=platform,
            provider=provider,
            fallback_provider=fallback_provider,
            fallback_on_failure=fallback_on_failure,
        )
    return settings
