// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  order: [] as string[],
  flag: false,
  requireWorkspace: vi.fn(async () => ({
    customerId: "11111111-1111-4111-8111-111111111111",
    now: new Date("2026-11-16T10:00:00Z"),
    workspace: { email: "owner@example.com" },
  })),
}));

vi.mock("next/server", () => ({
  connection: async () => {
    state.order.push("connection");
  },
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    state.order.push("notFound");
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/monitor/search/feature", () => ({
  cariSekarangEnabled: () => {
    state.order.push("flag");
    return state.flag;
  },
  cariProviderMode: () => "live",
  cariAiProvider: () => "demo",
}));
vi.mock("@/monitor/session-page", () => ({ requireWorkspace: state.requireWorkspace }));
vi.mock("@/db/pg", () => ({ withClient: async (fn: (db: unknown) => Promise<unknown>) => fn({}) }));
vi.mock("@/monitor/search/load", () => ({ loadHistory: async () => [] }));
vi.mock("@/components/logout-form", () => ({ LogoutForm: () => null }));
vi.mock("@/components/monitor/bits", () => ({ PageHeader: () => null }));
vi.mock("@/components/monitor/shell", () => ({ Frame: () => null }));
vi.mock("@/components/monitor/cari/search-screen", () => ({ SearchScreen: () => null }));

import { CariPageBody } from "./page";

afterEach(() => {
  state.order = [];
  state.flag = false;
  state.requireWorkspace.mockClear();
});

describe("/cari route guard", () => {
  it("awaits connection before checking the flag, so the 404 is per request", async () => {
    state.flag = false;
    await expect(CariPageBody()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.order).toEqual(["connection", "flag", "notFound"]);
    expect(state.requireWorkspace).not.toHaveBeenCalled();
  });

  it("renders when the flag is on", async () => {
    state.flag = true;
    await expect(CariPageBody()).resolves.toBeTruthy();
    expect(state.order).toEqual(["connection", "flag"]);
    expect(state.requireWorkspace).toHaveBeenCalledTimes(1);
  });
});
