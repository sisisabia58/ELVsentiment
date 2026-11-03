import { describe, expect, it } from "vitest";
import { generateCandidates, normalizeVariant, validateVariantList } from "./variants";

function members(phrases: string[]): string[] {
  return [...phrases].sort();
}

const fourTokenPhrases = [
  "ayam geprek gembus",
  "ayam geprek pak",
  "ayam geprek pak gembus",
  "ayam pak gembus",
  "geprek gembus",
  "geprek pak",
  "geprek pak gembus",
  "pak gembus",
];

describe("generateCandidates", () => {
  it("normalizes Indonesian whitespace and case", () => {
    expect(normalizeVariant("  Ayam   Geprek ")).toBe("ayam geprek");
  });

  it("includes the spec examples for ayam geprek pak gembus", () => {
    const found = generateCandidates("ayam geprek pak gembus");
    expect(found).toContain("ayam geprek pak gembus");
    expect(found).toContain("geprek pak gembus");
    expect(found).toContain("geprek gembus");
    expect(found).toContain("ayam pak gembus");
    expect(found).not.toContain("tempe gembus");
  });

  it("returns no candidates for a blank name", () => {
    expect(generateCandidates("   ")).toEqual([]);
  });

  it("returns no candidates for an empty name", () => {
    expect(normalizeVariant("")).toBe("");
    expect(generateCandidates("")).toEqual([]);
    expect(generateCandidates("\n\t")).toEqual([]);
  });

  it("builds candidates from the normalized name", () => {
    expect(members(generateCandidates("  AYAM \u00A0 geprek\tpak\nGEMBUS "))).toEqual(
      fourTokenPhrases,
    );
  });

  it("returns only the normalized name for one token", () => {
    expect(generateCandidates("  Ayam ")).toEqual(["ayam"]);
  });

  it("does not emit a one-token deletion when only two tokens remain", () => {
    expect(generateCandidates("Ayam Geprek")).toEqual(["ayam geprek"]);
  });

  it("deletes exactly one token from a three-token name", () => {
    expect(members(generateCandidates("ayam geprek pak"))).toEqual([
      "ayam geprek",
      "ayam geprek pak",
      "ayam pak",
      "geprek pak",
    ]);
  });

  it("adds the extra deletion pass for four or more tokens and no other phrases", () => {
    expect(members(generateCandidates("ayam geprek pak gembus"))).toEqual(fourTokenPhrases);
    expect(members(generateCandidates("ayam geprek pak gembus pedas"))).toEqual([
      "ayam geprek gembus pedas",
      "ayam geprek pak gembus",
      "ayam geprek pak gembus pedas",
      "ayam geprek pak pedas",
      "ayam pak gembus pedas",
      "geprek gembus pedas",
      "geprek pak gembus",
      "geprek pak gembus pedas",
      "geprek pak pedas",
      "pak gembus pedas",
    ]);
  });

  it("keeps one copy of a phrase produced by more than one deletion", () => {
    expect(generateCandidates("ayam ayam ayam")).toEqual(["ayam ayam ayam", "ayam ayam"]);
  });
});

describe("normalizeVariant", () => {
  it("lowercases capital I with Indonesian rules", () => {
    expect(normalizeVariant("I")).toBe("i");
    expect(normalizeVariant("INDOMIE")).toBe("indomie");
  });

  it("does not apply Turkish casing to dotted capital I", () => {
    expect(normalizeVariant("\u0130")).toBe("i\u0307");
  });

  it("collapses unicode whitespace to one space", () => {
    expect(normalizeVariant("  Ayam\u00A0\n\tGeprek ")).toBe("ayam geprek");
  });

  it("does not treat a zero-width space as whitespace", () => {
    expect(normalizeVariant("ayam\u200Bgeprek")).toBe("ayam\u200Bgeprek");
  });

  it("keeps punctuation attached to the neighboring token", () => {
    expect(normalizeVariant("Ayam,   Geprek!")).toBe("ayam, geprek!");
    expect(generateCandidates("Pak Gembus!")).toEqual(["pak gembus!"]);
  });

  it("lowercases non-ASCII letters", () => {
    expect(normalizeVariant("CAFÉ")).toBe("café");
  });
});

describe("validateVariantList", () => {
  it("rejects an empty variant", () => {
    expect(validateVariantList(["geprek gembus", "   "])).toEqual({
      ok: false,
      reason: "empty",
      value: "   ",
    });
  });

  it("rejects a duplicate after normalization", () => {
    expect(validateVariantList(["Geprek Gembus", "geprek   gembus"])).toEqual({
      ok: false,
      reason: "duplicate",
      value: "geprek   gembus",
    });
  });

  it("rejects a variant longer than the X query limit", () => {
    const value = "a".repeat(513);
    expect(validateVariantList([value])).toEqual({ ok: false, reason: "too_long", value });
  });

  it("returns the normalized active set", () => {
    expect(validateVariantList(["Geprek Gembus", "Ayam Pak Gembus"])).toEqual({
      ok: true,
      variants: ["geprek gembus", "ayam pak gembus"],
    });
  });
});
