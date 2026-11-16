import { describe, expect, it } from "vitest";
import defaults from "../../../../../config/cari-providers.json";
import {
  DEFAULT_PROVIDER_SETTINGS,
  resolveProviderChain,
  SEARCH_PLATFORMS,
  supportedProviders,
  validateProviderChoice,
} from "./platforms";

describe("search provider matrix", () => {
  it("matches the shared JSON defaults", () => {
    expect(DEFAULT_PROVIDER_SETTINGS.youtube.provider).toBe("scrapeatlas");
    expect(DEFAULT_PROVIDER_SETTINGS.instagram.provider).toBe("scrapecreators");
    expect(DEFAULT_PROVIDER_SETTINGS.threads.fallbackOnFailure).toBe(false);
    expect(DEFAULT_PROVIDER_SETTINGS.comments.provider).toBe("scrapeatlas");
    expect(DEFAULT_PROVIDER_SETTINGS.web.provider).toBe("off");
    expect(defaults.threads.fallback_on_failure).toBe(false);
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

  it("blocks Instagram on ScrapeAtlas", () => {
    expect(supportedProviders("instagram", "keyword")).toEqual(["scrapecreators"]);
    expect(validateProviderChoice("instagram", "scrapeatlas", null, false)).toBe(false);
    expect(validateProviderChoice("youtube", "scrapeatlas", null, false)).toBe(true);
  });

  it("accepts off everywhere and rejects a fallback without a provider", () => {
    expect(validateProviderChoice("instagram", "off", null, false)).toBe(true);
    expect(validateProviderChoice("x", "off", null, false)).toBe(true);
    expect(validateProviderChoice("threads", "scrapecreators", null, true)).toBe(false);
    expect(validateProviderChoice("instagram", "scrapecreators", "scrapeatlas", true)).toBe(false);
    expect(validateProviderChoice("threads", "scrapecreators", "scrapeatlas", true)).toBe(true);
  });

  it("resolves chains only for supported providers and enabled fallbacks", () => {
    expect(resolveProviderChain("threads", DEFAULT_PROVIDER_SETTINGS)).toEqual(["scrapecreators"]);
    expect(resolveProviderChain("x", DEFAULT_PROVIDER_SETTINGS)).toEqual([]);
    expect(
      resolveProviderChain("threads", {
        ...DEFAULT_PROVIDER_SETTINGS,
        threads: {
          provider: "scrapecreators",
          fallbackProvider: "scrapeatlas",
          fallbackOnFailure: true,
        },
      }),
    ).toEqual(["scrapecreators", "scrapeatlas"]);
    expect(
      resolveProviderChain("youtube", {
        ...DEFAULT_PROVIDER_SETTINGS,
        youtube: {
          provider: "scrapeatlas",
          fallbackProvider: "scrapecreators",
          fallbackOnFailure: true,
        },
      }),
    ).toEqual(["scrapeatlas"]);
    expect(resolveProviderChain("threads", DEFAULT_PROVIDER_SETTINGS, "comments")).toEqual([
      "scrapeatlas",
    ]);
  });
});
