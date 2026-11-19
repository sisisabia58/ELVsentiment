import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/db/migrate";

const sessionCustomerId = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "customer-a"));
const sets = vi.hoisted(() => [] as { name: string; value: string; options?: Record<string, unknown> }[]);
const providerRows = vi.hoisted(() => [] as {
  platform: string;
  provider: string;
  fallback_provider: null;
  fallback_on_failure: false;
}[]);

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

vi.mock("@/db/pg", () => ({
  withClient: <T,>(fn: (db: Queryable) => Promise<T>) => fn({
    async query<Row>(sql: string) {
      if (!sql.includes("from provider_settings")) throw new Error(`Unexpected query: ${sql}`);
      return { rows: providerRows as unknown as Row[] };
    },
    async exec(sql: string) {
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  }),
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
    providerRows.length = 0;
    vi.stubEnv("SCRAPEATLAS_API_KEY", "synthetic");
    sessionCustomerId.mockReset();
    sessionCustomerId.mockResolvedValue("customer-a");
  });

  afterEach(() => vi.unstubAllEnvs());

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

  it("returns to source selection when the draft's selected route is disabled", async () => {
    providerRows.push({ platform: "threads", provider: "off", fallback_provider: null, fallback_on_failure: false });
    expect(await writeOnboardingDraftCookie({ ...fields, step: 5 })).toBe(true);
    expect(JSON.parse(sets[0]?.value ?? "").step).toBe(3);
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
