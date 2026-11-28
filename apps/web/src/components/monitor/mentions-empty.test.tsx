// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresentedMention } from "@/monitor/present";
import type { Workspace } from "@/monitor/load";
import { MentionsScreen } from "./mentions-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

afterEach(cleanup);

function workspace(configured: boolean): Workspace {
  return {
    email: "rina@pakgembus.example",
    displayName: "Rina",
    initials: "R",
    projects: [],
    project: {
      id: "p1",
      name: "Kedai Contoh",
      initials: "KC",
      sources: ["x", "threads"],
      schedule: { mode: "off", intervalHours: 6 },
      nextRunAt: null,
      lastCollectedAt: null,
      keywordCount: 1,
    },
    projectMissing: false,
    mentions: [],
    sources: [
      { source: "x", state: configured ? "ready" : "unavailable", detail: "", lastSuccessAt: null, configured },
      { source: "threads", state: "unavailable", detail: "", lastSuccessAt: null, configured: false },
    ],
    jobs: [],
    pending: 0,
    failed: 0,
    latestStatus: null,
    lastCollectedAt: null,
    control: { manualBlocked: false, retryAt: null, lastSeenAt: null, inProgress: false },
    keywords: ["kedai"],
    keywordIntents: { kedai: "phrase" },
    topicLabels: [],
    topicCountingApproved: false,
    highImpact: false,
    credentials: { x: configured, threads: false },
  };
}

describe("mention empty state", () => {
  it("does not ask for a first run when collection cannot start", () => {
    render(<MentionsScreen workspace={workspace(false)} now="2026-11-01T00:00:00.000Z" mode="sebutan" page={1} range="7" source="" query="" />);
    expect(screen.getByText("Data akan muncul setelah pengumpulan aktif.")).toBeTruthy();
    expect(screen.queryByText("Jalankan pengumpulan pertama untuk melihat hasil.")).toBeNull();
  });

  it("still asks for a first run when a selected source can run", () => {
    render(<MentionsScreen workspace={workspace(true)} now="2026-11-01T00:00:00.000Z" mode="sebutan" page={1} range="7" source="" query="" />);
    expect(screen.getByText("Jalankan pengumpulan pertama untuk melihat hasil.")).toBeTruthy();
  });
});

function complaint(): PresentedMention {
  return {
    id: "m1",
    source: "threads",
    excerpt: "Kopinya enak, tetapi saya ditagih dua kali.",
    url: "https://www.threads.com/@owner/post/direct",
    authorLabel: "Pemilik",
    handle: "@owner",
    initials: "P",
    postedAt: "2026-11-01T00:00:00.000Z",
    collectedAt: "2026-11-01T00:00:00.000Z",
    occurredAt: "2026-11-01T00:00:00.000Z",
    read: false,
    bucket: "included",
    sentiment: "mixed",
    relevance: "relevant",
    topics: [],
    relevanceConfidence: null,
    sentimentConfidence: null,
    corrected: false,
    confirmed: false,
    correctionAt: null,
    originalSentiment: "mixed",
    originalRelevance: "relevant",
    uncertainFields: [],
    needsAttention: true,
    attentionUnread: true,
    attentionId: null,
    sourcePostUnavailable: false,
    scoringStatus: "succeeded",
    textMatch: "literal_match",
    triage: {
      status: "completed",
      origin: "opencode",
      reason: "firsthand_complaint",
      sentiment: "mixed",
      issueCategory: "payment",
      verifiedExcerpt: "saya ditagih dua kali",
    },
  };
}

it("shows a mixed complaint and verified evidence on the attention route", () => {
  const mention = complaint();
  render(<MentionsScreen
    workspace={{ ...workspace(true), mentions: [mention] }}
    now="2026-11-01T00:00:00.000Z"
    mode="perlu-perhatian"
    page={1}
    range="7"
    source=""
    query=""
    reviewId="m1"
  />);
  expect(screen.getByRole("link", { name: "Tinjau penilaian" }).getAttribute("href")).toContain("/perlu-perhatian?");
  expect(screen.getByRole("link", { name: /Lihat postingan asli/ }).getAttribute("href")).toBe(mention.url);
  expect((screen.getByRole("radio", { name: "Campuran" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("Penilaian AI · Campuran")).toBeTruthy();
  expect(screen.getByText("Keluhan langsung dengan kutipan terverifikasi")).toBeTruthy();
  expect(screen.getByText("saya ditagih dua kali").tagName).toBe("BLOCKQUOTE");
  expect(screen.getAllByText("Pembayaran")).toHaveLength(2);
});

it("uses the manual route date in review queues while keeping the post date and counts", () => {
  const auto = complaint();
  const now = "2026-11-26T10:00:00.000Z";
  const attention: PresentedMention = { ...auto, manualRoute: { destination: "attention", routedAt: now } };
  const ambiguous: PresentedMention = {
    ...auto, bucket: "not_sure", needsAttention: false, attentionUnread: false,
    manualRoute: { destination: "ambiguous", routedAt: now },
  };
  const props = { now, page: 1, range: "7", source: "", query: "" };
  const view = (mode: "perlu-perhatian" | "belum-yakin" | "sebutan", mention: PresentedMention) =>
    <MentionsScreen {...props} mode={mode} workspace={{ ...workspace(true), mentions: [mention] }} />;
  const { rerender } = render(view("perlu-perhatian", attention));
  expect(screen.getByText("1–1 dari 1 sebutan")).toBeTruthy();
  expect(screen.getByText("Rute manual: Perlu perhatian")).toBeTruthy();
  expect(document.querySelector("time")?.dateTime).toBe(auto.postedAt);

  rerender(view("belum-yakin", ambiguous));
  expect(screen.getByText("1–1 dari 1 sebutan")).toBeTruthy();
  expect(screen.getByText("Rute manual: Belum yakin")).toBeTruthy();
  rerender(view("perlu-perhatian", ambiguous));
  expect(screen.queryByText(auto.excerpt)).toBeNull();
  rerender(view("sebutan", attention));
  expect(screen.queryByText(auto.excerpt)).toBeNull();
  rerender(view("perlu-perhatian", auto));
  expect(screen.queryByText(auto.excerpt)).toBeNull();
});
