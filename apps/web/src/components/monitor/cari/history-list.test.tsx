// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryList } from "./history-list";

afterEach(cleanup);

describe("HistoryList", () => {
  it("hides stance chips until AI answers are enabled", () => {
    render(
      <HistoryList
        now={new Date("2026-11-16T10:00:00Z")}
        rows={[
          {
            id: "s1",
            query: "barayam",
            resultCount: 65,
            sourceCount: 7,
            stance: "campuran",
            status: "succeeded",
            createdAt: "2026-11-16T08:00:00Z",
          },
        ]}
      />,
    );
    expect(screen.queryByText("campuran")).toBeNull();
    expect(screen.getByRole("link", { name: "barayam" })).toBeTruthy();
  });

  it("shows query, counts, stance, relative time, and a reopen link", () => {
    render(
      <HistoryList
        aiEnabled
        now={new Date("2026-11-16T10:00:00Z")}
        rows={[
          {
            id: "s1",
            query: "barayam",
            resultCount: 65,
            sourceCount: 7,
            stance: "campuran",
            status: "succeeded",
            createdAt: "2026-11-16T08:00:00Z",
          },
          {
            id: "s2",
            query: "mandalika",
            resultCount: 0,
            sourceCount: 8,
            stance: null,
            status: "failed",
            createdAt: "2026-11-15T10:00:00Z",
          },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "barayam" });
    expect(link.getAttribute("href")).toBe("/cari/s1");
    expect(screen.getByText("65 hasil · 7 sumber")).toBeTruthy();
    expect(screen.getByText("campuran")).toBeTruthy();
    expect(screen.getByText(/2 jam/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "mandalika" }).getAttribute("href")).toBe("/cari/s2");
    expect(screen.queryAllByText("faktual")).toHaveLength(0);
  });

  it("renders an empty state", () => {
    render(<HistoryList rows={[]} />);
    expect(screen.getByText(/Belum ada pencarian/)).toBeTruthy();
  });
});
