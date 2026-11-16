// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireWorkspace } = vi.hoisted(() => ({
  requireWorkspace: vi.fn(async () => ({
    customerId: "11111111-1111-4111-8111-111111111111",
    now: new Date("2026-11-16T10:00:00Z"),
    workspace: { email: "owner@example.com" },
  })),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/monitor/session-page", () => ({ requireWorkspace }));
vi.mock("@/db/pg", () => ({ withClient: async (fn: (db: unknown) => Promise<unknown>) => fn({}) }));
vi.mock("@/monitor/search/load", () => ({ loadHistory: async () => [] }));
vi.mock("@/components/logout-form", () => ({ LogoutForm: () => null }));
vi.mock("@/components/monitor/bits", () => ({ PageHeader: () => null }));
vi.mock("@/components/monitor/shell", () => ({ Frame: () => null }));
vi.mock("@/components/monitor/cari/history-list", () => ({ HistoryList: () => null }));

import { RiwayatPageBody } from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
  requireWorkspace.mockClear();
});

describe("/cari/riwayat route guard", () => {
  it("is not found while the feature flag is off", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "false");
    await expect(RiwayatPageBody()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireWorkspace).not.toHaveBeenCalled();
  });

  it("renders when the flag is on", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "true");
    await expect(RiwayatPageBody()).resolves.toBeTruthy();
    expect(requireWorkspace).toHaveBeenCalledTimes(1);
  });
});
