// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthForm } from "./auth-form";
import { OnboardingFlow } from "./onboarding-flow";

afterEach(cleanup);

describe("auth form", () => {
  it("submits email and password and shows the returned error", async () => {
    const action = vi.fn(async () => ({ error: "Email atau kata sandi salah." }));
    render(
      <AuthForm
        title="Masuk"
        submitLabel="Masuk"
        action={action}
        alternateHref="/daftar"
        alternateLabel="Belum punya akun? Daftar"
      />,
    );
    expect(screen.getByRole("link", { name: "Belum punya akun? Daftar" }).getAttribute("href")).toBe("/daftar");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Kata sandi"), { target: { value: "sandi-salah" } });
    fireEvent.click(screen.getByRole("button", { name: "Masuk" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Email atau kata sandi salah.");
    const [, formData] = action.mock.calls[0] as unknown as [unknown, FormData];
    expect(formData.get("email")).toBe("owner@example.com");
    expect(formData.get("password")).toBe("sandi-salah");
    expect([...formData.keys()].sort()).toEqual(["email", "password"]);
  });
});

describe("onboarding flow", () => {
  const created = {
    projectId: "00000000-0000-4000-8000-000000000001",
    brandName: "ayam geprek pak gembus",
    candidates: ["ayam geprek pak gembus", "geprek gembus"],
  };

  it("creates a project, saves the chosen variants, and links to the dashboard", async () => {
    const createProject = vi.fn(async () => created);
    const saveVariants = vi.fn(async () => ({ ok: true as const, active: ["geprek gembus"] }));
    render(<OnboardingFlow createProject={createProject} saveVariants={saveVariants} />);
    expect(screen.queryByLabelText(/customer/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "ayam geprek pak gembus" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat proyek" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledWith("ayam geprek pak gembus"));
    fireEvent.click(await screen.findByLabelText("geprek gembus"));
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await screen.findByText("Varian aktif disimpan.")).toBeTruthy();
    expect(saveVariants).toHaveBeenCalledWith(created.projectId, ["geprek gembus"]);
    expect(screen.getByRole("link", { name: "Ke dasbor" }).getAttribute("href")).toBe("/dasbor");
  });

  it("edits the existing project's variants instead of offering to create another project", async () => {
    const createProject = vi.fn(async () => created);
    const saveVariants = vi.fn(async () => ({ ok: true as const, active: ["geprek gembus", "ayam geprek pak gembus"] }));
    render(
      <OnboardingFlow
        createProject={createProject}
        saveVariants={saveVariants}
        existing={{ ...created, selected: ["geprek gembus"] }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Buat proyek" })).toBeNull();
    expect(screen.queryByLabelText("Nama merek")).toBeNull();
    expect((screen.getByLabelText("geprek gembus") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("ayam geprek pak gembus"));
    fireEvent.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await screen.findByText("Varian aktif disimpan.")).toBeTruthy();
    expect(saveVariants).toHaveBeenCalledWith(created.projectId, ["geprek gembus", "ayam geprek pak gembus"]);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("shows the editor's error when the save is rejected", async () => {
    const createProject = vi.fn(async () => created);
    const saveVariants = vi.fn(async () => ({ ok: false as const, reason: "empty" as const, value: "" }));
    render(<OnboardingFlow createProject={createProject} saveVariants={saveVariants} />);
    fireEvent.change(screen.getByLabelText("Nama merek"), { target: { value: "ayam geprek pak gembus" } });
    fireEvent.click(screen.getByRole("button", { name: "Buat proyek" }));
    fireEvent.click(await screen.findByRole("button", { name: "Simpan" }));
    expect(await screen.findByText("Varian tidak boleh kosong.")).toBeTruthy();
    expect(screen.queryByText("Varian aktif disimpan.")).toBeNull();
  });
});
