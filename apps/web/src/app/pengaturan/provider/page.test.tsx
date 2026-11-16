// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flag: true,
  order: [] as string[],
  frame: vi.fn((props: { children?: ReactNode }) => props.children),
  requireWorkspace: vi.fn(async () => ({
    customerId: "11111111-1111-4111-8111-111111111111",
    now: new Date("2026-11-16T10:00:00Z"),
    workspace: { email: "admin@example.com" },
  })),
  platformAdmin: vi.fn(async (): Promise<{ userId: string; email: string } | null> => ({
    userId: "22222222-2222-4222-8222-222222222222",
    email: "admin@example.com",
  })),
}));

vi.mock("next/server", () => ({
  connection: async () => {
    mocks.order.push("connection");
  },
}));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("REDIRECT");
  },
  notFound: () => {
    mocks.order.push("notFound");
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/monitor/search/feature", () => ({
  cariSekarangEnabled: () => {
    mocks.order.push("flag");
    return mocks.flag;
  },
}));
vi.mock("@/monitor/session-page", () => ({ requireWorkspace: mocks.requireWorkspace }));
vi.mock("@/db/pg", () => ({ withClient: async (fn: (db: unknown) => Promise<unknown>) => fn({}) }));
vi.mock("@/auth/admin", () => ({
  platformAdminForSession: mocks.platformAdmin,
  sessionTokenHash: (token: string) => `hash:${token}`,
}));
vi.mock("@/auth/request-session", () => ({
  readSessionToken: async () => "session-token",
  sessionCustomerId: async () => "11111111-1111-4111-8111-111111111111",
  withSessionDeps: (fn: (deps: unknown) => unknown) => fn({}),
}));
vi.mock("@/monitor/search/provider-settings", () => ({
  loadProviderSettingRows: async () => [],
}));
vi.mock("@/components/monitor/cari/provider-settings-form", () => ({
  ProviderSettingsForm: () => null,
}));
vi.mock("@/components/logout-form", () => ({ LogoutForm: () => null }));
vi.mock("@/components/monitor/bits", () => ({ PageHeader: () => null }));
vi.mock("@/components/monitor/shell", () => ({ Frame: mocks.frame }));
vi.mock("./actions", () => ({ saveProviderSettingAction: vi.fn() }));

import { ProviderPageBody } from "./page";

afterEach(() => {
  cleanup();
  mocks.order = [];
  mocks.frame.mockClear();
  mocks.requireWorkspace.mockClear();
  mocks.platformAdmin.mockReset();
  mocks.platformAdmin.mockResolvedValue({
    userId: "22222222-2222-4222-8222-222222222222",
    email: "admin@example.com",
  });
  mocks.flag = true;
});

describe("/pengaturan/provider page", () => {
  it("renders the admin form inside the app frame", async () => {
    render(await ProviderPageBody());
    expect(mocks.requireWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.frame).toHaveBeenCalledTimes(1);
    expect(mocks.frame.mock.calls[0][0]).toMatchObject({ active: "/pengaturan/provider" });
  });

  it("awaits connection before the flag, so a flag-off build is not a static 404", async () => {
    mocks.flag = false;
    await expect(ProviderPageBody()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.order).toEqual(["connection", "flag", "notFound"]);
    expect(mocks.requireWorkspace).not.toHaveBeenCalled();
    expect(mocks.frame).not.toHaveBeenCalled();
  });

  it("is a not-found for a signed-in non-admin", async () => {
    mocks.platformAdmin.mockResolvedValue(null);
    await expect(ProviderPageBody()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.frame).not.toHaveBeenCalled();
  });
});
