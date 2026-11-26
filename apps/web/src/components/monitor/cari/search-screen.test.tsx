// @vitest-environment jsdom
import { Activity } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchSnapshot, SnapshotResult } from "@/monitor/search/load";
import { startMoreSourceAction, startSearchAction } from "@/app/cari/start-action";
import { SearchDetail, SearchScreen } from "./search-screen";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("@/app/cari/start-action", () => ({
  startSearchAction: vi.fn(),
  startMoreSourceAction: vi.fn(),
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

it("mobile filter edits stay in the next search draft", async () => {
  const initial = finishedSnapshot();
  initial.search.filters = { dateWindow: "30d", sort: "relevance", language: "all" };
  const start = vi.mocked(startSearchAction);
  start.mockClear();
  start.mockResolvedValue({ ok: true, searchId: "next-search" });
  const { rerender } = render(<SearchDetail initialSnapshot={initial} />);

  fireEvent.click(screen.getByRole("button", { name: "Filter pencarian" }));
  const dialog = within(screen.getByRole("dialog", { name: "Filter pencarian" }));
  const dates = within(dialog.getByRole("radiogroup", { name: "Tanggal" }));
  expect((dates.getByRole("radio", { name: "30 hari terakhir" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(dates.getByRole("radio", { name: "7 hari terakhir" }));
  fireEvent.click(dialog.getByRole("radio", { name: "Bahasa Indonesia" }));
  fireEvent.click(dialog.getByRole("button", { name: "Tutup filter" }));
  fireEvent.click(screen.getByRole("button", { name: "Hapus filter Bahasa: Indonesia" }));
  expect(start).not.toHaveBeenCalled();
  expect(screen.getByText("30 hari terakhir · Paling cocok")).toBeTruthy();

  rerender(<SearchDetail initialSnapshot={{ ...initial }} />);
  fireEvent.click(screen.getByRole("button", { name: "Cari" }));
  await waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith({
    query: "barayam",
    filters: { dateWindow: "7d", sort: "relevance", language: "all" },
  }));
});

it("initializes the draft again for a different search ID", () => {
  const initial = finishedSnapshot();
  const { rerender } = render(<SearchDetail initialSnapshot={initial} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Kata kunci pencarian" }), {
    target: { value: "draft" },
  });

  const next = { ...initial, search: {
    ...initial.search, id: "other-id", query: "kopi", filters: {
      dateWindow: "24h" as const, sort: "relevance" as const, language: "all" as const,
    },
  } };
  rerender(<SearchDetail initialSnapshot={next} />);
  expect((screen.getByRole("textbox", { name: "Kata kunci pencarian" }) as HTMLInputElement).value).toBe("kopi");
  expect(screen.getByRole("button", { name: "Hapus filter Tanggal: 24 jam" })).toBeTruthy();
});

it("updates the result scroll offset as the sticky search form changes height", () => {
  let resized: () => void = () => {};
  let height = 105;
  class SearchResizeObserver {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", SearchResizeObserver);
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => ({ height }) as DOMRect);
  try {
    render(<SearchDetail initialSnapshot={finishedSnapshot()} />);
    const result = screen.getByText("antrean barayam ciledug tadi malem");
    expect(result.closest<HTMLElement>("[style*='--cari-search-height']")?.style
      .getPropertyValue("--cari-search-height")).toBe("105px");

    height = 155;
    act(() => resized());
    expect(result.closest<HTMLElement>("[style*='--cari-search-height']")?.style
      .getPropertyValue("--cari-search-height")).toBe("155px");
  } finally {
    measure.mockRestore();
  }
});

describe("SearchDetail", () => {
  it("keeps the old receipt and reruns its query and filters with no verified evidence", async () => {
    const done = finishedSnapshot();
    done.search.query = "tukuliling kopi";
    done.search.filters = { dateWindow: "7d", sort: "popular", language: "id" };
    Object.assign(done.search, { legacyEvidence: true, summaryStatus: "skipped" });
    done.results = [];
    done.totals = { sources: 8, done: 7, results: 0 };
    vi.mocked(startSearchAction).mockResolvedValue({ ok: true, searchId: "fresh" });
    render(<SearchDetail initialSnapshot={done} aiEnabled />);
    expect(screen.getByText(/7 dari 8 sumber menjawab · 0 hasil/)).toBeTruthy();
    expect(screen.getByText(/hasil tersimpan yang bisa diverifikasi/i)).toBeTruthy();
    expect(screen.queryByText("Ringkasan AI")).toBeNull();
    expect(screen.queryByText("Tanya hasil ini")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cari ulang" }));
    await waitFor(() => expect(startSearchAction).toHaveBeenCalledWith({
      query: "tukuliling kopi", filters: { dateWindow: "7d", sort: "popular", language: "id" },
    }));
  });

  it("explains a new successful search with zero relevant results", () => {
    const done = finishedSnapshot();
    done.search.summaryStatus = "skipped";
    done.results = [];
    done.totals = { sources: 8, done: 7, results: 0 };
    render(<SearchDetail initialSnapshot={done} aiEnabled />);
    expect(screen.getByText("Tidak ada hasil yang cocok dengan kata kunci.")).toBeTruthy();
    expect(screen.queryByText("Tanya hasil ini")).toBeNull();
  });

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
      overallSupportingIds: ["result:r1"],
      evidenceIds: ["result:r1"],
      platformSummaries: [{ platform: "threads", stance: "positif", summary: "Pujian.", supporting_ids: ["result:r1"] }],
      quotes: [],
      themes: [],
      model: "gemini",
    };
    render(<SearchDetail initialSnapshot={done} aiEnabled />);
    expect(screen.getAllByText("Ringkasan AI").length).toBeGreaterThan(0);
    expect(screen.getByText("Tanya hasil ini")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Sumber ringkasan" })).toBeTruthy();
    expect(screen.getByText(/Cuplikan AI · 1 unggahan dan 0 balasan/)).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body.indexOf("antrean barayam ciledug tadi malem")).toBeLessThan(body.indexOf("Bagaimana percakapannya"));
  });

  it("shows each quote link once", () => {
    const done = finishedSnapshot();
    done.search.summaryStatus = "done";
    done.ai = {
      overallSummary: "Ringkasan rahasia",
      overallStance: "positif",
      overallSupportingIds: ["result:r1"],
      evidenceIds: ["result:r1"],
      platformSummaries: [{ platform: "threads", stance: "positif", summary: "Pujian.", supporting_ids: ["result:r1"] }],
      quotes: [
        { type: "pujian", text: "antrean barayam", ref_id: "result:r1", platform: "threads", author: "rina" },
        { type: "pujian", text: "antrean barayam", ref_id: "result:r1", platform: "threads", author: "rina" },
      ],
      themes: [],
      model: "gemini",
    };
    render(<SearchDetail initialSnapshot={done} aiEnabled />);
    expect(screen.getAllByRole("link", { name: "antrean barayam" })).toHaveLength(1);
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
    expect(screen.getByRole("button", { name: "Pantau sebagai proyek" })).toBeTruthy();
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
  it("keeps the submitted view locked until navigation and unlocks the preserved form on Back", async () => {
    const start = vi.mocked(startSearchAction);
    push.mockClear();
    start.mockReset();
    start.mockResolvedValue({ ok: true, searchId: "next-search" });
    function route(mode: "visible" | "hidden") {
      return (
        <Activity mode={mode}>
          <SearchScreen history={[]} now="2026-11-16T10:00:00Z" />
        </Activity>
      );
    }
    const { rerender } = render(route("visible"));

    fireEvent.change(screen.getByRole("textbox", { name: "Kata kunci pencarian" }), {
      target: { value: "barayam" },
    });
    const submit = screen.getByRole("button", { name: "Cari" });
    fireEvent.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith("/cari/next-search"));
    fireEvent.submit(submit.closest("form")!);
    expect(start).toHaveBeenCalledTimes(1);
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    rerender(route("hidden"));
    expect(screen.queryByRole("button", { name: "Cari" })).toBeNull();
    rerender(route("visible"));
    const query = screen.getByRole<HTMLInputElement>("textbox", { name: "Kata kunci pencarian" });
    expect(query.value).toBe("barayam");
    expect(query.disabled).toBe(false);
    fireEvent.change(query, {
      target: { value: "kopi" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("lets users select the date, sort, and language filters", () => {
    render(<SearchScreen history={[]} now="2026-11-16T10:00:00Z" />);

    fireEvent.click(screen.getByRole("button", { name: /^Tanggal:\s*Semua$/ }));
    fireEvent.click(screen.getByRole("button", { name: "7 hari terakhir" }));
    expect(screen.getByRole("button", { name: /^Tanggal:\s*7 hari$/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Urutkan:\s*Paling cocok$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Terbaru" }));
    expect(screen.getByRole("button", { name: /^Urutkan:\s*Terbaru$/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Bahasa:\s*Semua$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Bahasa Indonesia" }));
    expect(screen.getByRole("button", { name: /^Bahasa:\s*Indonesia$/ })).toBeTruthy();
  });

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
    expect(screen.getByText("Cari di hingga 8 sumber")).toBeTruthy();
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
    expect(screen.getByText("Hingga 8 sumber · hasil dalam ±30 detik")).toBeTruthy();
    expect(screen.getByText("Cari di hingga 8 sumber")).toBeTruthy();
    expect(
      screen.getByText(
        "Threads, Instagram, TikTok, YouTube, Facebook, Reddit, LinkedIn, dan X. Facebook hanya mendukung tagar. Instagram dan X menggunakan indeks dengan cakupan terbatas.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/9 sumber/)).toBeNull();
    expect(screen.queryByText(/Facebook, X, Reddit/)).toBeNull();
    expect(screen.queryByText(/dan web — semuanya/)).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(within(button).queryByText("W")).toBeNull();
    }
  });
});

it("requests the selected source once and shows the merged page without a price", async () => {
  const initial = finishedSnapshot();
  const tiktok = {
    ...initial.sources[0],
    platform: "tiktok",
    more: { state: "available" as const, added: null, generation: 0 },
  };
  initial.sources = [tiktok, initial.sources[1]];
  initial.results = [post({ platform: "tiktok" })];
  vi.mocked(startMoreSourceAction).mockResolvedValue({ ok: true, jobId: "more-job" });

  const updated = {
    ...initial,
    sources: [{ ...tiktok, more: { state: "exhausted", added: 1, generation: 1 } }, initial.sources[1]],
    results: [...initial.results, post({ platform: "tiktok", id: "r2", text: "hasil tambahan yang cocok" })],
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => updated,
  }));
  render(<SearchDetail initialSnapshot={initial} />);
  fireEvent.click(screen.getByRole("button", { name: "TikTok 1" }));
  const buttons = screen.getAllByRole("button", { name: "Cari lagi di TikTok" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[1]);
  fireEvent.click(buttons[0]);
  expect(startMoreSourceAction).toHaveBeenCalledExactlyOnceWith(initial.search.id, "tiktok", 0);
  expect(await screen.findByText("hasil tambahan yang cocok", {}, { timeout: 3000 })).not.toBeNull();
  expect(screen.getByText(initial.results[0].text)).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Cari lagi di TikTok" })).toBeNull();
  expect(screen.queryByText(/kredit|Rp\s?\d/i)).toBeNull();
});
