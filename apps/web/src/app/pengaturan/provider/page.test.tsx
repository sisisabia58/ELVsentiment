// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  frame: vi.fn((props: { children?: ReactNode }) => props.children),
  requireWorkspace: vi.fn(async () => ({
    customerId: "11111111-1111-4111-8111-111111111111",
    now: new Date("2026-11-16T10:00:00Z"),
    workspace: { email: "admin@example.com" },
  })),
  isAdminEmail: vi.fn(() => true),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("REDIRECT");
  },
}));
vi.mock("@/monitor/session-page", () => ({ requireWorkspace: mocks.requireWorkspace }));
vi.mock("@/db/pg", () => ({ withClient: async (fn: (db: unknown) => Promise<unknown>) => fn({}) }));
vi.mock("@/db/migrate", () => ({
  withCustomer: async (_db: unknown, _customerId: string, fn: () => unknown) => fn(),
}));
vi.mock("@/auth/admin", () => ({
  adminEmailForCustomer: async () => "admin@example.com",
  isAdminEmail: mocks.isAdminEmail,
}));
vi.mock("@/auth/request-session", () => ({
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
  mocks.frame.mockClear();
  mocks.requireWorkspace.mockClear();
  mocks.isAdminEmail.mockReset();
  mocks.isAdminEmail.mockReturnValue(true);
});

describe("/pengaturan/provider page", () => {
  it("renders the admin form inside the app frame", async () => {
    render(await ProviderPageBody());
    expect(mocks.requireWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.frame).toHaveBeenCalledTimes(1);
    expect(mocks.frame.mock.calls[0][0]).toMatchObject({ active: "/pengaturan/provider" });
  });

  it("keeps the non-admin message inside the app frame", async () => {
    mocks.isAdminEmail.mockReturnValue(false);
    render(await ProviderPageBody());
    expect(screen.getByText(/tidak berwenang/i)).toBeTruthy();
    expect(mocks.frame).toHaveBeenCalledTimes(1);
  });
});
