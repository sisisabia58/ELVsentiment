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

  it("counts the empirical routes per platform and intent", () => {
    const phrase = { text: "kopi", intent: "phrase" as const };
    const hashtag = { text: "#kopi", intent: "hashtag" as const };
    expect(requestCount([phrase], ["threads"])).toBe(1);
    expect(requestCount([phrase], ["instagram"])).toBe(2);
    expect(requestCount([phrase], ["tiktok"])).toBe(3);
    expect(requestCount([hashtag], ["threads"])).toBe(1);
    expect(requestCount([hashtag], ["instagram"])).toBe(2);
    expect(requestCount([hashtag], ["tiktok"])).toBe(2);
    expect(requestCount([phrase], ["threads", "instagram", "tiktok"])).toBe(6);
    expect(requestCount([hashtag], ["threads", "instagram", "tiktok"])).toBe(5);
    expect(requestCount([phrase, hashtag], ["threads", "instagram", "tiktok"])).toBe(11);
    expect(requestCount([phrase], ["x"])).toBe(0);
  });
});
