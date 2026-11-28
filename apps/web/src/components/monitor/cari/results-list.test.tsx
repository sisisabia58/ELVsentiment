// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SnapshotResult } from "@/monitor/search/load";
import { EvidenceLinks } from "./evidence-links";
import { evidenceSources, resolveEvidence } from "./quote-source";
import { ResultsList } from "./results-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function result(overrides: Partial<SnapshotResult>): SnapshotResult {
  return {
    id: "r1",
    platform: "threads",
    externalId: "ext-1",
    authorName: "Rizky",
    authorHandle: "rizkyhdyt",
    url: "https://example.invalid/p/1",
    text: "antrean barayam ciledug tadi malem sampe ke jalan raya",
    title: null,
    publishedAt: "2026-11-12T09:00:00Z",
    thumbnailUrl: null,
    views: null,
    likes: 1200,
    replies: 86,
    shares: null,
    language: "id",
    relevance: "literal_match",
    rank: 1,
    collectedAt: "2026-11-16T10:00:00Z",
    ...overrides,
  };
}

const comments = {
  r1: [
    {
      id: "c1",
      resultId: "r1",
      platform: "threads",
      externalId: "c-1",
      authorName: "Angga",
      authorHandle: "anggaprasetya",
      text: "kriuknya beda sih",
      publishedAt: "2026-11-12T10:00:00Z",
      likes: 33,
      replies: 0,
    },
    {
      id: "c2",
      resultId: "r1",
      platform: "threads",
      externalId: "c-2",
      authorName: "Tiara",
      authorHandle: "tiaramlnd",
      text: "makanya beli lewat ojol aja",
      publishedAt: "2026-11-12T11:00:00Z",
      likes: 12,
      replies: 0,
    },
  ],
};

describe("ResultsList", () => {
  it("original post link names its platform and preserves local citations", () => {
    render(
      <ResultsList
        results={[result({
          platform: "tiktok",
          title: "Review parfum Mandalika",
          url: "https://www.tiktok.com/@rawamangunfoodies/video/7702423576569253140",
          thumbnailUrl: "https://example.invalid/thumb/1.jpg",
        })]}
        commentsByResult={comments}
        sortMode="relevance"
      />,
    );
    const link = screen.getByRole("link", { name: /Review parfum Mandalika.*buka unggahan asli di TikTok/i });
    expect(link.closest("article")?.id).toBe("hasil-r1");
    expect(link.textContent).toContain("Buka di TikTok");
    expect(link.getAttribute("href")).toBe("https://www.tiktok.com/@rawamangunfoodies/video/7702423576569253140");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.tagName).toBe("A");
    expect(link.tabIndex).toBe(0);
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(link.contains(screen.getByRole("heading", { name: "Review parfum Mandalika" }))).toBe(true);
    expect(link.contains(screen.getByAltText("Pratinjau hasil"))).toBe(true);
    expect(link.contains(screen.getByText("kriuknya beda sih"))).toBe(false);
  });

  it.each([
    ["x", "https://mobile.twitter.com/example/status/1000000000000000001"],
    ["reddit", "https://old.reddit.com/r/SocialfFilmmakers/comments/1p3r0uy/when_kabaddi_becomes_a_battlefield_bison_caste/"],
    ["reddit", "https://redd.it/1p3r0uy"],
    ["threads", "https://www.threads.net/@sari/post/EXAMPLE0001"],
    ["instagram", "https://www.instagram.com/example/reel/ExAmPlE0002/"],
    ["facebook", "https://www.facebook.com/aimkbaral/posts/pfbid08pYiLVxQ4sG4w5vDZ5ryRsCRWKyfZ99QNKHtuVYdztqQJ6SoqNyX1YZLEyezAxdrl"],
    ["linkedin", "https://www.linkedin.com/feed/update/urn:li:activity:7511673984338436097/"],
    ["youtube", "https://www.youtube.com/watch?v=TC6pMy8VT0M"],
    ["youtube", "https://youtu.be/TC6pMy8VT0M"],
  ])("opens a known %s post path at its original URL (%s)", (platform, url) => {
    render(<ResultsList results={[result({ platform, url })]} commentsByResult={{}} sortMode="relevance" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(url);
  });

  it.each([
    null,
    "https://[bad",
    "http://x.com/example/status/1000000000000000001",
    "https://x.com.fake.invalid/example/status/1000000000000000001",
    "https://user:secret@x.com/example/status/1000000000000000001",
    "https://x.com/search?q=topic",
    "https://www.threads.net/@sari/post/EXAMPLE0001",
  ])("keeps results readable without an X permalink (%s)", (url) => {
    render(<ResultsList results={[result({ platform: "x", url })]} commentsByResult={{}} sortMode="relevance" />);
    expect(screen.getByRole("heading", { level: 3 })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps relevance rank across platforms in the all-results tab", () => {
    render(
      <ResultsList
        results={[
          result({ id: "best", platform: "youtube", text: "Tukuliling kopi dekat MRT", rank: 1 }),
          result({ id: "anchor", platform: "threads", text: "Ada Tukuliling di MRT", rank: 2 }),
        ]}
        commentsByResult={{}}
        sortMode="relevance"
      />,
    );
    expect(screen.getAllByRole("heading", { level: 3 }).map((item) => item.textContent)).toEqual([
      "Tukuliling kopi dekat MRT", "Ada Tukuliling di MRT",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Threads 1/ }));
    expect(screen.getAllByRole("heading", { level: 3 }).map((item) => item.textContent)).toEqual([
      "Ada Tukuliling di MRT",
    ]);
  });

  it("reveals a locally cited post from a different platform tab", () => {
    render(
      <ResultsList
        results={[
          result({ id: "threads-one", platform: "threads", text: "Hasil Threads", url: null }),
          result({ id: "youtube-one", platform: "youtube", text: "Hasil YouTube", url: null }),
        ]}
        commentsByResult={{}}
        sortMode="relevance"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Threads 1/ }));
    expect(screen.queryByRole("heading", { name: "Hasil YouTube" })).toBeNull();

    try {
      window.history.replaceState(null, "", "#hasil-youtube-one");
      fireEvent(window, new HashChangeEvent("hashchange"));
      expect(screen.getByRole("heading", { name: "Hasil YouTube" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Hasil Threads" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Threads 1/ }));
      expect(window.location.hash).toBe("");
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  });

  it("citation reveals the parent result and hidden reply", async () => {
    const parent = result({ url: "https://www.threads.net/@sari/post/EXAMPLE0001" });
    const replies = Array.from({ length: 4 }, (_, index) => ({
      ...comments.r1[0], id: `retained-${index}`, text: `Balasan ${index}`,
    }));
    const results = [parent, result({ id: "yt", platform: "youtube" })];
    const refs = ["comment:retained-3"];
    const sources = resolveEvidence(refs, evidenceSources(refs, results, replies));
    const citationUi = (
      <>
        <EvidenceLinks sources={sources} />
        <ResultsList results={results} commentsByResult={{ r1: replies }} sortMode="relevance" />
      </>
    );
    render(citationUi);
    fireEvent.click(screen.getByRole("button", { name: /YouTube 1/ }));

    try {
      const citation = screen.getByRole("link", { name: /anggaprasetya · Threads/ });
      expect(citation.getAttribute("href")).toBe("#balasan-retained-3");
      citation.focus();
      fireEvent.click(citation, { detail: 0 });
      expect(window.location.hash).toBe("#balasan-retained-3");
      expect(screen.getByRole("button", { name: /Threads 1/ }).getAttribute("aria-pressed")).toBe("true");
      const reply = document.getElementById("balasan-retained-3");
      expect(document.activeElement).toBe(reply);
      expect(reply?.closest("article")?.id).toBe("hasil-r1");
      expect(reply?.textContent).toContain("Balasan 3");
      expect(screen.getByRole("button", { name: "Sembunyikan balasan tambahan" }).getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("link", { name: /buka unggahan asli di Threads/i }).getAttribute("href")).toBe(parent.url);

      window.history.back();
      await waitFor(() => expect(document.activeElement).toBe(citation));
      expect(window.location.hash).toBe("");
      expect(screen.getByRole("button", { name: /Threads 1/ }).getAttribute("aria-pressed")).toBe("true");

      window.history.replaceState(null, "", "#balasan-retained-3");
      cleanup();
      render(citationUi);
      expect(document.activeElement?.id).toBe("balasan-retained-3");
      expect(screen.getByRole("button", { name: /Threads 1/ }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  });

  it("returns focus to the first citation after backing out of two citations", async () => {
    const results = [
      result({ id: "focus-a", platform: "threads", url: null, authorHandle: "@first-citation" }),
      result({ id: "focus-b", platform: "youtube", url: null, authorHandle: "@second-citation" }),
    ];
    const refs = results.map(({ id }) => `result:${id}`);
    render(
      <>
        <EvidenceLinks sources={resolveEvidence(refs, evidenceSources(refs, results, []))} />
        <ResultsList results={results} commentsByResult={{}} sortMode="relevance" />
      </>,
    );
    const first = screen.getByRole("link", { name: "first-citation · Threads" });
    const second = screen.getByRole("link", { name: "second-citation · YouTube" });

    try {
      first.focus();
      fireEvent.click(first, { detail: 0 });
      expect(document.activeElement?.id).toBe("hasil-focus-a");

      second.focus();
      fireEvent.click(second, { detail: 0 });
      expect(document.activeElement?.id).toBe("hasil-focus-b");

      window.history.back();
      await waitFor(() => expect(document.activeElement?.id).toBe("hasil-focus-a"));
      expect(window.location.hash).toBe("#hasil-focus-a");
      window.history.back();
      await waitFor(() => expect(window.location.hash).toBe(""));
      expect(document.activeElement).toBe(first);
    } finally {
      window.history.replaceState(null, "", window.location.pathname);
    }
  });

  it("discloses retained replies outside the post link and preserves expansion across ranking updates", () => {
    const fourComments = [0, 1, 2, 3].map((index) => ({
      id: `c${index}`,
      resultId: "r1",
      platform: "threads",
      externalId: `c-${index}`,
      authorName: "Rina",
      authorHandle: "rina",
      text: `balasan ${index}`,
      publishedAt: "2026-11-12T10:00:00Z",
      likes: 10 - index,
      replies: 0,
    }));
    const post = result({ id: "r1", replies: 5, url: "https://www.threads.net/@sari/post/EXAMPLE0001" });
    const { rerender } = render(
      <ResultsList
        results={[post]}
        commentsByResult={{ r1: fourComments }}
        sortMode="relevance"
      />,
    );
    expect(screen.getAllByText(/▲/)).toHaveLength(3);
    expect(screen.getByText("1 balasan lainnya belum diambil")).toBeTruthy();
    expect(screen.getByLabelText(/contoh balasan/i)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Lihat 1 balasan tersimpan" });
    expect(toggle.closest("a")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const reply = screen.getByText("balasan 3").closest("[id]");
    expect(reply?.id).toBe("balasan-c3");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    rerender(
      <ResultsList
        results={[result({ id: "r2" }), post]}
        commentsByResult={{ r1: fourComments }}
        sortMode="popular"
      />,
    );
    expect(screen.getByText("balasan 3").closest("[id]")).toBe(reply);
    fireEvent.click(screen.getByRole("button", { name: "Sembunyikan balasan tambahan" }));
    expect(screen.queryByText("balasan 3")).toBeNull();
  });

  it("shows engagement, thumbnail, top replies, and an undated label", () => {
    const datedPost = result({
      id: "r1",
      platform: "tiktok",
      externalId: "video-1",
      title: "Antri 45 menit demi ayam goreng bawang putih",
      views: 182000,
      likes: 9400,
      replies: 4,
      thumbnailUrl: "https://example.invalid/thumb/1.jpg",
    });
    const undatedPost = result({
      id: "r2",
      platform: "youtube",
      externalId: "short-1",
      title: "Barayam Short",
      publishedAt: null,
      likes: 640,
      replies: null,
      rank: 2,
    });
    render(
      <ResultsList
        results={[datedPost, undatedPost]}
        commentsByResult={comments}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    expect(screen.getByText("182 rb tayangan")).toBeTruthy();
    expect(screen.getByText("9,4 rb")).toBeTruthy();
    expect(screen.getByText("Tanggal tidak diketahui")).toBeTruthy();
    expect(screen.getByText("kriuknya beda sih")).toBeTruthy();
    expect(screen.getByText("2 balasan lainnya belum diambil")).toBeTruthy();
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
    expect(screen.getByText("Paling cocok")).toBeTruthy();
  });

  it("does not present a LinkedIn reply count as collected replies", () => {
    render(
      <ResultsList
        results={[result({ id: "r1", platform: "linkedin", replies: 8 })]}
        commentsByResult={{}}
        sortMode="relevance"
      />,
    );
    expect(screen.getByText("Balasan tidak diambil")).toBeTruthy();
    expect(screen.queryByText("8 balasan")).toBeNull();
    expect(screen.queryByLabelText(/contoh balasan/i)).toBeNull();
  });

  it("hides a reply row whose text is empty", () => {
    render(
      <ResultsList
        results={[result({ id: "r1", platform: "facebook", replies: 3 })]}
        commentsByResult={{
          r1: [
            { ...comments.r1[0], platform: "facebook", text: "enak", authorName: "Sari", authorHandle: null },
            { ...comments.r1[1], id: "c-empty", platform: "facebook", text: "   " },
          ],
        }}
        sortMode="relevance"
      />,
    );
    expect(screen.getByText("enak")).toBeTruthy();
    expect(screen.getByText("3 balasan")).toBeTruthy();
    expect(screen.getAllByText(/▲/)).toHaveLength(1);
    expect(screen.getByText("1 balasan lainnya belum diambil")).toBeTruthy();
  });

  it("does not count retained Facebook stickers or invisible replies as uncollected", () => {
    render(
      <ResultsList
        results={[result({ id: "r1", platform: "facebook", replies: 3 })]}
        commentsByResult={{
          r1: [
            { ...comments.r1[0], id: "c-text", platform: "facebook", text: "enak", authorName: "Sari", authorHandle: null },
            { ...comments.r1[0], id: "c-zhong", platform: "facebook", text: "\u200b", authorName: "Zhong Lun", authorHandle: "Zhong Lun" },
            { ...comments.r1[0], id: "c-miki", platform: "facebook", text: "\ufeff\u200c", authorName: "Miki Yong", authorHandle: "Miki Yong" },
            { ...comments.r1[0], id: "c-object", platform: "facebook", text: "\ufffc", authorName: "Stiker", authorHandle: null },
          ],
        }}
        sortMode="relevance"
      />,
    );
    expect(screen.getByText("enak")).toBeTruthy();
    expect(screen.queryByText("Zhong Lun")).toBeNull();
    expect(screen.queryByText("Miki Yong")).toBeNull();
    expect(screen.queryByText("Stiker")).toBeNull();
    expect(screen.getAllByText(/▲/)).toHaveLength(1);
    expect(screen.queryByText(/belum diambil/)).toBeNull();
    const block = screen.getByLabelText(/contoh balasan/i);
    expect(block.textContent).toContain("3");
    expect(block.textContent).not.toContain("4");
  });

  it("shows the stored Zhong Lun text and counts blank replies as collected", () => {
    render(
      <ResultsList
        results={[result({ id: "r1", platform: "facebook", replies: 3, authorName: "Rojaklah" })]}
        commentsByResult={{
          r1: [
            {
              ...comments.r1[0],
              id: "c-miki",
              platform: "facebook",
              text: "Zhong Lun",
              authorName: "Miki Yong",
              authorHandle: "Miki Yong",
              likes: 0,
            },
            {
              ...comments.r1[0],
              id: "c-edward",
              platform: "facebook",
              text: "环氧乙烷 tidak masalah",
              authorName: "Edward Gooi",
              authorHandle: "Edward Gooi",
              likes: 0,
            },
            {
              ...comments.r1[0],
              id: "c-filler",
              platform: "facebook",
              text: "\u3164",
              authorName: "Kosong",
              authorHandle: "Kosong",
              likes: 0,
            },
          ],
        }}
        sortMode="relevance"
      />,
    );
    expect(screen.getByText("Zhong Lun")).toBeTruthy();
    expect(screen.getByText("Miki Yong")).toBeTruthy();
    expect(screen.getByText("Edward Gooi")).toBeTruthy();
    expect(screen.queryByText("Kosong")).toBeNull();
    expect(screen.getAllByText(/▲/)).toHaveLength(2);
    expect(screen.queryByText(/belum diambil/)).toBeNull();
    const block = screen.getByLabelText(/contoh balasan/i);
    expect(block.textContent).toContain("3");
    expect(block.textContent).not.toContain("4");
  });

  it("discloses retained reply rows even if the post reports fewer replies", () => {
    const rows = ["satu", "dua", "tiga", "empat"].map((text, index) => ({
      ...comments.r1[0],
      id: `c${index}`,
      platform: "facebook",
      text,
      authorName: text,
      authorHandle: null,
    }));
    render(
      <ResultsList
        results={[result({ id: "r1", platform: "facebook", replies: 3 })]}
        commentsByResult={{ r1: rows }}
        sortMode="relevance"
      />,
    );
    expect(screen.getAllByText(/▲/)).toHaveLength(3);
    expect(screen.queryByText("empat")).toBeNull();
    expect(screen.queryByText(/belum diambil/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lihat 1 balasan tersimpan" }));
    expect(document.getElementById("balasan-c3")?.textContent).toContain("empat");
  });

  it("replaces a broken thumbnail with an aria-hidden platform placeholder", () => {
    render(
      <ResultsList
        results={[
          result({
            id: "r1",
            platform: "tiktok",
            externalId: "video-1",
            thumbnailUrl: "https://example.invalid/thumb/broken.jpg",
          }),
        ]}
        commentsByResult={{}}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    fireEvent.error(screen.getByAltText("Pratinjau hasil"));
    expect(screen.queryByAltText("Pratinjau hasil")).toBeNull();
    expect(screen.getByTestId("thumb-placeholder").getAttribute("aria-hidden")).toBe("true");
  });

  it("replaces a thumbnail that failed before hydration", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    render(
      <ResultsList
        results={[
          result({
            id: "r1",
            platform: "tiktok",
            externalId: "video-1",
            thumbnailUrl: "https://example.invalid/thumb/broken-before-hydration.jpg",
          }),
        ]}
        commentsByResult={{}}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    expect(screen.queryByAltText("Pratinjau hasil")).toBeNull();
    expect(screen.getByTestId("thumb-placeholder").getAttribute("aria-hidden")).toBe("true");
  });

  it("wraps a long handle and clamps long result text at narrow widths", () => {
    const handle = "pengguna_tanpa_spasi_" + "x".repeat(200);
    const longText = "kata ".repeat(120);
    render(
      <ResultsList
        results={[
          result({
            id: "r1",
            platform: "tiktok",
            externalId: "video-1",
            title: longText,
            text: longText,
            authorHandle: handle,
          }),
        ]}
        commentsByResult={{}}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    const handleNode = screen.getByText(`@${handle}`);
    expect(handleNode.className).toContain("wrap-anywhere");
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.className).toContain("line-clamp-4");
  });

  it("shows the placeholder when a result has no thumbnail", () => {
    render(
      <ResultsList
        results={[
          result({
            id: "r2",
            platform: "youtube",
            externalId: "short-1",
            title: "Barayam Short",
            thumbnailUrl: null,
          }),
        ]}
        commentsByResult={{}}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    expect(screen.queryByAltText("Pratinjau hasil")).toBeNull();
    expect(screen.getByTestId("thumb-placeholder")).toBeTruthy();
  });

  it("labels each platform and shows a chip for each non-empty group", () => {
    const threadsPost = result({ id: "t1", platform: "threads", externalId: "th-1" });
    const youtubePost = result({
      id: "y1",
      platform: "youtube",
      externalId: "yt-1",
      title: "BARAYAM: Ayam Goreng Bawang Putih Viral",
      publishedAt: "2026-11-14T09:00:00Z",
    });
    render(
      <ResultsList
        results={[threadsPost, youtubePost]}
        commentsByResult={{}}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    expect(screen.getByText("Threads")).toBeTruthy();
    expect(screen.getByText("YouTube")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Threads 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /YouTube 1/ })).toBeTruthy();
  });

  it("filters client-side from a platform chip and can reset to all", () => {
    render(
      <ResultsList
        results={[
          result({ id: "t1", platform: "threads", externalId: "th-1" }),
          result({ id: "y1", platform: "youtube", externalId: "yt-1", title: "Video" }),
        ]}
        commentsByResult={{}}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /YouTube 1/ }));
    expect(screen.queryByText("Threads")).toBeNull();
    expect(screen.getByText("YouTube")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Semua 2/ }));
    expect(screen.getByText("Threads")).toBeTruthy();
  });

  it("uses newest and popular order labels without reordering the stored snapshot", () => {
    const newer = result({
      id: "n1",
      platform: "threads",
      externalId: "newer",
      publishedAt: "2026-11-16T08:00:00Z",
      likes: 10,
    });
    const older = result({
      id: "n2",
      platform: "threads",
      externalId: "older",
      publishedAt: "2026-11-10T08:00:00Z",
      likes: 9999,
    });
    render(
      <ResultsList
        results={[newer, older]}
        commentsByResult={{}}
        sortMode="newest"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    expect(screen.getByText("Terbaru")).toBeTruthy();
  });

  it("shows an empty state and avoids a crash with a missing snapshot", () => {
    render(
      <ResultsList
        results={[]}
        commentsByResult={{}}
        sortMode="relevance"
        now={new Date("2026-11-16T10:00:00Z")}
      />,
    );
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryByText("Hasil")).toBeNull();
  });
});


it("offers review only on supported native posts while the feature is enabled", () => {
  const results = [
    result({ id: "native" }),
    result({ id: "indexed", platform: "instagram", webIndex: true }),
    result({ id: "fallback", externalId: "url:fallback" }),
    result({ id: "unsupported", platform: "x" }),
  ];
  const onReview = vi.fn();
  const props = { results, commentsByResult: {}, sortMode: "relevance" as const };
  const { rerender } = render(<ResultsList {...props} />);
  expect(screen.queryByRole("button", { name: "Tinjau" })).toBeNull();
  rerender(<ResultsList {...props} onReview={onReview} />);
  const review = screen.getByRole("button", { name: "Tinjau" });
  fireEvent.click(review);
  expect(onReview).toHaveBeenCalledExactlyOnceWith("native", review);
});
