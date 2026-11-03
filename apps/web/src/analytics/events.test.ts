import { describe, expect, it } from "vitest";
import { buildEvent } from "./events";

describe("buildEvent", () => {
  it("keeps ids and rejects post text", () => {
    expect(buildEvent("mention_collected", { projectId: "p1", source: "x" })).toEqual({
      name: "mention_collected",
      properties: { projectId: "p1", source: "x" },
    });
    expect(() => buildEvent("mention_collected", { excerpt: "rahasia" })).toThrow("forbidden_property");
  });
});
