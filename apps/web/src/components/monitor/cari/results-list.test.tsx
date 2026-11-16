// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapshotResult } from "@/monitor/search/load";
import { ResultsList } from "./results-list";

afterEach(cleanup);

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
    expect(screen.getByText("2 balasan lainnya")).toBeTruthy();
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
    expect(screen.getByText("Paling cocok")).toBeTruthy();
  });

  it("groups by platform and shows a chip for each non-empty group", () => {
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

