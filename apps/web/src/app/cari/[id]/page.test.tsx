// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireWorkspace, loadSearchSnapshot } = vi.hoisted(() => ({
  requireWorkspace: vi.fn(async () => ({
    customerId: "11111111-1111-4111-8111-111111111111",
    now: new Date("2026-11-16T10:00:00Z"),
    workspace: { email: "owner@example.com" },
  })),
  loadSearchSnapshot: vi.fn(async () => null as unknown),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/monitor/session-page", () => ({ requireWorkspace }));
vi.mock("@/db/pg", () => ({ withClient: async (fn: (db: unknown) => Promise<unknown>) => fn({}) }));
vi.mock("@/monitor/search/load", () => ({ loadSearchSnapshot }));
vi.mock("@/components/logout-form", () => ({ LogoutForm: () => null }));
vi.mock("@/components/monitor/bits", () => ({ EmptyState: () => null }));
vi.mock("@/components/monitor/shell", () => ({ Frame: () => null }));
vi.mock("@/components/monitor/cari/search-screen", () => ({ SearchDetail: () => null }));

import { CariDetailPageBody } from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
  requireWorkspace.mockClear();
  loadSearchSnapshot.mockClear();
});

describe("/cari/[id] route", () => {
  it("is not found while the feature flag is off", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "0");
    await expect(CariDetailPageBody({ id: "search-1" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadSearchSnapshot).not.toHaveBeenCalled();
  });

  it("renders the empty state for a foreign or unknown id without leaking data", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "1");
    await expect(CariDetailPageBody({ id: "foreign" })).resolves.toBeTruthy();
    expect(loadSearchSnapshot).toHaveBeenCalledWith(expect.anything(), expect.any(String), "foreign");
  });
});
