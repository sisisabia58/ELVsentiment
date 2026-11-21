import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS } from "@/monitor/search/filters";
import { parseOnboardingDraft, resolveOnboardingState } from "@/monitor/onboarding-draft";

vi.mock("@/auth/request-session", () => ({
  withSessionDeps: (fn: (deps: unknown) => unknown) =>
    fn({ db: {}, readSessionToken: async () => "synthetic-session-token" }),
}));
vi.mock("@/auth/session", () => ({
  customerIdFromSessionToken: async () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("@/monitor/search/limits", () => ({
  readSearchLimits: () => ({ cariDailySearchLimit: 20 }),
}));

import { startSearchAction } from "./start-action";

beforeEach(() => {
  vi.stubEnv("CARI_SEKARANG_ENABLED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startSearchAction input hardening", () => {
  it("returns a structured invalid_query instead of throwing for bad input", async () => {
    for (const input of [
      undefined,
      null,
      {},
      { query: undefined, filters: DEFAULT_FILTERS },
      { query: { text: "barayam" }, filters: DEFAULT_FILTERS },
      { query: 42, filters: DEFAULT_FILTERS },
      { query: "barayam", filters: null },
      { query: "bar\u0000ayam", filters: DEFAULT_FILTERS },
      { query: "\u200B\u200C\u200D\u2060\uFEFF", filters: DEFAULT_FILTERS },
    ] as unknown[]) {
      const result = await startSearchAction(input as never);
      expect(result).toEqual({ ok: false, error: "invalid_query" });
    }
  });
});

it("resumes a Cari origin and consent only in the initiating customer's fresh draft", () => {
  const customerId = "11111111-1111-4111-8111-111111111111";
  const originSearchId = "33333333-3333-4333-8333-333333333333";
  const draft = parseOnboardingDraft(JSON.stringify({
    customerId, projectId: null, step: 5, brand: "tukuliling kopi", keywords: ["tukuliling"],
    sources: ["threads"], schedule: { mode: "off", intervalHours: 6 }, originSearchId, importSearchPosts: true,
  }));
  const input = { fresh: true, langkah: "5", draft, customerId, existing: null, credentials: { x: false, threads: true } };
  expect(resolveOnboardingState(input)).toMatchObject({ originSearchId, importSearchPosts: true });
  expect(resolveOnboardingState({ ...input, fresh: false })).not.toHaveProperty("originSearchId");
  expect(resolveOnboardingState({ ...input, customerId: "different" })).not.toHaveProperty("originSearchId");
});
