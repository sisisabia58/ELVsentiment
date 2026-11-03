// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/monitor/load";
import { MentionsScreen } from "./mentions-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

afterEach(cleanup);

function workspace(configured: boolean): Workspace {
  return {
    email: "rina@pakgembus.example",
    displayName: "Rina",
    initials: "R",
    projects: [],
    project: {
      id: "p1",
      name: "Kedai Contoh",
      initials: "KC",
      sources: ["x", "threads"],
      schedule: { mode: "off", intervalHours: 6 },
      nextRunAt: null,
      lastCollectedAt: null,
      keywordCount: 1,
    },
    projectMissing: false,
    mentions: [],
    sources: [
      { source: "x", state: configured ? "ready" : "unavailable", detail: "", lastSuccessAt: null, configured },
      { source: "threads", state: "unavailable", detail: "", lastSuccessAt: null, configured: false },
    ],
    jobs: [],
    pending: 0,
    failed: 0,
    latestStatus: null,
    lastCollectedAt: null,
    control: { manualBlocked: false, retryAt: null, lastSeenAt: null, inProgress: false },
    keywords: ["kedai"],
    topicLabels: [],
    topicCountingApproved: false,
    highImpact: false,
    credentials: { x: configured, threads: false },
  };
}

describe("mention empty state", () => {
  it("does not ask for a first run when collection cannot start", () => {
    render(<MentionsScreen workspace={workspace(false)} now="2026-11-01T00:00:00.000Z" mode="sebutan" page={1} range="7" source="" query="" />);
    expect(screen.getByText("Data akan muncul setelah pengumpulan aktif.")).toBeTruthy();
    expect(screen.queryByText("Jalankan pengumpulan pertama untuk melihat hasil.")).toBeNull();
  });

  it("still asks for a first run when a selected source can run", () => {
    render(<MentionsScreen workspace={workspace(true)} now="2026-11-01T00:00:00.000Z" mode="sebutan" page={1} range="7" source="" query="" />);
    expect(screen.getByText("Jalankan pengumpulan pertama untuk melihat hasil.")).toBeTruthy();
  });
});
