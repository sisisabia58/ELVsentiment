// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";
import { SourceStatusList } from "./source-status-list";
import { VariantEditor } from "./variant-editor";
import { ScheduleEditor } from "./schedule-editor";

describe("onboarding", () => {
  it("shows the example brand, the candidate explanation, and no reply control", () => {
    render(
      <AppShell>
        <VariantEditor
          brandName="ayam geprek pak gembus"
          candidates={["ayam geprek pak gembus", "geprek gembus"]}
          selected={["geprek gembus"]}
          error="duplicate"
          onToggle={() => undefined}
          onAdd={() => undefined}
          onSave={() => undefined}
        />
      </AppShell>,
    );
    expect(screen.getAllByText("ayam geprek pak gembus").length).toBeGreaterThan(0);
    expect(screen.getAllByText("geprek gembus").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Kata kunci membantu mencari calon sebutan. Sistem memeriksa apakah setiap postingan benar-benar terkait merek Anda.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Varian ini sudah ada.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Balas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kirim" })).toBeNull();
  });

  it("does not render a failed collection as zero", () => {
    render(
      <SourceStatusList
        reports={[
          { source: "x", state: "rate_limited", outcome: "failed", fetchedCount: null },
          { source: "threads", state: "ready", outcome: "empty_unconfirmed", fetchedCount: null },
        ]}
      />,
    );
    expect(screen.getByText("Pengumpulan gagal. Ini bukan nol sebutan.")).toBeTruthy();
    expect(screen.getByText("Batas permintaan tercapai")).toBeTruthy();
    expect(
      screen.getByText(
        "Threads mengembalikan daftar kosong. Daftar kosong juga dipakai untuk kata yang dianggap sensitif, jadi ini bukan bukti bahwa tidak ada sebutan.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("labels an unavailable source instead of a bare status", () => {
    render(
      <SourceStatusList
        reports={[{ source: "threads", state: "unavailable", outcome: "failed", fetchedCount: null }]}
      />,
    );
    expect(screen.getByText("Status Threads: Tidak tersedia")).toBeTruthy();
    expect(screen.queryByText("Tidak tersedia")).toBeNull();
  });

  it("rejects a schedule shorter than the configured minimum", () => {
    const onSave = vi.fn();
    render(<ScheduleEditor enabled={false} intervalHours={6} minIntervalHours={6} onSave={onSave} />);
    expect(screen.getByText("Jadwal pengumpulan")).toBeTruthy();
    expect(screen.getByText("WIB")).toBeTruthy();
    expect(screen.queryByText("Asia/Jakarta")).toBeNull();
    fireEvent.change(screen.getByLabelText("Setiap berapa jam"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan jadwal" }));
    expect(screen.getByText("Jarak jadwal minimal 6 jam.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renders a reached cap as a sentence instead of zero", () => {
    render(
      <SourceStatusList
        reports={[
          { source: "x", state: "rate_limited", outcome: "failed", fetchedCount: null, detail: "x_customer_cap" },
          { source: "threads", state: "rate_limited", outcome: "failed", fetchedCount: null, detail: "threads_budget" },
          { source: "x", state: "rate_limited", outcome: "failed", fetchedCount: null, detail: "x_global_cap" },
        ]}
      />,
    );
    expect(screen.getByText("Batas baca X untuk pelanggan ini tercapai. Ini bukan nol sebutan.")).toBeTruthy();
    expect(screen.getByText("Batas baca X bersama tercapai. Ini bukan nol sebutan.")).toBeTruthy();
    expect(screen.getByText("Batas pencarian Threads tercapai. Ini bukan nol sebutan.")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("truthful source status labels", () => {
  it("labels an untested source as Belum diuji", () => {
    render(<SourceStatusList reports={[{ source: "threads", state: "untested", outcome: "success", fetchedCount: 0 }]} />);
    expect(screen.getByText("Belum diuji")).toBeTruthy();
    expect(screen.queryByText("Tidak tersedia")).toBeNull();
  });
});
