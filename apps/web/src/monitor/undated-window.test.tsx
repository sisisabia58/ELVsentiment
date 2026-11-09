// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "@/components/dashboard-screen";
import { MentionsScreen } from "@/components/monitor/mentions-view";
import type { Workspace } from "@/monitor/load";
import { buildDashboard } from "@/monitor/dashboard";
import type { PresentedMention, Sentiment } from "@/monitor/present";
import type { TextMatch } from "@/monitor/relevance";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/sebutan",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const NOW = new Date("2026-11-09T01:00:00.000Z");
const IN_RANGE = "2026-11-09T00:30:00.000Z";

function mention(
  id: string,
  overrides: {
    postedAt?: string | null;
    collectedAt?: string;
    textMatch?: TextMatch;
    bucket?: PresentedMention["bucket"];
    sentiment?: Sentiment | null;
    needsAttention?: boolean;
    attentionUnread?: boolean;
  } = {},
): PresentedMention {
  return {
    id,
    source: "threads",
    excerpt: `excerpt ${id}`,
    url: null,
    authorLabel: "QA",
    handle: "@qa",
    initials: "Q",
    postedAt: overrides.postedAt === undefined ? IN_RANGE : overrides.postedAt,
    collectedAt: overrides.collectedAt ?? IN_RANGE,
    occurredAt: overrides.postedAt === undefined ? IN_RANGE : overrides.postedAt,
    read: false,
    bucket: overrides.bucket ?? "included",
    sentiment: overrides.sentiment === undefined ? "positive" : overrides.sentiment,
    relevance: "relevant",
    topics: [],
    relevanceConfidence: 0.9,
    sentimentConfidence: 0.9,
    corrected: false,
    confirmed: false,
    correctionAt: null,
    originalSentiment: null,
    originalRelevance: null,
    uncertainFields: [],
    needsAttention: overrides.needsAttention ?? false,
    attentionUnread: overrides.attentionUnread ?? false,
    attentionId: null,
    sourcePostUnavailable: false,
    scoringStatus: "succeeded",
    textMatch: overrides.textMatch ?? "literal_match",
  } as PresentedMention;
}

function workspace(mentions: PresentedMention[]): Workspace {
  return {
    email: "qa@example.com",
    displayName: "QA",
    initials: "Q",
    projects: [],
    project: {
      id: "p1",
      name: "QA Project",
      initials: "QP",
      sources: ["threads"],
      schedule: { mode: "off", intervalHours: 6 },
      nextRunAt: null,
      lastCollectedAt: null,
      keywordCount: 1,
    },
    projectMissing: false,
    mentions,
    sources: [
      { source: "threads", state: "ready", detail: "", lastSuccessAt: null, configured: true },
    ],
    jobs: [],
    pending: 0,
    failed: 0,
    latestStatus: null,
    lastCollectedAt: null,
    control: { manualBlocked: false, retryAt: null, lastSeenAt: null, inProgress: false },
    keywords: ["alpha"],
    keywordIntents: { alpha: "phrase" },
    topicLabels: [],
    topicCountingApproved: false,
    highImpact: false,
    credentials: { x: false, threads: true, instagram: false, tiktok: false },
  };
}

function dashboardFor(mentions: PresentedMention[]) {
  return buildDashboard({
    mentions,
    range: "7",
    source: "all",
    now: NOW,
    attentionUnread: mentions.filter((item) => item.attentionUnread).length,
    uncertainOpen: 0,
    partial: false,
  });
}

function renderSebutan(mentions: PresentedMention[], mode: "sebutan" | "perlu-perhatian" = "sebutan") {
  return render(
    <MentionsScreen
      workspace={workspace(mentions)}
      now={NOW.toISOString()}
      mode={mode}
      page={1}
      range="7"
      source=""
      query=""
    />,
  );
}

describe("undated mentions share one range rule", () => {
  it("counts undated rows consistently on dashboard and Sebutan and surfaces them in attention", () => {
    const mentions = [
      mention("dated-literal-1"),
      mention("dated-literal-2"),
      mention("dated-literal-3"),
      mention("dated-literal-4"),
      mention("dated-unknown", { textMatch: "unknown_text" }),
      mention("dated-no-match", { textMatch: "no_literal_match", sentiment: "negative", needsAttention: true }),
      mention("undated-literal-1", { postedAt: null }),
      mention("undated-literal-2", { postedAt: null }),
      mention("undated-negative", {
        postedAt: null,
        sentiment: "negative",
        needsAttention: true,
        attentionUnread: true,
      }),
    ];
    const model = dashboardFor(mentions);
    expect(model.textMatch).toEqual({ candidates: 9, literal: 7, unknown: 1 });
    expect(model.totals.negatif).toBe(2);
    expect(model.attentionInRange).toBe(2);
    expect(model.attentionItems.map((item) => item.id)).toContain("undated-negative");

    const sebutan = renderSebutan(mentions);
    expect(screen.getByText(/Kandidat 9 · Cocok teks 7 · Belum pasti 1/)).toBeTruthy();
    sebutan.unmount();

    render(
      <DashboardScreen
        brandName="QA Project"
        projectId="p1"
        from=""
        to=""
        source=""
        outcome="none"
        lastSuccess=""
        onRunNow={() => undefined}
        collection={null}
        model={model}
      />,
    );
    expect(screen.getByText(/Kandidat 9 · Cocok teks 7 · Belum pasti 1/)).toBeTruthy();
    expect(screen.getByText(/3 sebutan tanpa waktu posting/i)).toBeTruthy();
    expect(screen.getByText(/waktu pengumpulan/i)).toBeTruthy();
  });

  it("keeps an undated attention row visible in Perlu perhatian", () => {
    const mentions = [
      mention("dated-negative", { sentiment: "negative", needsAttention: true }),
      mention("undated-negative", { postedAt: null, sentiment: "negative", needsAttention: true }),
    ];
    renderSebutan(mentions, "perlu-perhatian");
    expect(screen.getByText("excerpt undated-negative")).toBeTruthy();
  });

  it("excludes an undated row collected outside the range from dashboard, Sebutan, and Perlu perhatian", () => {
    const mentions = [
      mention("dated-in-range"),
      mention("old-undated", {
        postedAt: null,
        collectedAt: "2020-01-01T00:00:00.000Z",
        sentiment: "negative",
        needsAttention: true,
      }),
    ];
    const model = dashboardFor(mentions);
    expect(model.textMatch).toEqual({ candidates: 1, literal: 1, unknown: 0 });
    expect(model.attentionInRange).toBe(0);
    expect(model.attentionItems).toEqual([]);

    renderSebutan(mentions);
    expect(screen.getByText(/Kandidat 1 · Cocok teks 1 · Belum pasti 0/)).toBeTruthy();
    expect(screen.queryByText("excerpt old-undated")).toBeNull();
    cleanup();

    renderSebutan(mentions, "perlu-perhatian");
    expect(screen.queryByText("excerpt old-undated")).toBeNull();
  });
});
