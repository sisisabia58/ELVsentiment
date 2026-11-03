import { describe, expect, it } from "vitest";
import { effectOfKeywordEdit } from "./keyword-history";

describe("effectOfKeywordEdit", () => {
  it("keeps the new queries and never reclassifies stored mentions", () => {
    const effect = effectOfKeywordEdit(["geprek gembus", "ayam pak gembus"]);
    expect(effect.futureQueries).toEqual(["geprek gembus", "ayam pak gembus"]);
    expect(effect.reclassifyExisting).toBe(false);
  });
});
