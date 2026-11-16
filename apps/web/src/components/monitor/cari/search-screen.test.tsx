// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchSnapshot, SnapshotResult } from "@/monitor/search/load";
import { SearchDetail } from "./search-screen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function post(overrides: Partial<SnapshotResult> = {}): SnapshotResult {
  return {
    id: "r1",
    platform: "threads",
    externalId: "th-1",
    authorName: "Rizky",
    authorHandle: "rizkyhdyt",
    url: "https://example.invalid/p/1",
    text: "antrean barayam ciledug tadi malem",
    title: null,
    publishedAt: "2026-11-15T09:00:00Z",
    thumbnailUrl: null,
    views: null,
    likes: 1200,
    replies: 2,
    shares: null,
    language: "id",
    relevance: "literal_match",
    rank: 1,
    collectedAt: "2026-11-16T10:00:00Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<SearchSnapshot> = {}): SearchSnapshot {
  const base: SearchSnapshot = {
    search: {
      id: "33333333-3333-4333-8333-333333333333",
      query: "barayam",
      intent: "phrase",
      filters: { dateWindow: "all", sort: "relevance", language: "all" },
      status: "running",
      summaryStatus: "pending",
      overallStance: null,
      credits: 1,
      errorCode: null,
      createdAt: "2026-11-16T10:00:00Z",
      startedAt: "2026-11-16T10:00:00Z",
      finishedAt: null,
    },
    sources: [
      {
        platform: "threads",
        provider: "scrapeatlas",
        state: "answered",
        resultCount: 1,
        latencyMs: 3200,
        creditsCharged: null,
        attemptedProviders: ["scrapeatlas"],
        safeDetail: "ok",
        updatedAt: "2026-11-16T10:00:03Z",
      },
      {
        platform: "youtube",
        provider: "scrapeatlas",
        state: "unavailable",
        resultCount: 0,
        latencyMs: null,
        creditsCharged: null,
        attemptedProviders: ["scrapeatlas"],
        safeDetail: "deadline",
        updatedAt: "2026-11-16T10:00:10Z",
      },
    ],
    totals: { sources: 8, done: 4, results: 43, credits: 1 },
    results: [post()],
    comments: [],
    ai: null,
    questions: [],
  };
  return { ...base, ...overrides };
}

function finishedSnapshot(): SearchSnapshot {
  const running = snapshot();
  return {
    ...running,
    search: {
      ...running.search,
      status: "succeeded",
      finishedAt: "2026-11-16T10:00:31Z",
    },
    totals: { sources: 8, done: 7, results: 65, credits: 1 },
  };
}

describe("SearchDetail", () => {
  it("shows the command receipt, progress before completion, and results after", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { rerender } = render(<SearchDetail initialSnapshot={snapshot()} />);
    expect(screen.getByText(/cari "barayam"/)).toBeTruthy();
    expect(screen.getByText(/Sedang berjalan/)).toBeTruthy();
    expect(screen.getByText("Mencari sumber")).toBeTruthy();
    expect(screen.getByText("Hasil")).toBeTruthy();

    rerender(<SearchDetail initialSnapshot={finishedSnapshot()} />);
    expect(screen.getByText(/7 dari 8 sumber menjawab/)).toBeTruthy();
    expect(screen.getByText("Hasil")).toBeTruthy();
    expect(screen.getByText(/antrean barayam/)).toBeTruthy();
  });

  it("never names a raw provider to the end user", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<SearchDetail initialSnapshot={finishedSnapshot()} />);
    expect(screen.queryByText(/ScrapeAtlas/i)).toBeNull();
    expect(screen.queryByText(/ScrapeCreators/i)).toBeNull();
    expect(screen.queryByText(/scrapeatlas/i)).toBeNull();
  });

  it("renders a finished partial search without pretending every source answered", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const partial = finishedSnapshot();
    partial.search.status = "partial";
    partial.totals = { sources: 8, done: 6, results: 20, credits: 1 };
    render(<SearchDetail initialSnapshot={partial} />);
    expect(screen.getByText(/6 dari 8 sumber menjawab/)).toBeTruthy();
  });
});
