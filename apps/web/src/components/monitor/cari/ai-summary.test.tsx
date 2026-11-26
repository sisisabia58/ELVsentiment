// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotAi, SnapshotComment, SnapshotResult } from "@/monitor/search/load";
import { AiSummary } from "./ai-summary";

afterEach(cleanup);

const aiFixture: SnapshotAi = {
  overallSummary: "Tukuliling memudahkan penumpang membeli kopi. Ada laporan mesin kosong.",
  overallStance: "campuran",
  overallSupportingIds: ["comment:c1", "result:r1", "comment:c1", "result:stale", "result:r2"],
  evidenceIds: ["comment:c1", "result:r1", "result:stale"],
  platformSummaries: [
    { platform: "threads", stance: "positif", summary: "Beli kopi tanpa antre.", supporting_ids: ["result:r1"] },
  ],
  quotes: [],
  themes: [],
  model: "demo",
};

const results = [
  { id: "r1", platform: "threads", url: "https://www.threads.net/@sari/post/EXAMPLE0001", text: "Tukuliling praktis.",
    authorHandle: "@sari", authorName: null, title: null },
  { id: "r2", platform: "youtube", url: "https://example.invalid/noise", text: "Kopi keliling.",
    authorHandle: "@pedagang", authorName: null, title: null },
] as SnapshotResult[];
const comments = [
  { id: "c1", resultId: "r1", platform: "threads", text: "Praktis sebelum naik kereta.",
    authorHandle: "@rina", authorName: "Rina" },
] as SnapshotComment[];

describe("AiSummary", () => {
  it("links only distinct retained sources, and counts the actual resolved sample", () => {
    render(<AiSummary ai={aiFixture} results={results} comments={comments} />);
    expect(screen.getByText(aiFixture.overallSummary)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /rina · Threads/ })).toHaveLength(1);
    const reply = screen.getByRole("link", { name: /rina · Threads/ });
    expect(reply.getAttribute("href")).toBe("#balasan-c1");
    expect(reply.getAttribute("target")).toBeNull();
    expect(screen.queryByRole("link", { name: /pedagang/ })).toBeNull();
    expect(screen.getByText(/1 unggahan dan 1 balasan/)).toBeTruthy();
    expect(screen.getByText(/^positif$/i)).toBeTruthy();
    expect(screen.queryByText(/Positif \d+%/)).toBeNull();
  });

  it.each([
    null,
    "https://[bad",
    "http://www.threads.net/@sari/post/EXAMPLE0001",
    "https://www.threads.net.fake.invalid/@sari/post/EXAMPLE0001",
    "https://user:secret@www.threads.net/@sari/post/EXAMPLE0001",
    "https://www.threads.net/@sari",
  ])("cites the exact reply locally without a verified parent permalink (%s)", (url) => {
    render(<AiSummary ai={aiFixture} results={[{ ...results[0], url }]} comments={comments} />);
    const reply = screen.getByRole("link", { name: /rina · Threads/ });
    expect(reply.getAttribute("href")).toBe("#balasan-c1");
    expect(reply.getAttribute("target")).toBeNull();
  });

  it("summary details reveal verified quotes only", () => {
    render(<AiSummary ai={{ ...aiFixture, quotes: [
      { type: "pujian", text: comments[0].text, ref_id: "comment:c1" },
      { type: "keluhan", text: "Kutipan tak terverifikasi", ref_id: "result:stale" },
      { type: "pengamatan", text: results[1].text, ref_id: "result:r2" },
    ] }} results={results} comments={comments} hasMoreResults />);
    expect(screen.getByText(aiFixture.overallSummary)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Sumber ringkasan" })).toBeTruthy();
    const details = screen.getByRole("button", { name: "Lihat detail ringkasan" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(details.getAttribute("aria-controls") ?? "");
    expect(panel?.classList.contains("hidden")).toBe(true);
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.classList.contains("hidden")).toBe(false);
    expect(screen.getByRole("link", { name: comments[0].text }).getAttribute("href")).toBe("#balasan-c1");
    expect(screen.queryByText("Kutipan tak terverifikasi")).toBeNull();
    expect(screen.queryByText(results[1].text)).toBeNull();
    expect(screen.queryByText("result:stale")).toBeNull();
  });

  it("shows pending, failure, and insufficient-evidence states", () => {
    const { rerender } = render(<AiSummary ai={null} summaryStatus="running" />);
    expect(screen.getByText(/Ringkasan ditulis setelah komentar terkumpul/)).toBeTruthy();
    rerender(<AiSummary ai={null} summaryStatus="failed" />);
    expect(screen.getByText(/Ringkasan belum tersedia/)).toBeTruthy();
    rerender(<AiSummary ai={null} summaryStatus="insufficient" />);
    expect(screen.getByText(/Belum cukup bukti/)).toBeTruthy();
  });

  it("does not show cached prose without verified citations", () => {
    render(<AiSummary ai={{ ...aiFixture, evidenceIds: [] }} results={results} comments={comments} />);
    expect(screen.getByText(/Ringkasan belum tersedia/)).toBeTruthy();
    expect(screen.queryByText(aiFixture.overallSummary)).toBeNull();
  });
});
