// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectsView } from "./projects-view";

afterEach(cleanup);

describe("projects view", () => {
  it("uses the shared source names for mixed sources", () => {
    const workspace = {
      displayName: "QA",
      email: "qa@example.com",
      initials: "QA",
      project: null,
      mentions: [],
      projects: [
        {
          id: "p1",
          name: "Barayam",
          initials: "B",
          sources: ["x", "threads", "instagram", "tiktok"],
          schedule: { mode: "off", intervalHours: 6 },
          nextRunAt: null,
          lastCollectedAt: null,
          keywordCount: 2,
        },
      ],
    } as never;

    render(<ProjectsView workspace={workspace} />);

    expect(screen.getByText(/2 variasi · X, Threads, Instagram, TikTok/)).toBeTruthy();
  });
});
