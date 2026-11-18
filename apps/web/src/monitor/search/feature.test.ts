import { describe, expect, it } from "vitest";
import { cariAiProvider, cariAiUiEnabled, cariProviderMode, cariSekarangEnabled } from "./feature";

describe("cari sekarang feature flags", () => {
  it("enables only the explicit 1/true values", () => {
    expect(cariSekarangEnabled({ CARI_SEKARANG_ENABLED: "1" })).toBe(true);
    expect(cariSekarangEnabled({ CARI_SEKARANG_ENABLED: "true" })).toBe(true);
    expect(cariSekarangEnabled({ CARI_SEKARANG_ENABLED: " TRUE " })).toBe(true);
    expect(cariSekarangEnabled({ CARI_SEKARANG_ENABLED: "0" })).toBe(false);
    expect(cariSekarangEnabled({ CARI_SEKARANG_ENABLED: "false" })).toBe(false);
    expect(cariSekarangEnabled({ CARI_SEKARANG_ENABLED: "yes" })).toBe(false);
    expect(cariSekarangEnabled({ CARI_SEKARANG_ENABLED: "" })).toBe(false);
    expect(cariSekarangEnabled({})).toBe(false);
  });

  it("defaults provider mode to live and AI to demo", () => {
    expect(cariProviderMode({})).toBe("live");
    expect(cariAiProvider({})).toBe("demo");
    expect(cariProviderMode({ CARI_PROVIDER_MODE: "fixture" })).toBe("fixture");
    expect(cariAiProvider({ CARI_AI_PROVIDER: "gemini" })).toBe("gemini");
  });

  it("hides AI answer UI while the provider is demo", () => {
    expect(cariAiUiEnabled({})).toBe(false);
    expect(cariAiUiEnabled({ CARI_AI_PROVIDER: "" })).toBe(false);
    expect(cariAiUiEnabled({ CARI_AI_PROVIDER: " demo " })).toBe(false);
    expect(cariAiUiEnabled({ CARI_AI_PROVIDER: "gemini" })).toBe(true);
    expect(cariAiProvider({ CARI_AI_PROVIDER: "opencode" })).toBe("opencode");
    expect(cariAiUiEnabled({ CARI_AI_PROVIDER: "opencode" })).toBe(true);
  });
});
