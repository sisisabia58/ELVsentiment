import { describe, expect, it } from "vitest";
import fixtures from "../../../../worker/tests/fixtures/scrapeatlas/relevance.json";
import { savedEvidenceRelevance } from "./relevance";

describe("saved search evidence relevance", () => {
  it.each(fixtures.filter((example) => example.hashtags.length === 0))(
    "$query · $text · $title",
    ({ query, intent, text, title, expected }) => {
      expect(savedEvidenceRelevance({ text, title }, query, intent)).toBe(
        expected === "no_match" ? null : expected,
      );
    },
  );

  it("cannot infer a hashtag from unavailable provider metadata", () => {
    expect(savedEvidenceRelevance({ text: "Mesinnya kosong lagi.", title: null }, "tukuliling kopi", "phrase")).toBeNull();
  });

  it("requires rerunning a legacy match that depends on Greek iota-subscript case folding", () => {
    expect(savedEvidenceRelevance({ text: "ᾼρτος", title: null }, "αιρτος", "phrase")).toBeNull();
  });
});
