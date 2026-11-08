import { describe, expect, it } from "vitest";
import { textMatchCounts, textMatchOf } from "./relevance";
import type { PresentedMention } from "./present";

function mention(textMatch: PresentedMention["textMatch"]): PresentedMention {
  return { textMatch } as PresentedMention;
}

describe("text match", () => {
  it("maps association statuses to one honest result", () => {
    expect(textMatchOf([])).toBe("legacy_unassessed");
    expect(textMatchOf(["no_literal_match"])).toBe("no_literal_match");
    expect(textMatchOf(["no_literal_match", "literal_match"])).toBe("literal_match");
    expect(textMatchOf(["no_literal_match", "unknown_text"])).toBe("unknown_text");
  });

  it("counts candidates, literal matches, and undecided rows", () => {
    expect(
      textMatchCounts([
        mention("literal_match"),
        mention("no_literal_match"),
        mention("unknown_text"),
        mention("legacy_unassessed"),
      ]),
    ).toEqual({ candidates: 4, literal: 1, unknown: 2 });
  });
});
