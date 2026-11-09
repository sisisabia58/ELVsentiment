// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardModel } from "@/monitor/dashboard";
import { rangeWindow } from "@/monitor/range";
import { DashboardScreen } from "./dashboard-screen";

vi.mock("./monitor/charts", () => ({
  TrendChart: () => null,
  CompositionChart: () => null,
  VolumeChart: () => null,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
});

const base = {
  from: "",
  to: "",
  source: "",
  outcome: "none" as const,
  pending: 0,
  failed: 0,
  sourceState: "Tidak tersedia",
  onRunNow: () => undefined,
};

describe("dashboard screen", () => {
  it("uses the shared header, cards, and a clear keyword link", () => {
    const page = readFileSync(path.join(import.meta.dirname, "../app/dasbor/page.tsx"), "utf8");
    const screenSource = readFileSync(path.join(import.meta.dirname, "dashboard-screen.tsx"), "utf8");
    expect(page).toContain("<DashboardScreen");
    expect(page).toContain("<LogoutForm");
    expect(screenSource).toContain("<WorkspaceShell");
    expect(page).not.toContain("Ubah varian");
    expect(screenSource).not.toContain("Ubah varian");

    render(
      <DashboardScreen
        {...base}
        brandName="Ayam Geprek Uji"
        outcome="none"
        lastSuccess=""
        collection={{
          lastSeenAt: null,
          now: "2026-11-01T00:02:00.000Z",
          staleSeconds: 90,
          manualBlocked: false,
        }}
      />,
    );
    expect(screen.getAllByText("Sentiment Monitor").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 1, name: "Ringkasan" })).toBeTruthy();
    expect(screen.getAllByText(/Ayam Geprek Uji/).length).toBeGreaterThan(0);
    const perlu = screen.getByRole("link", { name: /Perlu perhatian/ });
    const belum = screen.getByRole("link", { name: /Belum yakin/ });
    expect(perlu.getAttribute("href")).toContain("/perlu-perhatian");
    expect(belum.getAttribute("href")).toContain("/belum-yakin");
    const keyword = screen.getByRole("link", { name: "Ubah kata kunci merek" });
    expect(keyword.getAttribute("href")).toBe("/onboarding");
    expect(screen.queryByText("Ubah varian")).toBeNull();
    expect(screen.queryByText("Worker offline")).toBeNull();
    expect(screen.getByText("Belum ada data.")).toBeTruthy();
    expect(screen.getByText("Pengumpul data sedang tidak aktif")).toBeTruthy();
    expect(screen.getByText("Belum ada pengumpulan data")).toBeTruthy();
    expect(screen.queryByText(/Pengumpulan terakhir berhasil/)).toBeNull();
    expect(screen.getByText("Status sumber: Tidak tersedia")).toBeTruthy();
    expect(screen.getByText("Belum ada topik yang dapat ditampilkan.")).toBeTruthy();
    expect(screen.getByText("Perhitungan awal")).toBeTruthy();
    expect(screen.queryByText("Rumus sementara")).toBeNull();
    expect(screen.queryByText(/Penilaian gagal/)).toBeNull();
    expect(screen.getByText("Jalankan pengumpulan pertama untuk melihat hasil.")).toBeTruthy();
    expect(document.querySelectorAll("[data-slot='card']").length).toBeGreaterThan(0);
    expect(page).toContain("readProjectCollection");
    expect(page).toContain("sourceStatusLines");
    expect(page).not.toContain("unavailable[0]");
    expect(page).not.toContain("pending={0}");
    expect(page).not.toContain('sourceState="Tidak tersedia"');
  });

  it("names the page when there is no project yet", () => {
    render(<DashboardScreen {...base} brandName={null} outcome="none" lastSuccess="" collection={null} />);
    expect(screen.getByRole("heading", { level: 1, name: "Dasbor" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Siapkan pemantauan" }).getAttribute("href")).toBe("/onboarding");
  });

  it("shows the last successful collection when one exists", () => {
    render(
      <DashboardScreen
        {...base}
        brandName="Ayam Geprek Uji"
        outcome="succeeded"
        lastSuccess="2026-11-01T00:00:00.000Z"
        sourceState="Siap"
        collection={null}
      />,
    );
    expect(screen.getByText("Pengumpulan terakhir berhasil 1 November 2026, 07.00 WIB")).toBeTruthy();
    expect(screen.queryByText(/T00:00:00/)).toBeNull();
    expect(screen.getByRole("link", { name: "Buat proyek" }).getAttribute("href")).toBe("/onboarding");
  });

  it("does not call an earlier success a success when the latest job failed", () => {
    render(
      <DashboardScreen
        {...base}
        brandName="Ayam Geprek Uji"
        outcome="failed"
        lastSuccess="2026-11-01T00:00:00.000Z"
        sourceState="Status sumber belum tercatat."
        collection={{
          lastSeenAt: "2026-11-01T00:01:00.000Z",
          now: "2026-11-01T00:02:00.000Z",
          staleSeconds: 90,
          manualBlocked: false,
        }}
      />,
    );
    expect(screen.getByText("Pengumpulan gagal. Ini bukan nol sebutan.")).toBeTruthy();
    expect(screen.queryByText(/Pengumpulan terakhir berhasil/)).toBeNull();
  });
});

describe("dashboard release 2", () => {
  it("wraps the run note inside the page width", () => {
    render(
      <DashboardScreen
        {...base}
        brandName="QA Test Brand"
        outcome="none"
        lastSuccess=""
        runNote="Sumber yang dipilih sedang tidak tersedia, kami sedang memperbaikinya."
        collection={{
          lastSeenAt: null,
          now: "2026-11-01T00:02:00.000Z",
          staleSeconds: 90,
          manualBlocked: true,
        }}
      />,
    );
    const note = screen.getByText("Sumber yang dipilih sedang tidak tersedia, kami sedang memperbaikinya.");
    expect(note.className).toContain("max-w-full");
    expect(note.className).toContain("break-words");
    const actions = note.closest("[data-page-actions]");
    expect(actions?.className).toContain("min-w-0");
    expect(actions?.className).toContain("max-w-full");
    expect(actions?.className ?? "").not.toContain("shrink-0");
    expect(screen.getByText("Data akan muncul setelah pengumpulan aktif.")).toBeTruthy();
    expect(screen.queryByText("Jalankan pengumpulan pertama untuk melihat hasil.")).toBeNull();
  });

  it("lists X and Threads on the data status card and hides a zero failure count", () => {
    render(
      <DashboardScreen
        {...base}
        brandName="QA Test Brand"
        outcome="none"
        failed={0}
        sourceLines={["Status X: Tidak tersedia", "Status Threads: Tidak tersedia"]}
        collection={null}
      />,
    );
    expect(screen.getByText("Status X: Tidak tersedia")).toBeTruthy();
    expect(screen.getByText("Status Threads: Tidak tersedia")).toBeTruthy();
    expect(screen.queryByText(/Penilaian gagal/)).toBeNull();
  });

  it("shows the failure line only when at least one score failed", () => {
    render(
      <DashboardScreen
        {...base}
        brandName="QA Test Brand"
        outcome="succeeded"
        lastSuccess="2026-11-01T00:00:00.000Z"
        failed={2}
        collection={null}
      />,
    );
    expect(screen.getByText("Penilaian gagal 2. Sebutan ini tidak dihitung sebagai netral.")).toBeTruthy();
  });
});

function touchModel(): DashboardModel {
  const now = new Date("2026-11-02T00:24:00.000Z");
  return {
    range: "7",
    window: rangeWindow("7", now),
    periodLabel: "7 hari terakhir",
    score: { kind: "score", value: 43, included: 7 },
    totals: { positif: 5, netral: 1, negatif: 1, total: 7 },
    attentionUnread: 1,
    uncertainOpen: 0,
    attentionInRange: 1,
    uncertainInRange: 0,
    comparison: { score: 93, mentions: 3, attention: -2, uncertain: 0 },
    points: [],
    gapLabels: [],
    topics: [{ label: "harga", count: 2 }],
    attentionItems: [],
    textMatch: { candidates: 7, literal: 4, unknown: 2 },
    unknownPostedAt: 0,
    partial: false,
  };
}

function expectFortyFour(element: Element | null | undefined) {
  const className = element?.getAttribute("class") ?? "";
  expect(className).toMatch(/min-h-\[44px\]|min-h-11/);
  expect(className).toMatch(/min-w-\[44px\]|min-w-11|w-full/);
}

describe("dashboard touch targets at 390px", () => {
  it("gives range pills, Sumber, Semua sumber, and inline links a 44px target without a fixed width over 390", () => {
    const view = document.createElement("div");
    view.style.width = "390px";
    document.body.appendChild(view);
    render(
      <DashboardScreen
        {...base}
        brandName="Ayam Geprek Pak Gembus"
        projectId="p1"
        outcome="succeeded"
        lastSuccess="2026-11-02T00:24:00.000Z"
        sourceLines={["Status X: Tidak tersedia"]}
        projects={[{ id: "p1", name: "Ayam Geprek Pak Gembus", initials: "AG" }]}
        model={touchModel()}
        collection={null}
      />,
      { container: view },
    );
    expect(view.style.width).toBe("390px");
    for (const name of ["7 hari", "30 hari", "90 hari", "Semua sumber"]) {
      expectFortyFour(screen.getByRole("link", { name }));
    }
    expectFortyFour(screen.getByText("Sumber"));
    expectFortyFour(screen.getByText("Perhitungan awal"));
    for (const name of ["Dalam filter ini", "Tinjau", "Lihat pengumpulan", "Ubah kata kunci merek", "Lihat semua", /^harga/]) {
      const link = screen.getByRole("link", { name });
      expectFortyFour(link);
      expect(link.className).not.toMatch(/w-\[\d{3,}px\]/);
      expect(link.className).toContain("max-w-full");
    }
    const shell = view.querySelector(".max-w-\\[1320px\\]");
    expect(shell?.className).toContain("w-full");
    expect(shell?.className).toContain("px-4");
  });
});

describe("dashboard collection", () => {
  it("keeps the run handler on the collect button", () => {
    const onRunNow = vi.fn();
    render(
      <DashboardScreen
        {...base}
        brandName="Ayam Geprek Uji"
        outcome="none"
        lastSuccess=""
        onRunNow={onRunNow}
        collection={{
          lastSeenAt: null,
          now: "2026-11-01T00:02:00.000Z",
          staleSeconds: 90,
          manualBlocked: false,
        }}
      />,
    );
    screen.getByRole("button", { name: "Jalankan sekarang" }).click();
    expect(onRunNow).toHaveBeenCalledTimes(1);
  });
});


describe("text match summary", () => {
  it("shows the proposed text-match counts without claiming semantic verification", () => {
    render(
      <DashboardScreen
        {...base}
        brandName="QA Test Brand"
        model={touchModel()}
        collection={null}
      />,
    );
    expect(screen.getByText("Kandidat 7 · Cocok teks 4 · Belum pasti 2")).toBeTruthy();
    expect(screen.getByText("Pencocokan teks, bukan verifikasi makna.")).toBeTruthy();
  });
});
