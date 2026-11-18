import { describe, expect, it } from "vitest";
import { buildOnboardingFields } from "./present";

describe("buildOnboardingFields", () => {
  it("prefills the query and only project-supported sources", () => {
    const fields = buildOnboardingFields(
      { query: "barayam", platforms: ["threads", "tiktok", "youtube", "facebook"] },
      ["threads", "tiktok", "instagram"],
    );
    expect(fields.brand).toBe("barayam");
    expect(fields.keywords).toEqual(["barayam"]);
    expect(fields.sources).toEqual(["threads", "tiktok"]);
    expect(fields.schedule).toEqual({ mode: "off", intervalHours: 6 });
  });
});
