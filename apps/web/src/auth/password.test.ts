import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

// Legacy hashes are `scrypt$salt$hash` at Node's old default cost (N=16384, r=8, p=1).
const LEGACY = "scrypt$00112233445566778899aabbccddeeff$77ae300391964a337b60ecef96793cfcacdd09665e05e9ad9c366ded5d94cd2c";

describe("password hashing", () => {
  it("stores the scrypt cost and verifies with those parameters", async () => {
    const stored = await hashPassword("sandi-panjang");
    expect(stored.startsWith("scrypt$131072$8$1$")).toBe(true);
    expect(await verifyPassword("sandi-panjang", stored)).toBe(true);
    expect(await verifyPassword("salah", stored)).toBe(false);
  });

  it("still verifies a legacy hash that omitted the cost", async () => {
    expect(await verifyPassword("sandi-panjang", LEGACY)).toBe(true);
    expect(await verifyPassword("salah", LEGACY)).toBe(false);
  });
});
