// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TextMatchSummary } from "./text-match-summary";

afterEach(cleanup);

describe("text match summary", () => {
  it("shows the three proposed counts and the honest caption", () => {
    render(<TextMatchSummary counts={{ candidates: 12, literal: 7, unknown: 3 }} />);
    expect(screen.getByText("Kandidat 12 · Cocok teks 7 · Belum pasti 3")).toBeTruthy();
    expect(screen.getByText("Pencocokan teks, bukan verifikasi makna.")).toBeTruthy();
  });
});
