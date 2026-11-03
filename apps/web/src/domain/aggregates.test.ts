import { describe, expect, it } from "vitest";
import { overviewScore, topicCounts, trendTable } from "./aggregates";

describe("overviewScore", () => {
  it("returns empty when nothing is included", () => {
    expect(overviewScore({ positive: 0, negative: 0, neutral: 0 })).toEqual({ kind: "empty" });
  });

  it("uses the proposed formula when the denominator is non-empty", () => {
    expect(overviewScore({ positive: 3, negative: 1, neutral: 0 })).toEqual({
      kind: "score",
      value: 50,
      included: 4,
    });
  });
});

describe("trendTable", () => {
  it("counts a Jakarta civil day", () => {
    const rows = trendTable(
      [{ createdAt: new Date("2026-11-01T17:30:00.000Z"), sentiment: "negative" }],
      "day",
      "Asia/Jakarta",
    );
    expect(rows).toEqual([{ bucketStart: "2026-11-02", positive: 0, neutral: 0, negative: 1 }]);
  });
});

describe("topicCounts", () => {
  it("counts a mention once per label", () => {
    expect(topicCounts([{ topics: ["rasa", "harga"] }, { topics: ["harga"] }])).toEqual([
      { label: "harga", count: 2 },
      { label: "rasa", count: 1 },
    ]);
  });
});
