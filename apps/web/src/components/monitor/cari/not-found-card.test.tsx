// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CariNotFoundCard } from "./not-found-card";

afterEach(cleanup);

describe("CariNotFoundCard", () => {
  it("renders the Indonesian not-found copy and a way back to Cari", () => {
    render(<CariNotFoundCard />);
    expect(screen.getByText("Pencarian tidak ditemukan.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Kembali ke Cari sekarang" });
    expect(link.getAttribute("href")).toBe("/cari");
  });
});
