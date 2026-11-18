// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_SETTINGS,
  SEARCH_PLATFORMS,
  type SettingTarget,
} from "@/monitor/search/platforms";
import { ProviderSettingsForm, type ProviderSettingRow } from "./provider-settings-form";

afterEach(cleanup);

function rows(overrides: Partial<Record<SettingTarget, ProviderSettingRow>> = {}) {
  const targets: SettingTarget[] = [...SEARCH_PLATFORMS, "comments"];
  return targets.map(
    (target) =>
      overrides[target] ?? {
        target,
        ...DEFAULT_PROVIDER_SETTINGS[target],
      },
  );
}

describe("provider settings form", () => {
  it("offers only providers the platform supports plus Nonaktif", () => {
    render(<ProviderSettingsForm rows={rows()} onSave={vi.fn()} />);
    const instagram = screen.getByLabelText("Provider Instagram") as HTMLSelectElement;
    expect(Array.from(instagram.options).map((option) => option.value)).toEqual([
      "scrapeatlas",
      "off",
    ]);
    const youtube = screen.getByLabelText("Provider YouTube") as HTMLSelectElement;
    expect(Array.from(youtube.options).map((option) => option.value)).toEqual([
      "scrapeatlas",
      "off",
    ]);
  });

  it("saves the edited provider for one target", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    render(<ProviderSettingsForm rows={rows()} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Provider YouTube"), {
      target: { value: "off" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan YouTube" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        platform: "youtube",
        provider: "off",
        fallbackProvider: null,
        fallbackOnFailure: false,
      }),
    );
  });

  it("renders launch-unavailable platforms as read-only without a save button", () => {
    render(<ProviderSettingsForm rows={rows()} onSave={vi.fn()} />);
    expect(screen.getAllByText("Belum tersedia saat peluncuran").length).toBe(1);
    expect(screen.getByLabelText("Provider X")).toBeTruthy();
    expect(screen.queryByLabelText("Provider Web")).toBeNull();
    expect(screen.queryByRole("button", { name: "Simpan Web" })).toBeNull();
  });

  it("omits fallback controls when there is a single provider", () => {
    render(<ProviderSettingsForm rows={rows()} onSave={vi.fn()} />);
    expect(screen.queryByLabelText("Aktifkan cadangan Threads")).toBeNull();
  });

  it("shows a server rejection next to the row", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: false, error: "unsupported_provider" });
    render(<ProviderSettingsForm rows={rows()} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Simpan Instagram" }));
    await waitFor(() => expect(screen.getByText(/tidak didukung/i)).toBeTruthy());
  });
});
