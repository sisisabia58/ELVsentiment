// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotQuestion, SnapshotResult } from "@/monitor/search/load";
import { AskPanel } from "./ask-panel";

vi.mock("@/app/cari/start-action", () => ({
  askQuestionAction: vi.fn(async () => ({ ok: true, questionId: "q-new" })),
}));

const answeredQuestion: SnapshotQuestion = {
  id: "q1",
  question: "Apa keluhan utama?",
  status: "done",
  answer: "Keluhan utama adalah antrean.",
  citations: ["result:r1", "result:missing"],
  createdAt: "2026-11-16T10:00:00Z",
  answeredAt: "2026-11-16T10:00:05Z",
};

const failedQuestion: SnapshotQuestion = {
  id: "q2",
  question: "Apa yang dipuji?",
  status: "failed",
  answer: null,
  citations: [],
  createdAt: "2026-11-16T10:00:06Z",
  answeredAt: "2026-11-16T10:00:07Z",
};

const results = [
  {
    id: "r1",
    platform: "threads",
    externalId: "th-1",
    authorName: "Rizky",
    authorHandle: "rizkyhdyt",
    url: null,
    text: "antrean panjang",
    title: null,
    publishedAt: null,
    thumbnailUrl: null,
    views: null,
    likes: null,
    replies: null,
    shares: null,
    language: "id",
    relevance: "literal_match",
    rank: 1,
    collectedAt: "2026-11-16T10:00:00Z",
  },
] satisfies SnapshotResult[];

describe("AskPanel", () => {
  it("submits a question and shows 1 kredit per pertanyaan", async () => {
    render(<AskPanel searchId="s1" questions={[]} suggestions={["Apa keluhan utama?"]} />);
    expect(screen.getByText(/1 kredit per pertanyaan/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Pertanyaan"), { target: { value: "Apa keluhan utama?" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirim" }));
  });

  it("renders only stored citations and a safe failure message", () => {
    render(
      <AskPanel
        searchId="s1"
        questions={[answeredQuestion, failedQuestion]}
        suggestions={[]}
        results={results}
      />,
    );
    expect(screen.getByText(/rizkyhdyt · Threads/)).toBeTruthy();
    expect(screen.getByText(/Jawaban belum tersedia/)).toBeTruthy();
    expect(screen.queryByText(/result:missing/)).toBeNull();
  });
});
