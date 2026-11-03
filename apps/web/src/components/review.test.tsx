// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AttentionList, NotSureList } from "./review";

afterEach(() => {
  cleanup();
});

describe("review", () => {
  it("shows one unread negative item and no high-impact badge", () => {
    render(
      <AttentionList
        items={[
          { id: "a", mentionId: "m1", reason: "negative", unread: true, confidence: 0.91, url: "https://x.com/ani/status/100", excerpt: "mahal" },
          { id: "b", mentionId: "m1", reason: "negative", unread: true, confidence: 0.91, url: "https://x.com/ani/status/100", excerpt: "mahal" },
        ]}
        markError={false}
      />,
    );
    expect(screen.getAllByText("Negatif")).toHaveLength(1);
    expect(screen.getByText("Baru")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tandai sudah dilihat" })).toBeTruthy();
    expect(screen.getByLabelText("1 baru")).toBeTruthy();
    expect(screen.getByText("Label dampak tinggi tidak ditampilkan sampai aturan dan metadata sumber disetujui.")).toBeTruthy();
    expect(screen.queryByText("Dampak tinggi")).toBeNull();
  });

  it("keeps the item unread when the update fails", () => {
    render(
      <AttentionList
        items={[{ id: "a", mentionId: "m1", reason: "negative", unread: true, confidence: 0.91, url: "https://x.com/ani/status/100", excerpt: "mahal" }]}
        markError
      />,
    );
    expect(screen.getByText("Status perhatian gagal diperbarui.")).toBeTruthy();
    expect(screen.getByText("Baru")).toBeTruthy();
  });

  it("requires an explicit sentiment choice when none is suggested", () => {
    render(
      <NotSureList
        item={{
          uncertain: "sentimen",
          originalLabel: "Negatif",
          confidence: 0.4,
          url: "https://www.threads.com/@ani/post/55",
          sentimentSuggested: null,
        }}
      />,
    );
    expect(screen.getByText("sentimen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Positif" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setujui label ini" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Balas" })).toBeNull();
  });
});
