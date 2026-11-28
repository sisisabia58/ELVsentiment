// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  monitorAsProjectAction, readCariReviewAction, routeCariResultAction, undoCariRouteAction,
} from "@/app/cari/start-action";
import type { SnapshotResult } from "@/monitor/search/load";
import type { ReviewReadResult } from "@/monitor/search/review-routing";
import { ResultReviewDialog } from "./result-review-dialog";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/cari/start-action", () => ({
  monitorAsProjectAction: vi.fn(), readCariReviewAction: vi.fn(),
  routeCariResultAction: vi.fn(), undoCariRouteAction: vi.fn(),
}));

const evidence: SnapshotResult = {
  id: "paged-result", platform: "threads", externalId: "th-1",
  authorName: "Rizky", authorHandle: "rizky", url: "https://www.threads.com/@rizky/post/abc",
  text: "Pesanan kedai saya belum datang.", title: null, publishedAt: null, thumbnailUrl: null,
  views: null, likes: null, replies: null, shares: null, relevance: "literal_match", language: "id",
  rank: null, collectedAt: "2026-11-26T10:00:00Z",
};
const key = { searchId: "search", resultId: evidence.id, projectId: "project" };
const pending: Extract<ReviewReadResult, { ok: true }> = {
  ok: true, evidence, mentionId: "mention", triage: { status: "pending", judgment: null },
  route: { destination: null, revision: null },
};

function open(projectId: string | null = key.projectId) {
  render(<ResultReviewDialog
    open
    onClose={() => {}}
    searchId={key.searchId}
    resultId={key.resultId}
    result={evidence}
    projectId={projectId}
    projectName={projectId ? "Kedai Contoh" : null}
    returnFocus={{ current: null }}
  />);
}

function choice(name: string) {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readCariReviewAction).mockResolvedValue(pending);
});
afterEach(cleanup);

it("shows the named project, retained post and pending judgment before allowing routing", async () => {
  open();
  expect(screen.getByRole("dialog", { name: "Tinjau unggahan" })).toBeTruthy();
  expect(screen.getByText("Kedai Contoh")).toBeTruthy();
  expect(screen.getByText(evidence.text)).toBeTruthy();
  expect(screen.getByRole("link", { name: /Buka unggahan asli di Threads/ }).getAttribute("href")).toBe(evidence.url);
  expect(choice("Perlu perhatian").disabled).toBe(true);
  expect(await screen.findByText("Menunggu penilaian")).toBeTruthy();
  expect(choice("Perlu perhatian").disabled).toBe(false);
  expect(readCariReviewAction).toHaveBeenCalledExactlyOnceWith(key);
});

it("shows an existing judgment and its verified excerpt separately from the saved route", async () => {
  vi.mocked(readCariReviewAction).mockResolvedValue({
    ...pending, route: { destination: "ambiguous", revision: "latest" },
    triage: { status: "completed", judgment: {
      destination: "attention", origin: "opencode", relevanceTier: "literal_match", sentiment: "negative",
      reason: "firsthand_complaint", issueCategory: "order_fulfillment", verifiedExcerpt: "pesanan saya belum datang",
    } },
  });
  open();
  expect((await screen.findByText("pesanan saya belum datang")).tagName).toBe("BLOCKQUOTE");
  expect(screen.getByText("Otomatis: Perlu perhatian")).toBeTruthy();
  expect(screen.getByText("Keluhan langsung dengan kutipan terverifikasi")).toBeTruthy();
  expect(screen.getByText("Rute manual: Belum yakin")).toBeTruthy();
});

it("prevents routing when Pantau cannot admit the post", async () => {
  vi.mocked(readCariReviewAction).mockResolvedValue({ ok: false, error: "ineligible" });
  open();
  expect(await screen.findByText("Unggahan ini tidak memenuhi syarat untuk proyek aktif.")).toBeTruthy();
  expect(choice("Perlu perhatian").disabled).toBe(true);
  expect(choice("Belum yakin").disabled).toBe(true);
});

it("uses the search to start project onboarding when there is no active project", async () => {
  vi.mocked(monitorAsProjectAction).mockResolvedValue({
    ok: true, href: "/onboarding?baru=1",
    fields: {
      projectId: null, step: 1, brand: "Kedai", keywords: ["kedai"], sources: ["threads"],
      schedule: { mode: "off", intervalHours: 6 },
    },
  });
  open(null);
  expect(screen.getByText("Belum ada proyek aktif.")).toBeTruthy();
  expect(choice("Perlu perhatian").disabled).toBe(true);
  fireEvent.click(choice("Pantau sebagai proyek"));
  await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding?baru=1"));
  expect(monitorAsProjectAction).toHaveBeenCalledExactlyOnceWith(key.searchId);
  expect(readCariReviewAction).not.toHaveBeenCalled();
});

it.each([
  ["attention", "Perlu perhatian"], ["ambiguous", "Belum yakin"],
] as const)("saves %s and undoes that revision from the search", async (destination, label) => {
  vi.mocked(routeCariResultAction).mockResolvedValue({
    ok: true, mentionId: "mention", route: { destination, revision: "saved" },
  });
  vi.mocked(undoCariRouteAction).mockResolvedValue({
    ok: true, mentionId: "mention", route: { destination: null, revision: "undone" },
  });
  open();
  await screen.findByText("Menunggu penilaian");
  fireEvent.click(choice(label));
  expect(await screen.findByText(`Disimpan ke ${label}.`)).toBeTruthy();
  expect(routeCariResultAction).toHaveBeenCalledExactlyOnceWith({
    ...key, destination, expectedRevision: null, requestId: expect.any(String),
  });
  fireEvent.click(choice("Urungkan"));
  expect(await screen.findByText("Keputusan diurungkan.")).toBeTruthy();
  expect(undoCariRouteAction).toHaveBeenCalledExactlyOnceWith({
    projectId: key.projectId, mentionId: "mention", revision: "saved",
  });
  expect(screen.queryByText(/^Rute manual:/)).toBeNull();
});

it("refreshes the route after a stale write and waits for a new choice", async () => {
  vi.mocked(readCariReviewAction).mockResolvedValueOnce(pending).mockResolvedValue({
    ...pending, route: { destination: "ambiguous", revision: "newer" },
  });
  vi.mocked(routeCariResultAction).mockResolvedValueOnce({ ok: false, error: "conflict" }).mockResolvedValue({
    ok: true, mentionId: "mention", route: { destination: "attention", revision: "saved" },
  });
  open();
  await screen.findByText("Menunggu penilaian");
  const trigger = choice("Perlu perhatian");
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(await screen.findByText("Rute manual: Belum yakin")).toBeTruthy();
  const conflict = screen.getByText("Rute berubah di tempat lain. Periksa rute terbaru sebelum memilih lagi.");
  expect(document.activeElement).toBe(conflict);
  expect(routeCariResultAction).toHaveBeenCalledTimes(1);
  fireEvent.click(choice("Perlu perhatian"));
  expect(await screen.findByText("Disimpan ke Perlu perhatian.")).toBeTruthy();
  expect(routeCariResultAction).toHaveBeenLastCalledWith({
    ...key, destination: "attention", expectedRevision: "newer", requestId: expect.any(String),
  });
});

it("shows the latest route from a replay without offering Undo", async () => {
  vi.mocked(routeCariResultAction).mockResolvedValue({
    ok: true, mentionId: "mention", route: { destination: "ambiguous", revision: "newer" }, replayed: true,
  });
  open();
  await screen.findByText("Menunggu penilaian");
  fireEvent.click(choice("Perlu perhatian"));
  expect(await screen.findByText("Rute manual: Belum yakin")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Urungkan" })).toBeNull();
});

it("shows an absent judgment before the post is saved", async () => {
  vi.mocked(readCariReviewAction).mockResolvedValue({ ...pending, mentionId: null, triage: null });
  open();
  expect(await screen.findByText("Belum ada penilaian otomatis.")).toBeTruthy();
});

it("retries a lost save response with the same ID and offers Undo for the recovered save", async () => {
  vi.mocked(routeCariResultAction)
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce({
      ok: true, mentionId: "mention", route: { destination: "attention", revision: "recovered" },
    });
  vi.mocked(undoCariRouteAction).mockResolvedValue({
    ok: true, mentionId: "mention", route: { destination: null, revision: "undone" },
  });
  open();
  await screen.findByText("Menunggu penilaian");
  fireEvent.click(choice("Perlu perhatian"));
  expect(await screen.findByText("Keputusan gagal disimpan. Coba lagi.")).toBeTruthy();
  fireEvent.click(choice("Perlu perhatian"));
  expect(await screen.findByText("Disimpan ke Perlu perhatian.")).toBeTruthy();
  const [initial, retried] = vi.mocked(routeCariResultAction).mock.calls;
  expect(retried[0]).toEqual(initial[0]);
  fireEvent.click(choice("Urungkan"));
  expect(await screen.findByText("Keputusan diurungkan.")).toBeTruthy();
  expect(undoCariRouteAction).toHaveBeenCalledExactlyOnceWith({
    projectId: key.projectId, mentionId: "mention", revision: "recovered",
  });
});
