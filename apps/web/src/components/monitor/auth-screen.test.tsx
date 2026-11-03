// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "./auth-screen";

const refresh = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  refresh.mockClear();
  vi.useRealTimers();
});

const stale = "Terlalu banyak percobaan. Coba lagi dalam 15 menit.";

describe("sign-in lockout banner on the screen", () => {
  it("shows the banner from a still-active server expiry", () => {
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({ error: null })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={new Date(Date.now() + 15 * 60 * 1000).toISOString()}
        lockMessage={stale}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/Terlalu banyak percobaan/);
  });

  it("does not show a stale lockout query or cookie when the server reports no lock", () => {
    window.history.replaceState(null, "", "/masuk?error=Terlalu%20banyak%20percobaan");
    document.cookie = "lockout=Terlalu banyak percobaan. Coba lagi dalam 15 menit.";
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({ error: null })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={null}
        lockMessage={null}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Terlalu banyak percobaan/)).toBeNull();
  });

  it("keeps the server lock message when the browser clock is ahead of the expiry", () => {
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({ error: null })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={new Date(Date.now() - 60_000).toISOString()}
        lockMessage="Terlalu banyak percobaan. Coba lagi dalam 4 menit."
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Coba lagi dalam 4 menit");
  });

  it("shows the server minute count rather than one derived from the browser clock", () => {
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({ error: null })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={new Date(Date.now() + 15 * 60 * 1000).toISOString()}
        lockMessage="Terlalu banyak percobaan. Coba lagi dalam 5 menit."
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Coba lagi dalam 5 menit");
    expect(screen.getByRole("alert").textContent).not.toContain("15 menit");
  });

  it("shows the sign-in action's lock message when the browser clock is ahead of that expiry", async () => {
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({
          error: stale.replace("15", "4"),
          lockExpiresAt: new Date(Date.now() - 30_000).toISOString(),
        })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={null}
        lockMessage={null}
      />,
    );
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Coba lagi dalam 4 menit"));
  });

  it("asks the server to look again when the lock expiry is reached, and not before", () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({ error: null })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={expiresAt}
        lockMessage={stale}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh in a loop when the browser clock is already past a server lock", () => {
    vi.useFakeTimers();
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({ error: null })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={new Date(Date.now() - 60_000).toISOString()}
        lockMessage="Terlalu banyak percobaan. Coba lagi dalam 4 menit."
      />,
    );
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(refresh).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows no banner when the server reports no lock", () => {
    render(
      <AuthScreen
        title="Masuk ke Sentiment Monitor"
        lede="Masuk untuk melihat sentimen merek Anda hari ini."
        action={async () => ({ error: null })}
        submitLabel="Masuk"
        alternateHref="/daftar"
        alternatePrompt="Belum punya akun?"
        alternateLabel="Daftar"
        mode="sign-in"
        lockExpiresAt={null}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the lock expiry on the server and does not take it from the query string", () => {
    const page = readFileSync(path.join(import.meta.dirname, "../../app/masuk/page.tsx"), "utf8");
    const actions = readFileSync(path.join(import.meta.dirname, "../../app/masuk/actions.ts"), "utf8");
    expect(page).toContain("lockExpiresAt");
    expect(page).toContain("authThrottleLockExpiresAt");
    expect(page).not.toContain("searchParams");
    expect(actions).toContain("lockExpiresAt");
    expect(actions).not.toContain("error=");
  });
});
