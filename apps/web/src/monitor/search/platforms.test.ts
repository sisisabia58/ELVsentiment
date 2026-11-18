import { describe, expect, it } from "vitest";
import defaults from "../../../../../config/cari-providers.json";
import {
  DEFAULT_PROVIDER_SETTINGS,
  resolveProviderChain,
  SEARCH_PLATFORMS,
  type SettingTarget,
  supportedProviders,
  validateProviderChoice,
} from "./platforms";

describe("search provider matrix", () => {
  it("matches the shared JSON defaults", () => {
    expect(DEFAULT_PROVIDER_SETTINGS.youtube.provider).toBe("scrapeatlas");
    expect(DEFAULT_PROVIDER_SETTINGS.instagram.provider).toBe("scrapeatlas");
    expect(DEFAULT_PROVIDER_SETTINGS.threads.fallbackOnFailure).toBe(false);
    expect(DEFAULT_PROVIDER_SETTINGS.comments.provider).toBe("scrapeatlas");
    expect(DEFAULT_PROVIDER_SETTINGS.web.provider).toBe("off");
    expect(defaults.threads.fallback_on_failure).toBe(false);
    for (const [target, values] of Object.entries(defaults)) {
      expect(DEFAULT_PROVIDER_SETTINGS[target as SettingTarget]).toEqual({
        provider: values.provider,
        fallbackProvider: values.fallback_provider,
        fallbackOnFailure: values.fallback_on_failure,
      });
    }
    expect(SEARCH_PLATFORMS).toEqual([
      "threads",
      "tiktok",
      "instagram",
      "youtube",
      "reddit",
      "facebook",
      "linkedin",
      "x",
      "web",
    ]);
  });

  it("resolves only ScrapeAtlas and preserves disabled and unavailable platforms", () => {
    for (const target of SEARCH_PLATFORMS.filter((platform) => platform !== "web")) {
      expect(supportedProviders(target)).toEqual(["scrapeatlas"]);
      expect(resolveProviderChain(target, DEFAULT_PROVIDER_SETTINGS)).toEqual(["scrapeatlas"]);
      expect(validateProviderChoice(target, "off", null, false)).toBe(true);
      expect(validateProviderChoice(target, "off", "scrapecreators", false)).toBe(false);
      expect(validateProviderChoice(target, "scrapecreators", null, false)).toBe(false);
      expect(validateProviderChoice(target, "scrapeatlas", "scrapeatlas", true)).toBe(false);
    }
    expect(supportedProviders("web")).toEqual([]);
    expect(supportedProviders("x", "comments")).toEqual([]);
  });
});
