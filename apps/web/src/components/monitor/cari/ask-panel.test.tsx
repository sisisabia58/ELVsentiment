// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotQuestion, SnapshotResult } from "@/monitor/search/load";
import { askQuestionAction, retryQuestionAction } from "@/app/cari/start-action";
import { AskPanel } from "./ask-panel";

vi.mock("@/app/cari/start-action", () => ({
  askQuestionAction: vi.fn(async () => ({ ok: true, questionId: "q-new" })),
  retryQuestionAction: vi.fn(async () => ({ ok: true, questionId: "q2" })),
}));

const answeredQuestion: SnapshotQuestion = {
  id: "q1",
  question: "Apa keluhan utama?",
  status: "done",
  answer: "Keluhan utama adalah antrean.",
  citations: ["result:r1", "result:r1", "result:missing", "result:r2"],
  evidenceIds: ["result:r1", "result:missing"],
  safeDetail: null,
  createdAt: "2026-11-16T10:00:00Z",
  answeredAt: "2026-11-16T10:00:05Z",
};

const failedQuestion: SnapshotQuestion = {
  id: "q2",
  question: "Apa yang dipuji?",
  status: "failed",
  answer: null,
  citations: [],
  safeDetail: "http_429",
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

afterEach(() => {
  cleanup();
});

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
    expect(screen.getAllByRole("link", { name: /rizkyhdyt · Threads/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /rizkyhdyt · Threads/ }).getAttribute("href")).toBe("#hasil-r1");
    expect(screen.queryByText(/jawaban hanya berdasarkan 1 hasil/i)).toBeNull();
    expect(screen.getByText(/Kuota AI sedang penuh/)).toBeTruthy();
    expect(screen.queryByText(/Jawaban belum tersedia/)).toBeNull();
    expect(screen.queryByText(/result:missing/)).toBeNull();
  });

  it("shows a fallback for legacy answers without a retained citation", () => {
    render(<AskPanel searchId="s1" questions={[{ ...answeredQuestion, evidenceIds: [] }]} suggestions={[]} results={results} />);
    expect(screen.getByText(/Jawaban belum tersedia/)).toBeTruthy();
    expect(screen.queryByText(answeredQuestion.answer!)).toBeNull();
  });

  it("retries the same failed question without asking a new one", async () => {
    vi.mocked(askQuestionAction).mockClear();
    render(
      <AskPanel searchId="s1" questions={[failedQuestion]} suggestions={[]} results={results} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(retryQuestionAction).toHaveBeenCalledWith("s1", "q2");
    expect(askQuestionAction).not.toHaveBeenCalled();
    expect(await screen.findByText("Menjawab…")).toBeTruthy();
  });

  it("names a per-cycle cap instead of an empty failure", () => {
    render(
      <AskPanel
        searchId="s1"
        questions={[{ ...failedQuestion, safeDetail: "cycle_cap" }]}
        suggestions={[]}
      />,
    );
    expect(screen.getByText(/Terlalu banyak permintaan sekaligus/)).toBeTruthy();
    expect(screen.queryByText("Jawaban belum tersedia")).toBeNull();
  });

  it("names a rejected AI key instead of an empty failure", () => {
    render(
      <AskPanel
        searchId="s1"
        questions={[{ ...failedQuestion, safeDetail: "config_error" }]}
        suggestions={[]}
      />,
    );
    expect(screen.getByText(/Konfigurasi AI ditolak/)).toBeTruthy();
    expect(screen.queryByText("Jawaban belum tersedia")).toBeNull();
  });

  it("shows a busy AI status instead of an empty failure", () => {
    render(
      <AskPanel
        searchId="s1"
        questions={[{ ...failedQuestion, safeDetail: "http_503" }]}
        suggestions={[]}
      />,
    );
    expect(screen.getByText(/AI sedang sibuk/)).toBeTruthy();
    expect(screen.queryByText("Jawaban belum tersedia")).toBeNull();
  });

  it("still names a failure when no detail was stored", () => {
    render(
      <AskPanel
        searchId="s1"
        questions={[{ ...failedQuestion, safeDetail: null }]}
        suggestions={[]}
      />,
    );
    expect(screen.getByText("Jawaban gagal. Coba lagi.")).toBeTruthy();
    expect(screen.queryByText("Jawaban belum tersedia")).toBeNull();
  });
});
