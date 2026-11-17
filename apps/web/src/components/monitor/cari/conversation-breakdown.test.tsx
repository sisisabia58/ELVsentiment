// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchSnapshot, SnapshotResult } from "@/monitor/search/load";
import { ConversationBreakdown } from "./conversation-breakdown";

afterEach(() => {
  cleanup();
});

function result(platform: string, index: number): SnapshotResult {
  return {
    id: `${platform}-${index}`,
    platform,
    externalId: `${platform}-${index}`,
    authorName: null,
    authorHandle: null,
    url: null,
    text: "hasil",
    title: null,
    publishedAt: null,
    thumbnailUrl: null,
    views: null,
    likes: null,
    replies: null,
    shares: null,
    language: "id",
    relevance: "literal_match",
    rank: index,
    collectedAt: "2026-11-16T10:00:00Z",
  };
}

const results = [
  ...Array.from({ length: 23 }, (_, index) => result("threads", index)),
  ...Array.from({ length: 6 }, (_, index) => result("tiktok", index)),
  ...Array.from({ length: 4 }, (_, index) => result("youtube", index)),
  ...Array.from({ length: 17 }, (_, index) => result("instagram", index)),
];

const doneSnapshot: SearchSnapshot = {
  search: {
    id: "33333333-3333-4333-8333-333333333333",
    query: "barayam",
    intent: "phrase",
    filters: { dateWindow: "all", sort: "relevance", language: "all" },
    status: "succeeded",
    summaryStatus: "done",
    overallStance: "campuran",
    errorCode: null,
    createdAt: "2026-11-16T10:00:00Z",
    startedAt: "2026-11-16T10:00:00Z",
    finishedAt: "2026-11-16T10:00:31Z",
  },
  sources: [],
  totals: { sources: 4, done: 4, results: results.length },
  results,
  comments: [],
  ai: {
    overallSummary: "Campuran.",
    overallStance: "campuran",
    platformSummaries: [
      { platform: "threads", stance: "positif", summary: "Pujian." },
      { platform: "tiktok", stance: "campuran", summary: "Campuran." },
      { platform: "youtube", stance: "negatif", summary: "Keluhan." },
      { platform: "instagram", stance: "netral", summary: "Netral." },
    ],
    quotes: [],
    themes: [],
    model: "scripted",
  },
  questions: [],
};

describe("ConversationBreakdown", () => {
  it("orders results before the breakdown and shows stance percentages", () => {
    render(<ConversationBreakdown snapshot={doneSnapshot} />);
    expect(screen.getByText("Bagaimana percakapannya")).toBeTruthy();
    expect(screen.getByText(/Positif 46%/)).toBeTruthy();
    expect(screen.getByText(/Campuran 12%/)).toBeTruthy();
    expect(screen.getByText(/Negatif 8%/)).toBeTruthy();
    expect(screen.getByText(/Netral 34%/)).toBeTruthy();
    expect(screen.getByText(/bukan survei/)).toBeTruthy();
  });

  it("links a quote to the result it came from", () => {
    const withQuote: SearchSnapshot = {
      ...doneSnapshot,
      results: [{ ...results[0], id: "r-quote", url: "https://example.invalid/sumber" }],
      ai: {
        ...doneSnapshot.ai!,
        quotes: [
          { type: "pujian", text: "enak banget", ref_id: "result:r-quote", platform: "threads", author: "rina" },
        ],
      },
    };
    render(<ConversationBreakdown snapshot={withQuote} />);
    const link = screen.getByRole("link", { name: "enak banget" });
    expect(link.getAttribute("href")).toBe("https://example.invalid/sumber");
  });
});
