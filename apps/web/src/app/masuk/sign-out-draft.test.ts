import { beforeEach, describe, expect, it, vi } from "vitest";

const sets = vi.hoisted(() => [] as { name: string; value: string; options?: Record<string, unknown> }[]);
const token = vi.hoisted(() => ({ value: "session-token" as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "sm_session" && token.value ? { name, value: token.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      sets.push({ name, value, options });
    },
  }),
  headers: async () => ({
    get: (name: string) => (name === "x-forwarded-proto" ? "https" : null),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("@/db/pg", () => ({
  withClient: vi.fn(async () => {
    throw new Error("database unavailable");
  }),
}));

import { signOutAction } from "./actions";

describe("sign out", () => {
  beforeEach(() => {
    sets.length = 0;
    token.value = "session-token";
  });

  it("clears the onboarding draft even when ending the session fails", async () => {
    await expect(signOutAction()).rejects.toThrow("REDIRECT:/masuk");
    const draft = sets.find((entry) => entry.name === "onboarding_draft");
    const session = sets.find((entry) => entry.name === "sm_session");
    expect(draft).toMatchObject({
      value: "",
      options: { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 },
    });
    expect(session).toMatchObject({
      value: "",
      options: { httpOnly: true, maxAge: 0 },
    });
  });

  it("clears the draft when there is no session token", async () => {
    token.value = undefined;
    await expect(signOutAction()).rejects.toThrow("REDIRECT:/masuk");
    expect(sets.some((entry) => entry.name === "onboarding_draft" && entry.options?.maxAge === 0)).toBe(true);
  });
});
