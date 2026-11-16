// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchSnapshot } from "@/monitor/search/load";
import { ProgressPanel } from "./progress-panel";
import { useSearchPoll } from "./use-search-poll";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const SEARCH_ID = "33333333-3333-4333-8333-333333333333";

function snapshot(overrides: Partial<SearchSnapshot> = {}): SearchSnapshot {
  return {
    search: {
      id: SEARCH_ID,
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
    sources: [],
    totals: { sources: 8, done: 4, results: 43, credits: 1 },
    results: [],
    comments: [],
    ai: null,
    questions: [],
    ...overrides,
  };
}

const states = [
  ["threads", "answered", 14, 3200],
  ["tiktok", "answered", 11, 4800],
  ["instagram", "searching", 0, null],
  ["youtube", "unavailable", 0, null],
  ["facebook", "queued", 0, null],
  ["x", "queued", 0, null],
  ["reddit", "failed", 0, null],
  ["web", "queued", 0, null],
] as const;

const snapshotWithStates = snapshot({
  sources: states.map(([platform, state, resultCount, latencyMs]) => ({
    platform,
    provider: "scrapeatlas",
    state,
    resultCount,
    latencyMs,
    creditsCharged: null,
    attemptedProviders: ["scrapeatlas"],
    safeDetail: state === "unavailable" ? "deadline" : "ok",
    updatedAt: "2026-11-16T10:00:10Z",
  })),
});

describe("ProgressPanel", () => {
  it("renders searching, answered, and unavailable source states", () => {
    render(<ProgressPanel snapshot={snapshotWithStates} now={new Date("2026-11-16T10:00:14Z")} />);
    expect(screen.getByText("Mencari sumber")).toBeTruthy();
    expect(screen.getAllByText("Selesai")).toHaveLength(2);
    expect(screen.getByText("Tidak tersedia")).toBeTruthy();
    expect(screen.getByText("Gagal")).toBeTruthy();
    expect(screen.getByText(/4\/8/)).toBeTruthy();
    expect(screen.queryByText(/kredit/)).toBeNull();
    expect(screen.getByText(/43 hasil/)).toBeTruthy();
    expect(screen.queryByText("Komentar")).toBeNull();
    expect(screen.queryByText("Ringkasan AI")).toBeNull();
  });

  it("shows only the known ledger credits, and nothing when unknown", () => {
    const known = {
      ...snapshotWithStates,
      sources: snapshotWithStates.sources.map((source, index) => ({
        ...source,
        creditsCharged: index < 2 ? 2 : null,
      })),
    };
    render(<ProgressPanel snapshot={known} now={new Date("2026-11-16T10:00:14Z")} />);
    expect(screen.getByText(/4 kredit/)).toBeTruthy();
  });

  it("hides elapsed time for a finished search that never started", () => {
    render(
      <ProgressPanel
        snapshot={snapshot({
          search: {
            ...snapshot().search,
            status: "failed",
            startedAt: null,
            finishedAt: "2026-11-16T10:00:40Z",
          },
        })}
        now={new Date("2026-11-16T10:00:40Z")}
      />,
    );
    expect(screen.queryByText(/dtk/)).toBeNull();
  });

  it("shows the finished summary and never renders provider credit numbers", () => {
    render(
      <ProgressPanel
        snapshot={snapshot({
          search: {
            ...snapshot().search,
            status: "succeeded",
            finishedAt: "2026-11-16T10:00:31Z",
            credits: 12,
          },
          totals: { sources: 8, done: 8, results: 65, credits: 12 },
        })}
        now={new Date("2026-11-16T10:00:31Z")}
      />,
    );
    expect(screen.getByText(/8\/8/)).toBeTruthy();
    expect(screen.queryByText(/12 kredit/)).toBeNull();
    expect(screen.queryByText(/kredit/)).toBeNull();
  });
});

describe("useSearchPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not poll when the initial search is already finished", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() =>
      useSearchPoll(
        SEARCH_ID,
        snapshot({ search: { ...snapshot().search, status: "succeeded" } }),
        { intervalMs: 1000 },
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("fetches the snapshot endpoint, updates state, and stops after completion", async () => {
    const running = snapshot();
    const done = snapshot({ search: { ...running.search, status: "succeeded" } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(done), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSearchPoll(SEARCH_ID, running, { intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/cari/${SEARCH_ID}`, expect.objectContaining({ cache: "no-store" }));
    expect(result.current.snapshot.search.status).toBe("succeeded");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last snapshot and flags a quiet retry on fetch failure", async () => {
    const running = snapshot();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSearchPoll(SEARCH_ID, running, { intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.snapshot).toEqual(running);
    expect(result.current.stale).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
