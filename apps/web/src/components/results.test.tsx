// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionControls } from "./collection-controls";
import { DataStatusPanel, MentionFeed, OverviewPanel, TopicPanel, TrendPanel, withFilters } from "./results";

afterEach(() => {
  cleanup();
});

describe("results", () => {
  it("keeps filters and explains an empty score", () => {
    expect(withFilters("/dasbor/perlu-perhatian", { from: "2026-11-01", to: "2026-11-02", source: "x" })).toBe(
      "/dasbor/perlu-perhatian?from=2026-11-01&to=2026-11-02&source=x",
    );
    render(<OverviewPanel score={{ kind: "empty" }} included={0} formulaApproved={false} from="" to="" />);
    expect(screen.getByText("Belum ada sebutan yang dinilai")).toBeTruthy();
    expect(screen.getByText("Pilih rentang tanggal.")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("shows a failed mention as failed and a correction as the owner's", () => {
    render(
      <MentionFeed
        mentions={[
          {
            id: "1",
            excerpt: "geprek gembus mahal",
            source: "x",
            url: "https://x.com/ani/status/100",
            postedAt: "2026-11-01T00:00:00.000Z",
            relevance: "relevant",
            sentiment: null,
            topics: [],
            confidence: null,
            displaySource: "failed",
            scoringStatus: "failed",
            sourcePostUnavailable: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("Penilaian gagal")).toBeTruthy();
    expect(screen.queryByText("Netral")).toBeNull();
    expect(screen.getByText("Relevan")).toBeTruthy();
    expect(screen.queryByText("Seberapa yakin")).toBeNull();
    expect(screen.getByRole("link", { name: "Buka sumber" }).getAttribute("href")).toBe("https://x.com/ani/status/100");

    render(
      <MentionFeed
        mentions={[
          {
            id: "2",
            excerpt: "geprek gembus enak",
            source: "threads",
            url: "https://www.threads.net/@ani/post/200",
            postedAt: "2026-11-01T01:00:00.000Z",
            relevance: "irrelevant",
            sentiment: null,
            topics: [],
            confidence: 0.8,
            displaySource: "jev",
            scoringStatus: "succeeded",
            sourcePostUnavailable: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("Tidak relevan")).toBeTruthy();
    expect(screen.getByText("Seberapa yakin")).toBeTruthy();
    expect(screen.getByText("0.8")).toBeTruthy();
  });

  it("asks for a timezone instead of inventing a bucket", () => {
    render(
      <TrendPanel
        timeZone={null}
        bucket={null}
        rows={[{ createdAt: "2026-11-01", sentiment: "negative" }]}
        buckets={[]}
      />,
    );
    expect(screen.getByText("Pilih zona waktu dan ukuran kelompok sebelum grafik ditampilkan.")).toBeTruthy();
    expect(screen.getByText("Negatif")).toBeTruthy();
  });

  it("uses plain topic copy and hides the unapproved counting rule", () => {
    const unapproved = render(<TopicPanel counts={[{ label: "harga", count: 2 }]} countingApproved={false} />);
    expect(screen.getByText("Ringkasan topik akan tersedia segera.")).toBeTruthy();
    expect(screen.queryByText("Satu sebutan dihitung pada setiap label yang lolos ambang.")).toBeNull();
    expect(screen.queryByText("Aturan hitung topik menunggu persetujuan.")).toBeNull();
    expect(screen.getByText("harga 2")).toBeTruthy();
    expect(unapproved.container.querySelector("[data-slot='card']")).toBeTruthy();
    unapproved.unmount();

    render(<TopicPanel counts={[]} countingApproved={true} />);
    expect(screen.getByText("Satu sebutan bisa masuk ke beberapa topik.")).toBeTruthy();
    expect(screen.queryByText("Ringkasan topik akan tersedia segera.")).toBeNull();
  });

  it("shows an empty mention list instead of a blank card", () => {
    render(<MentionFeed mentions={[]} />);
    expect(screen.getByText("Belum ada sebutan.")).toBeTruthy();
  });

  it("shows an empty collection instead of a blank success line", () => {
    const empty = render(
      <DataStatusPanel outcome="none" lastSuccess="" pending={0} failed={0} sourceState="Tidak tersedia" />,
    );
    expect(screen.getByText("Belum ada pengumpulan data")).toBeTruthy();
    expect(screen.queryByText(/Pengumpulan terakhir berhasil/)).toBeNull();
    expect(screen.getByText("Status sumber: Tidak tersedia")).toBeTruthy();
    expect(screen.queryByText("Tidak tersedia")).toBeNull();
    expect(screen.queryByText(/Penilaian gagal/)).toBeNull();
    empty.unmount();

    render(
      <DataStatusPanel
        outcome="succeeded"
        lastSuccess="2026-11-01T00:00:00.000Z"
        pending={1}
        failed={1}
        sourceState="Siap"
      />,
    );
    expect(screen.getByText("Pengumpulan terakhir berhasil 1 November 2026, 07.00 WIB")).toBeTruthy();
    expect(screen.queryByText(/T00:00:00/)).toBeNull();
    expect(screen.getByText("Nilai keyakinan adalah ketidakpastian model, bukan jaminan kebenaran.")).toBeTruthy();
    expect(screen.getByText("Siap")).toBeTruthy();
  });

  it("says a newer failed collection is not zero mentions", () => {
    render(
      <DataStatusPanel
        outcome="failed"
        lastSuccess="2026-11-01T00:00:00.000Z"
        pending={0}
        failed={0}
        sourceState="Status sumber belum tercatat."
      />,
    );
    expect(screen.getByText("Pengumpulan gagal. Ini bukan nol sebutan.")).toBeTruthy();
    expect(screen.queryByText(/Pengumpulan terakhir berhasil/)).toBeNull();
    expect(screen.getByText("Status sumber belum tercatat.")).toBeTruthy();
    expect(screen.queryByText("Status sumber: Tidak tersedia")).toBeNull();
  });

  it("shows worker offline and rate-limits Kumpulkan sekarang", () => {
    const onRunNow = vi.fn();
    const { rerender } = render(
      <CollectionControls
        lastSeenAt={null}
        now="2026-11-01T00:02:00.000Z"
        staleSeconds={90}
        manualBlocked={false}
        onRunNow={onRunNow}
      />,
    );
    expect(screen.getByText("Pengumpul data sedang tidak aktif")).toBeTruthy();
    expect(screen.getByText("Kumpulkan sekarang akan memasukkan pekerjaan ke antrean.")).toBeTruthy();
    expect(screen.queryByText("Worker offline")).toBeNull();
    const collect = screen.getByRole("button", { name: "Kumpulkan sekarang" });
    expect(collect.getAttribute("data-slot")).toBe("button");
    expect(collect.hasAttribute("disabled")).toBe(false);
    fireEvent.click(collect);
    expect(onRunNow).toHaveBeenCalledTimes(1);
    rerender(
      <CollectionControls
        lastSeenAt="2026-11-01T00:01:00.000Z"
        now="2026-11-01T00:02:00.000Z"
        staleSeconds={90}
        manualBlocked={true}
        onRunNow={onRunNow}
      />,
    );
    expect(screen.getByText("Pengumpul data aktif")).toBeTruthy();
    expect(screen.queryByText("Kumpulkan sekarang akan memasukkan pekerjaan ke antrean.")).toBeNull();
    expect(screen.getByText("Tunggu 15 menit sebelum mengumpulkan lagi.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kumpulkan sekarang" }));
    expect(onRunNow).toHaveBeenCalledTimes(1);
  });

  it("says the job is queued after Run now returns ok", async () => {
    const onRunNow = vi.fn(async () => ({ ok: true as const }));
    render(
      <CollectionControls
        lastSeenAt={null}
        now="2026-11-01T00:02:00.000Z"
        staleSeconds={90}
        manualBlocked={false}
        onRunNow={onRunNow}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Kumpulkan sekarang" }));
    expect(await screen.findByText("Pekerjaan masuk antrean.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kumpulkan sekarang" }).hasAttribute("disabled")).toBe(false);
  });
});
