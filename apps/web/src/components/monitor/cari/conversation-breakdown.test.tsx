// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchSnapshot, SnapshotComment, SnapshotResult } from "@/monitor/search/load";
import { ConversationBreakdown } from "./conversation-breakdown";
import { evidenceSources, supportedPlatforms, supportedQuotes, supportedThemes } from "./quote-source";

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
  comments: [
    { id: "c1", resultId: "threads-0", platform: "threads", authorName: "Rina", authorHandle: "@rina",
      text: "Praktis sebelum naik kereta." },
    { id: "c2", resultId: "threads-0", platform: "threads", authorName: "Ayu", authorHandle: "@ayu",
      text: "Praktis sebelum naik kereta." },
  ] as SnapshotComment[],
  ai: {
    overallSummary: "Campuran.",
    overallStance: "campuran",
    overallSupportingIds: ["result:threads-0"],
    evidenceIds: ["result:threads-0", "result:tiktok-0", "comment:c1", "comment:c2", "comment:missing"],
    platformSummaries: [
      { platform: "threads", stance: "positif", summary: "Pujian.", supporting_ids: ["comment:c1"] },
      { platform: "tiktok", stance: "campuran", summary: "Campuran.", supporting_ids: ["result:threads-0"] },
    ],
    quotes: [
      { type: "pujian", text: "Praktis sebelum naik kereta.", ref_id: "comment:c1", author: "Bukan Rina", platform: "youtube" },
      { type: "keluhan", text: "Parafrasa", ref_id: "comment:c1" },
      { type: "pengamatan", text: "Praktis sebelum naik kereta.", ref_id: "comment:c2" },
      { type: "pertanyaan", text: "Kutipan hilang?", ref_id: "comment:missing" },
      { type: "pertanyaan", text: "hasil", ref_id: "result:threads-2" },
    ],
    themes: [
      { title: "Praktis di MRT", stance: "positif", description: "Beli sebelum naik kereta.",
        supporting_ids: ["comment:c1", "comment:c1", "result:threads-0", "result:threads-2", "comment:missing"],
        platforms: ["youtube"] },
      { title: "Kafe lain", stance: "netral", description: "Tidak terkait.",
        supporting_ids: ["result:threads-2"] },
    ],
    model: "scripted",
  },
  questions: [],
};

function renderBreakdown() {
  const ai = doneSnapshot.ai!;
  const sample = evidenceSources(ai.evidenceIds, results, doneSnapshot.comments);
  return render(<ConversationBreakdown
    results={results}
    platforms={supportedPlatforms(ai, sample)}
    quotes={supportedQuotes(ai, sample)}
    themes={supportedThemes(ai, sample)}
  />);
}

describe("ConversationBreakdown", () => {
  it("keeps the result counts separate from qualitative platform stance", () => {
    renderBreakdown();
    expect(screen.getByText("Bagaimana percakapannya")).toBeTruthy();
    expect(screen.getByText("23")).toBeTruthy();
    expect(screen.getByText("Sikap per platform")).toBeTruthy();
    expect(screen.getAllByText(/^positif$/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^campuran$/i)).toBeNull();
    expect(screen.queryByText(/Positif \d+%/)).toBeNull();
  });

  it("shows distinct categorized word-for-word quotes linked to the exact reply", () => {
    renderBreakdown();
    expect(screen.getByText("Kutipan")).toBeTruthy();
    expect(screen.getByText("Pujian")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Praktis sebelum naik kereta." })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Praktis sebelum naik kereta." }).getAttribute("href")).toBe("#balasan-c1");
    expect(screen.getAllByText(/rina · Threads/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("Parafrasa")).toBeNull();
    expect(screen.queryByText("Bukan Rina")).toBeNull();
    expect(screen.queryByText("Pengamatan")).toBeNull();
    expect(screen.queryByText("Keluhan")).toBeNull();
    expect(screen.queryByText("Pertanyaan")).toBeNull();
  });

  it("counts distinct retained evidence and derives theme platforms from it", () => {
    renderBreakdown();
    expect(screen.getByText("Topik utama")).toBeTruthy();
    expect(screen.getByText("Praktis di MRT")).toBeTruthy();
    expect(screen.getByText("Beli sebelum naik kereta.")).toBeTruthy();
    expect(screen.getByText("2 unggahan dan balasan · Threads")).toBeTruthy();
    expect(screen.queryByText("Kafe lain")).toBeNull();
  });
});
