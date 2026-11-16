"""Provider capability matrix and default routing settings.

The matrix is the code-level guard: a provider that is not listed for a
platform/mode can never be selected and never enters a fallback chain.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal, Mapping

from sentiment_monitor.paths import repo_root

SearchPlatform = Literal[
    "threads", "tiktok", "instagram", "youtube", "reddit", "facebook", "linkedin", "x", "web"
]
ProviderId = Literal["scrapecreators", "scrapeatlas", "official_x", "off"]
ProviderMode = Literal["keyword", "comments"]

KEYWORD_CAPABILITIES: dict[str, tuple[ProviderId, ...]] = {
    "threads": ("scrapecreators", "scrapeatlas"),
    "tiktok": ("scrapecreators", "scrapeatlas"),
    "instagram": ("scrapecreators",),
    "youtube": ("scrapeatlas",),
    "reddit": ("scrapeatlas",),
    "facebook": ("scrapeatlas",),
    "linkedin": ("scrapeatlas",),
    "x": (),
    "web": (),
}

COMMENTS_CAPABILITIES: dict[str, tuple[ProviderId, ...]] = {
    "threads": ("scrapeatlas",),
    "tiktok": ("scrapeatlas",),
    "instagram": ("scrapeatlas",),
    "youtube": ("scrapeatlas",),
    "facebook": ("scrapeatlas",),
    "reddit": ("scrapeatlas",),
    "linkedin": (),
    "x": (),
    "web": (),
}


@dataclass(frozen=True)
class ProviderSetting:
    platform: str
    provider: ProviderId
    fallback_provider: ProviderId | None = None
    fallback_on_failure: bool = False


def _load_defaults() -> dict[str, ProviderSetting]:
    path = repo_root() / "config" / "cari-providers.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        platform: ProviderSetting(
            platform=platform,
            provider=values["provider"],
            fallback_provider=values.get("fallback_provider"),
            fallback_on_failure=bool(values.get("fallback_on_failure", False)),
        )
        for platform, values in raw.items()
    }


DEFAULT_SETTINGS: dict[str, ProviderSetting] = _load_defaults()


def supported_providers(platform: str, mode: ProviderMode = "keyword") -> tuple[ProviderId, ...]:
    capabilities = COMMENTS_CAPABILITIES if mode == "comments" else KEYWORD_CAPABILITIES
    return capabilities.get(platform, ())


def resolve_chain(
    platform: str,
    settings: Mapping[str, ProviderSetting],
    mode: ProviderMode = "keyword",
) -> tuple[ProviderId, ...]:
    # Comment fetching has one global routing row keyed "comments"; the
    # platform only decides whether comments are supported there.
    target = "comments" if mode == "comments" else platform
    setting = settings.get(target)
    if setting is None or setting.provider == "off":
        return ()
    supported = supported_providers(platform, mode)
    if setting.provider not in supported:
        return ()
    chain: list[ProviderId] = [setting.provider]
    fallback = setting.fallback_provider
    if (
        setting.fallback_on_failure
        and fallback
        and fallback != setting.provider
        and fallback in supported
    ):
        chain.append(fallback)
    return tuple(chain)


def _comments_supported() -> tuple[ProviderId, ...]:
    # The comments target is one global routing row, so it is valid when the
    # provider is supported for at least one comments-capable platform.
    return tuple(
        dict.fromkeys(
            provider
            for providers in COMMENTS_CAPABILITIES.values()
            for provider in providers
        )
    )


def validate_choice(
    platform: str,
    provider: str,
    fallback_provider: str | None,
    fallback_on_failure: bool,
    mode: ProviderMode = "keyword",
) -> None:
    if provider == "off":
        if fallback_on_failure:
            raise ValueError("unsupported_provider")
        return
    supported = _comments_supported() if platform == "comments" else supported_providers(platform, mode)
    if provider not in supported:
        raise ValueError("unsupported_provider")
    if fallback_on_failure and fallback_provider is None:
        raise ValueError("fallback_requires_provider")
    if fallback_provider is not None and fallback_provider not in supported:
        raise ValueError("unsupported_provider")
