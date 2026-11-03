// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard } from "./onboarding-wizard";

const saveOnboardingDraftAction = vi.hoisted(() =>
  vi.fn(async (fields: { projectId: string | null; step: number; brand: string; keywords: string[] }) => {
    void fields;
  }),
);
const clearOnboardingDraftAction = vi.hoisted(() => vi.fn(async () => undefined));
const saveProjectSettingsAction = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ ok: true; message: string } | { ok: false; error: string }> => ({
      ok: true,
      message: "tersimpan",
    }),
  ),
);
const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

vi.mock("@/app/onboarding/draft-actions", () => ({
  saveOnboardingDraftAction,
  clearOnboardingDraftAction,
}));

vi.mock("@/app/proyek/actions", () => ({
  saveProjectSettingsAction,
}));

vi.mock("@/app/onboarding/page-actions", () => ({
  createProjectForSession: vi.fn(),
}));

afterEach(() => {
  cleanup();
  saveOnboardingDraftAction.mockReset();
  saveOnboardingDraftAction.mockImplementation(async () => undefined);
  clearOnboardingDraftAction.mockClear();
  saveProjectSettingsAction.mockReset();
  saveProjectSettingsAction.mockImplementation(async () => ({ ok: true, message: "tersimpan" }));
  push.mockClear();
  document.cookie = "onboarding_draft=; Path=/; Max-Age=0";
});

const schedule = { mode: "off" as const, intervalHours: 6 };

function wizard(overrides: Partial<Parameters<typeof OnboardingWizard>[0]> = {}) {
  return (
    <OnboardingWizard
      existing={null}
      credentials={{ x: false, threads: true }}
      onRun={async () => ({ ok: true })}
      {...overrides}
    />
  );
}

describe("onboarding wizard", () => {
  it("shows a custom keyword in the list as soon as it is added", () => {
    render(wizard());
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "qa test brand" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    fireEvent.change(screen.getByLabelText("Variasi kata kunci"), { target: { value: "gembus spesial" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambahkan" }));
    expect(screen.getByRole("checkbox", { name: /gembus spesial/ })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /gembus spesial/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("marks a source without a server key as unavailable and not selectable", async () => {
    render(wizard());
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "qa test brand" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Lanjut" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    const x = screen.getByRole("checkbox", { name: /^X/ }) as HTMLInputElement;
    const threads = screen.getByRole("checkbox", { name: /^Threads/ }) as HTMLInputElement;
    expect(x.disabled).toBe(true);
    expect(x.checked).toBe(false);
    expect(screen.getByText("Tidak tersedia")).toBeTruthy();
    expect(threads.disabled).toBe(false);
    fireEvent.click(x);
    expect(x.checked).toBe(false);
  });

  it("opens on the saved step with the saved draft", () => {
    render(
      wizard({
        initial: {
          step: 2,
          brand: "kopi susu",
          keywords: ["kopi susu", "susu aren"],
          sources: ["threads"],
          schedule,
        },
      }),
    );
    expect(screen.getByRole("heading", { name: "Variasi kata kunci" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /susu aren/ })).toBeTruthy();
  });

  it("ignores a second Lanjut while the step submit is still in flight", async () => {
    let release: (() => void) | undefined;
    saveOnboardingDraftAction.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(wizard());
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "kopi susu" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect(saveOnboardingDraftAction).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: "Variasi kata kunci" })).toBeTruthy();
    const lanjut = screen.getByRole("button", { name: "Lanjut" });
    expect(lanjut.getAttribute("aria-busy")).toBe("true");
    expect((lanjut as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(lanjut);
    expect(screen.queryByRole("heading", { name: "Sumber" })).toBeNull();
    expect(window.location.search).toContain("langkah=2");
    expect(window.location.search).not.toContain("langkah=3");
    release?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Lanjut" }).getAttribute("aria-busy")).not.toBe("true"));
    expect(screen.getByRole("heading", { name: "Variasi kata kunci" })).toBeTruthy();
  });

  it("keeps Kembali off until Lanjut's save settles, then stores the earlier step", async () => {
    let release: (() => void) | undefined;
    saveOnboardingDraftAction.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(wizard());
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "kopi susu" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect(saveOnboardingDraftAction).toHaveBeenCalled());
    const kembali = screen.getByRole("button", { name: "Kembali" }) as HTMLButtonElement;
    expect(kembali.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Langkah 1: Merek" }) as HTMLButtonElement).disabled).toBe(true);
    release?.();
    await waitFor(() => expect((screen.getByRole("button", { name: "Kembali" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Kembali" }));
    expect(screen.getByRole("heading", { name: /Merek apa yang ingin Anda pantau/ })).toBeTruthy();
    await waitFor(() => {
      const last = saveOnboardingDraftAction.mock.calls.at(-1)?.[0];
      expect(last?.step).toBe(1);
      expect(last?.brand).toBe("kopi susu");
      expect(last?.keywords?.length ?? 0).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(saveOnboardingDraftAction.mock.calls.at(-1)?.[0]?.step).toBe(1);
  });

  it("writes a keyword edit only after the in-flight Lanjut save finishes", async () => {
    let active = 0;
    let overlapped = false;
    const pending: Array<{ keywords: string[]; release: () => void }> = [];
    saveOnboardingDraftAction.mockImplementation((fields) => {
      active += 1;
      if (active > 1) overlapped = true;
      return new Promise<void>((resolve) => {
        pending.push({
          keywords: fields.keywords,
          release: () => {
            active -= 1;
            resolve();
          },
        });
      });
    });
    render(wizard());
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "kopi susu" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Variasi kata kunci"), { target: { value: "susu aren" } });
    fireEvent.click(screen.getByRole("button", { name: "Tambahkan" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(overlapped).toBe(false);
    expect(pending).toHaveLength(1);
    pending[0]?.release();
    await waitFor(() => expect(pending.length).toBeGreaterThan(1));
    expect(overlapped).toBe(false);
    expect(pending.at(-1)?.keywords).toContain("susu aren");
  });

  it("writes the step into the URL and asks the server to store the draft", async () => {
    render(wizard());
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "kopi susu" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(window.location.search).toContain("langkah=2");
    await waitFor(() => {
      expect(saveOnboardingDraftAction).toHaveBeenCalledWith(
        expect.objectContaining({ step: 2, brand: "kopi susu", projectId: null }),
      );
    });
    const payload = saveOnboardingDraftAction.mock.calls.at(-1)?.[0];
    expect(payload).not.toHaveProperty("customerId");
    expect(document.cookie).not.toContain("onboarding_draft=");
    expect(document.cookie).not.toContain("kopi susu");
  });

  it("clears the draft after the project is saved", async () => {
    render(
      wizard({
        existing: {
          projectId: "p1",
          brandName: "kopi susu",
          keywords: ["kopi susu"],
          sources: ["threads"],
          schedule,
        },
        initial: { step: 5, brand: "kopi susu", keywords: ["kopi susu"], sources: ["threads"], schedule },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lewati dulu, ke dasbor" }));
    await waitFor(() => expect(clearOnboardingDraftAction).toHaveBeenCalled());
    expect(push).toHaveBeenCalledWith("/dasbor?proyek=p1");
  });

  it("keeps the draft when saving the project fails", async () => {
    saveProjectSettingsAction.mockResolvedValueOnce({ ok: false, error: "Variasi kata kunci terlalu panjang." });
    render(
      wizard({
        existing: {
          projectId: "p1",
          brandName: "kopi susu",
          keywords: ["kopi susu"],
          sources: ["threads"],
          schedule,
        },
        initial: { step: 5, brand: "kopi susu", keywords: ["kopi susu"], sources: ["threads"], schedule },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Lewati dulu, ke dasbor" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("terlalu panjang"));
    expect(clearOnboardingDraftAction).not.toHaveBeenCalled();
  });

  it("explains the example and the inactive schedule without Asia/Jakarta", async () => {
    render(wizard({ credentials: { x: true, threads: true } }));
    expect(screen.getByText(/ayam geprek pak gembus/)).toBeTruthy();
    expect(screen.queryByText(/tidak disimpan sampai Anda mengetiknya/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "kopi susu" } });
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Lanjut" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Lanjut" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Lanjut" }));
    expect(screen.queryByText(/Jadwal dimulai nonaktif/)).toBeNull();
    expect(screen.queryByText(/Asia\/Jakarta/)).toBeNull();
    expect(screen.getAllByText(/WIB/).length).toBeGreaterThan(0);
  });
});
