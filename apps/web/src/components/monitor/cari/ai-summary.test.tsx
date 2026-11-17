// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotAi } from "@/monitor/search/load";
import { AiSummary } from "./ai-summary";

afterEach(() => {
  cleanup();
});

const aiFixture: SnapshotAi = {
  overallSummary: "Orang memuji kulitnya, tapi sebagian komplain antrean.",
  overallStance: "campuran",
  platformSummaries: [
    { platform: "threads", stance: "campuran", summary: "Campuran.", quote_id: "comment:c1" },
  ],
  quotes: [
    { type: "pujian", text: "kriuknya beda sih", ref_id: "comment:c1", platform: "threads", author: "rina" },
  ],
  themes: [{ title: "Rasa bawang putih & kulit kriuk", stance: "positif", description: "Rasa.", supporting_ids: [], platforms: ["threads"] }],
  model: "demo",
};

describe("AiSummary", () => {
  it("renders the overall summary, stance rows, quotes, themes, and disclaimer", () => {
    render(<AiSummary ai={aiFixture} resultCount={12} commentCount={4} />);
    expect(screen.getByText("Ringkasan AI")).toBeTruthy();
    expect(screen.getByText(/bisa keliru, cek kutipannya/)).toBeTruthy();
    expect(screen.getByText("Campuran")).toBeTruthy();
    expect(screen.getByText("kriuknya beda sih")).toBeTruthy();
    expect(screen.getByText("Rasa bawang putih & kulit kriuk")).toBeTruthy();
  });

  it("renders each summary paragraph on its own", () => {
    render(
      <AiSummary
        ai={{
          ...aiFixture,
          overallSummary: "Gambaran umum percakapan.\n\nPujian yang menonjol.\nKeluhan yang menonjol.",
        }}
        resultCount={12}
        commentCount={4}
      />,
    );
    expect(screen.getByText("Gambaran umum percakapan.")).toBeTruthy();
    expect(screen.getByText("Pujian yang menonjol.")).toBeTruthy();
    expect(screen.getByText("Keluhan yang menonjol.")).toBeTruthy();
    expect(screen.getAllByText(/menonjol|Gambaran/).length).toBe(3);
  });

  it("shows a skeleton while the summary is pending and a safe failure message", () => {
    const { rerender } = render(<AiSummary ai={null} summaryStatus="running" />);
    expect(screen.getByText(/Ringkasan ditulis setelah komentar terkumpul/)).toBeTruthy();
    rerender(<AiSummary ai={null} summaryStatus="failed" />);
    expect(screen.getByText(/Ringkasan belum tersedia/)).toBeTruthy();
  });

  it("follows the result distribution and links a quote to its source", () => {
    const disagreed: SnapshotAi = {
      ...aiFixture,
      platformSummaries: [
        { platform: "threads", stance: "positif", summary: "Pujian.", quote_id: "comment:c1" },
      ],
    };
    render(
      <AiSummary
        ai={disagreed}
        resultCount={10}
        commentCount={1}
        platformCounts={{ threads: 10 }}
        results={[{ id: "r1", url: "https://example.invalid/post" }]}
        comments={[{ id: "c1", resultId: "r1" }]}
      />,
    );
    expect(screen.getByText(/Positif 100%/)).toBeTruthy();
    expect(screen.getByText(/Model menandai Campuran/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "kriuknya beda sih" });
    expect(link.getAttribute("href")).toBe("https://example.invalid/post");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
