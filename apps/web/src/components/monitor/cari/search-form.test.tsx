// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS } from "@/monitor/search/filters";
import { SearchForm } from "./search-form";

afterEach(cleanup);

describe("cari sekarang search form", () => {
  it("shows the cost note, filters, and submits query plus filters", () => {
    const onSubmit = vi.fn();
    render(<SearchForm onSubmit={onSubmit} />);
    expect(screen.getByText("1 kredit · Enter untuk mencari")).toBeTruthy();
    const input = screen.getByPlaceholderText(/Cari merek, produk, atau topik/);
    fireEvent.change(input, { target: { value: "barayam" } });
    fireEvent.click(screen.getByRole("button", { name: /Tanggal/ }));
    fireEvent.click(screen.getByRole("button", { name: "7 hari terakhir" }));
    fireEvent.click(screen.getByRole("button", { name: /Urutkan/ }));
    fireEvent.click(screen.getByRole("button", { name: "Terbaru" }));
    fireEvent.click(screen.getByRole("button", { name: /Bahasa/ }));
    fireEvent.click(screen.getByRole("button", { name: "Inggris" }));
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));
    expect(onSubmit).toHaveBeenCalledWith({
      query: "barayam",
      filters: { ...DEFAULT_FILTERS, dateWindow: "7d", sort: "newest", language: "en" },
    });
  });

  it("disables the input and submit while pending", () => {
    render(<SearchForm onSubmit={vi.fn()} pending />);
    expect(screen.getByRole("button", { name: "Cari" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByPlaceholderText(/Cari merek/).hasAttribute("disabled")).toBe(true);
  });

  it("rejects a too short query without submitting", () => {
    const onSubmit = vi.fn();
    render(<SearchForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText(/Cari merek/), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "Cari" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Kata kunci minimal 2 karakter.")).toBeTruthy();
  });

  it("fills an example chip into the input", () => {
    render(<SearchForm onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /barayam/ }));
    expect((screen.getByPlaceholderText(/Cari merek/) as HTMLInputElement).value).toBe("barayam");
  });
});
