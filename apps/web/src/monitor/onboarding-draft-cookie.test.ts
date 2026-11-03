import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionCustomerId = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "customer-a"));
const sets = vi.hoisted(() => [] as { name: string; value: string; options?: Record<string, unknown> }[]);

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      sets.push({ name, value, options });
    },
  }),
  headers: async () => ({
    get: (name: string) => (name === "x-forwarded-proto" ? "https" : null),
  }),
}));

vi.mock("@/auth/request-session", () => ({
  sessionCustomerId,
}));

import { ONBOARDING_DRAFT_COOKIE } from "./onboarding-draft";
import { clearOnboardingDraftCookie, onboardingDraftCookieOptions, writeOnboardingDraftCookie } from "./onboarding-draft-cookie";

const fields = {
  projectId: null,
  step: 2,
  brand: "kopi susu",
  keywords: ["kopi susu"],
  sources: ["threads"] as ("x" | "threads")[],
  schedule: { mode: "off" as const, intervalHours: 6 },
};

describe("onboarding draft cookie", () => {
  beforeEach(() => {
    sets.length = 0;
    sessionCustomerId.mockReset();
    sessionCustomerId.mockResolvedValue("customer-a");
  });

  it("uses HttpOnly, SameSite=Lax, and Secure on HTTPS or in production", () => {
    expect(onboardingDraftCookieOptions({ nodeEnv: "production", forwardedProto: "http" })).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 604800,
      secure: true,
    });
    expect(onboardingDraftCookieOptions({ nodeEnv: "development", forwardedProto: "https" }).secure).toBe(true);
    expect(onboardingDraftCookieOptions({ nodeEnv: "development", protocol: "http", forwardedProto: "http" }).secure).toBe(
      false,
    );
  });

  it("stores the session customer and ignores a forged customer id", async () => {
    const wrote = await writeOnboardingDraftCookie({ ...fields, customerId: "intruder" } as typeof fields);
    expect(wrote).toBe(true);
    expect(sets).toHaveLength(1);
    const set = sets[0];
    expect(set?.name).toBe(ONBOARDING_DRAFT_COOKIE);
    expect(JSON.parse(set?.value ?? "")).toMatchObject({ customerId: "customer-a", brand: "kopi susu" });
    expect(JSON.parse(set?.value ?? "").customerId).not.toBe("intruder");
    expect(set?.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 604800 });
  });

  it("does not write a cookie without a session or when the draft is too large", async () => {
    sessionCustomerId.mockResolvedValueOnce(null);
    expect(await writeOnboardingDraftCookie(fields)).toBe(false);
    expect(sets).toHaveLength(0);

    sessionCustomerId.mockResolvedValueOnce("customer-a");
    expect(await writeOnboardingDraftCookie({ ...fields, brand: "m".repeat(161) })).toBe(false);
    expect(sets).toHaveLength(0);
  });

  it("does not store a langkah ahead of the fields the draft allows", async () => {
    const wrote = await writeOnboardingDraftCookie({ ...fields, step: 3, keywords: [] });
    expect(wrote).toBe(true);
    expect(JSON.parse(sets[0]?.value ?? "").step).toBe(2);
    expect(sets[0]?.options).toMatchObject({ httpOnly: true, maxAge: 604800 });
  });

  it("clears the cookie with the same flags", async () => {
    await clearOnboardingDraftCookie();
    expect(sets[0]).toMatchObject({
      name: ONBOARDING_DRAFT_COOKIE,
      value: "",
      options: { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 },
    });
  });
});
