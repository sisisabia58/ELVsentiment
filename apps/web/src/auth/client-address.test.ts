import { describe, expect, it } from "vitest";
import { clientAddressFrom } from "./client-address";

describe("client address", () => {
  it("uses the first forwarded address, then the real ip", () => {
    expect(clientAddressFrom("203.0.113.8, 10.0.0.1", "198.51.100.2")).toBe("203.0.113.8");
    expect(clientAddressFrom(null, "198.51.100.2")).toBe("198.51.100.2");
    expect(clientAddressFrom("   ", "  ")).toBe("");
  });
});
