// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchSnapshot, SnapshotResult } from "@/monitor/search/load";
import { SearchDetail, SearchScreen } from "./search-screen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/cari/start-action", () => ({
  startSearchAction: vi.fn(),
}));

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
      errorCode: null,
      createdAt: "2026-11-16T10:00:00Z",
      startedAt: "2026-11-16T10:00:00Z",
      finishedAt: null,
    },
    sources: [
      {
        platform: "threads",
        state: "answered",
        resultCount: 1,
        latencyMs: 3200,
        safeDetail: "ok",
        updatedAt: "2026-11-16T10:00:03Z",
      },
      {
        platform: "youtube",
        state: "unavailable",
        resultCount: 0,
        latencyMs: null,
        safeDetail: "deadline",
        updatedAt: "2026-11-16T10:00:10Z",
      },
    ],
    totals: { sources: 8, done: 4, results: 43 },
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
    totals: { sources: 8, done: 7, results: 65 },
  };
}

function failedSnapshot(errorCode: string): SearchSnapshot {
  const running = snapshot();
  return {
    ...running,
    search: {
      ...running.search,
      status: "failed",
      errorCode,
      startedAt: null,
      finishedAt: "2026-11-16T10:00:40Z",
    },
    totals: { sources: 8, done: 0, results: 0 },
    results: [],
    sources: running.sources.map((source) => ({
      ...source,
      state: "failed",
      resultCount: 0,
    })),
  };
}

describe("SearchDetail", () => {
  it("hides the summary until a non-demo provider is selected", () => {
    const done = finishedSnapshot();
    done.search.summaryStatus = "done";
    done.ai = {
      overallSummary: "Ringkasan rahasia",
      overallStance: "campuran",
      platformSummaries: [],
      quotes: [{ text: "kutipan-rahasia" }],
      themes: [],
      model: "demo",
    };
    render(<SearchDetail initialSnapshot={done} />);
    expect(screen.queryByText("Ringkasan AI")).toBeNull();
    expect(screen.queryByText("Tanya hasil ini")).toBeNull();
    expect(screen.queryByText("kutipan-rahasia")).toBeNull();
    expect(screen.queryByText("Bagaimana percakapannya")).toBeNull();
    expect(screen.getByText("antrean barayam ciledug tadi malem")).toBeTruthy();
  });

  it("shows the summary beside the results and the breakdown after them", () => {
    const done = finishedSnapshot();
    done.search.summaryStatus = "done";
    done.ai = {
      overallSummary: "Ringkasan rahasia",
      overallStance: "campuran",
      platformSummaries: [{ platform: "threads", stance: "positif", summary: "Pujian." }],
      quotes: [],
      themes: [],
      model: "gemini",
    };
    render(<SearchDetail initialSnapshot={done} aiEnabled />);
    expect(screen.getAllByText("Ringkasan AI").length).toBeGreaterThan(0);
    expect(screen.getByText("Tanya hasil ini")).toBeTruthy();
    expect(screen.getByText(/bisa keliru, cek kutipannya/)).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body.indexOf("antrean barayam ciledug tadi malem")).toBeLessThan(body.indexOf("Bagaimana percakapannya"));
  });

  it("shows each quote link once", () => {
    const done = finishedSnapshot();
    done.search.summaryStatus = "done";
    done.ai = {
      overallSummary: "Ringkasan rahasia",
      overallStance: "positif",
      platformSummaries: [{ platform: "threads", stance: "positif", summary: "Pujian.", quote_id: "result:r1" }],
      quotes: [
        { type: "pujian", text: "antrean unik", ref_id: "result:r1", platform: "threads", author: "rina" },
        { type: "pujian", text: "antrean unik", ref_id: "result:r1", platform: "threads", author: "rina" },
      ],
      themes: [],
      model: "gemini",
    };
    render(<SearchDetail initialSnapshot={done} aiEnabled />);
    expect(screen.getAllByRole("link", { name: "antrean unik" })).toHaveLength(1);
  });

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

  it("shows a clear Indonesian deadline message with no bogus elapsed or credits", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<SearchDetail initialSnapshot={failedSnapshot("deadline")} />);
    expect(
      screen.getByText("Waktu pencarian habis sebelum semua sumber menjawab."),
    ).toBeTruthy();
    expect(screen.queryByText(/dtk/)).toBeNull();
    expect(screen.queryByText(/kredit/)).toBeNull();
    expect(screen.queryByText(/300 dtk/)).toBeNull();
  });

  it("maps other failed searches to Indonesian copy", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<SearchDetail initialSnapshot={failedSnapshot("all_sources_failed")} />);
    expect(
      screen.getByText("Tidak ada sumber yang berhasil menjawab. Coba lagi sebentar lagi."),
    ).toBeTruthy();
  });

  it("still explains a failed search whose error_code is missing", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const failed = failedSnapshot("placeholder");
    failed.search.errorCode = null;
    render(<SearchDetail initialSnapshot={failed} />);
    expect(screen.getByText("Pencarian gagal. Coba lagi sebentar lagi.")).toBeTruthy();
  });

  it("never shows credits to a tenant", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const done = finishedSnapshot();
    done.totals = { sources: 8, done: 7, results: 2 };
    render(<SearchDetail initialSnapshot={done} />);
    expect(screen.getAllByText(/2 hasil/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/kredit/)).toBeNull();
  });

  it("uses the server-provided now for a running search instead of the wall clock", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(
      <SearchDetail initialSnapshot={snapshot()} now="2026-11-16T10:00:31Z" />,
    );
    expect(screen.getByText(/31 dtk/)).toBeTruthy();
  });

  it("uses the same result total in the receipt and the platform tabs", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const done = finishedSnapshot();
    done.totals = { sources: 7, done: 7, results: 2 };
    done.results = [
      post({ id: "t1", platform: "threads", externalId: "th-1" }),
      post({ id: "y1", platform: "youtube", externalId: "yt-1", title: "Video kopi" }),
    ];
    render(<SearchDetail initialSnapshot={done} />);
    expect(screen.getByText(/7 dari 7 sumber menjawab · 2 hasil/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Semua 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Threads 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /YouTube 1/ })).toBeTruthy();
    expect(screen.queryByText(/dari 180/)).toBeNull();
  });

  it("renders a finished partial search without pretending every source answered", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const partial = finishedSnapshot();
    partial.search.status = "partial";
    partial.totals = { sources: 8, done: 6, results: 20 };
    render(<SearchDetail initialSnapshot={partial} />);
    expect(screen.getByText(/6 dari 8 sumber menjawab/)).toBeTruthy();
  });
});

const UNFINISHED_AI_COPY = [
  "kutipan aslinya",
  "kutipan asli",
  "Dapat ringkasan AI",
  "tanyakan apa saja",
  "1 kredit per pertanyaan",
  "Sikap per platform",
  "topik utama",
];

describe("SearchScreen", () => {
  it("hides unfinished AI summary, quote, theme, and question copy by default", () => {
    render(
      <SearchScreen
        history={[
          {
            id: "s1",
            query: "barayam",
            resultCount: 8,
            sourceCount: 7,
            stance: "campuran",
            status: "partial",
            createdAt: "2026-11-16T08:00:00Z",
          },
        ]}
        now="2026-11-16T10:00:00Z"
      />,
    );
    const text = document.body.textContent ?? "";
    for (const phrase of UNFINISHED_AI_COPY) {
      expect(text, phrase).not.toContain(phrase);
    }
    expect(screen.queryByText("campuran")).toBeNull();
    expect(screen.getByText("Cari di 7 sumber")).toBeTruthy();
    expect(screen.getByText("Baca komentar teratas")).toBeTruthy();
    expect(screen.getByText(/Balasan pada 3 pos teratas tiap sumber/)).toBeTruthy();
    expect(screen.queryByText(/paling disukai ikut diambil/)).toBeNull();
  });

  it("keeps the AI summary, quote, and question copy when answers are enabled", () => {
    render(<SearchScreen history={[]} now="2026-11-16T10:00:00Z" aiEnabled />);
    expect(screen.getByText(/lengkap dengan kutipan aslinya/)).toBeTruthy();
    expect(screen.getByText("Dapat ringkasan AI")).toBeTruthy();
    expect(screen.getByText(/tanyakan apa saja tentang hasilnya/)).toBeTruthy();
  });

  it("describes and illustrates only the launch sources", () => {
    render(<SearchScreen history={[]} now="2026-11-16T10:00:00Z" />);
    expect(screen.getByText("7 sumber siap · hasil dalam ±30 detik")).toBeTruthy();
    expect(screen.getByText("Cari di 7 sumber")).toBeTruthy();
    expect(
      screen.getByText(
        "Threads, Instagram, TikTok, YouTube, Facebook, Reddit, dan LinkedIn — semuanya sekaligus.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/8 sumber/)).toBeNull();
    expect(screen.queryByText(/Facebook, X, Reddit/)).toBeNull();
    expect(screen.queryByText(/dan web — semuanya/)).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(within(button).queryByText("X")).toBeNull();
      expect(within(button).queryByText("W")).toBeNull();
    }
  });
});
