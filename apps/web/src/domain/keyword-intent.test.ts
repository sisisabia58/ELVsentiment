import { describe, expect, it } from "vitest";
import { keywordLabel, normalizeHashtag, parseKeyword, requestCount } from "./keyword-intent";

describe("keyword intent", () => {
  it("keeps an explicit hashtag and does not convert a phrase", () => {
    expect(parseKeyword("  #Kopi   Kenangan ")).toEqual({ text: "#Kopi Kenangan", intent: "hashtag" });
    expect(parseKeyword("Kopi Kenangan")).toEqual({ text: "Kopi Kenangan", intent: "phrase" });
    expect(parseKeyword("#")).toEqual({ text: "#", intent: "phrase" });
  });

  it("normalizes a hashtag for provider requests", () => {
    expect(normalizeHashtag("#Kopi Kenangan!")).toBe("kopikenangan");
    expect(normalizeHashtag("  @kopi_kenangan ")).toBe("kopi_kenangan");
    expect(normalizeHashtag("#CAFÉ")).toBe("café");
  });

  it("labels intent in plain Indonesian", () => {
    expect(keywordLabel("phrase")).toBe("Kata kunci");
    expect(keywordLabel("hashtag")).toBe("Tagar");
  });

  it("counts keywords times fixed ScrapeCreators routes", () => {
    expect(
      requestCount(
        [
          { text: "kopi", intent: "phrase" },
          { text: "#kopi", intent: "hashtag" },
        ],
        ["threads", "instagram", "tiktok"],
      ),
    ).toBe(7);
    expect(requestCount([{ text: "kopi", intent: "phrase" }], ["x"])).toBe(0);
  });
});
