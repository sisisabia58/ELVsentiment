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
  loadSearchSnapshot: vi.fn(async () => null as unknown),
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
vi.mock("@/monitor/search/load", () => ({ loadSearchSnapshot: state.loadSearchSnapshot }));
vi.mock("@/components/logout-form", () => ({ LogoutForm: () => null }));
vi.mock("@/components/monitor/bits", () => ({ EmptyState: () => null }));
vi.mock("@/components/monitor/shell", () => ({ Frame: () => null }));
vi.mock("@/components/monitor/cari/search-screen", () => ({ SearchDetail: () => null }));

import { CariDetailPageBody } from "./page";

afterEach(() => {
  state.order = [];
  state.flag = false;
  state.requireWorkspace.mockClear();
  state.loadSearchSnapshot.mockClear();
});

describe("/cari/[id] route", () => {
  it("awaits connection before checking the flag, even though params are dynamic", async () => {
    state.flag = false;
    await expect(CariDetailPageBody({ id: "search-1" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(state.order).toEqual(["connection", "flag", "notFound"]);
    expect(state.loadSearchSnapshot).not.toHaveBeenCalled();
  });

  it("renders the empty state for a foreign or unknown id without leaking data", async () => {
    state.flag = true;
    await expect(CariDetailPageBody({ id: "foreign" })).resolves.toBeTruthy();
    expect(state.loadSearchSnapshot).toHaveBeenCalledWith(expect.anything(), expect.any(String), "foreign");
  });
});
