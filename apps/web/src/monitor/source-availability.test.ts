// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SourceChoices } from "../components/monitor/source-choices";
import { sourceCredentials } from "./policy";
import { sourceStatusLines } from "./source-status";

afterEach(cleanup);

describe("source availability without an X token", () => {
  it("reports Threads from its token and leaves X unavailable", () => {
    expect(sourceCredentials({ THREADS_ACCESS_TOKEN: "test-threads-token" })).toEqual({
      x: false,
      threads: true,
      instagram: false,
      tiktok: false,
    });
    expect(
      sourceCredentials({
        X_BEARER_TOKEN: "x-token",
        SCRAPECREATORS_API_KEY: "sc-key",
      }),
    ).toEqual({
      x: true,
      threads: true,
      instagram: true,
      tiktok: true,
    });
    expect(sourceCredentials({ X_BEARER_TOKEN: "x-token" })).toEqual({
      x: true,
      threads: false,
      instagram: false,
      tiktok: false,
    });
    expect(
      sourceStatusLines([{ source: "x", state: "unavailable", configured: false }]),
    ).toEqual(["Status X: Tidak tersedia"]);
  });

  it("does not read x-budget.json from sourceCredentials", () => {
    const source = readFileSync(path.resolve(__dirname, "./policy.ts"), "utf8");
    const start = source.indexOf("export function sourceCredentials");
    const nextExport = source.indexOf("\nexport ", start + 1);
    const body = nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
    expect(body).not.toContain("x-budget.json");
  });

  it("renders checkboxes for X, Threads, Instagram, and TikTok with unavailable hints when unconfigured", () => {
    render(
      createElement(SourceChoices, {
        credentials: { x: true, threads: true, instagram: false, tiktok: false },
        selected: ["x", "threads"],
        onChange: () => undefined,
      }),
    );
    expect(screen.getByRole("checkbox", { name: /^X/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^Threads/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^Instagram/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /^TikTok/ })).toBeTruthy();
    expect(
      screen.getByText("Sumber Instagram sedang tidak tersedia, kami sedang memperbaikinya."),
    ).toBeTruthy();
    expect(
      screen.getByText("Sumber TikTok sedang tidak tersedia, kami sedang memperbaikinya."),
    ).toBeTruthy();
  });
});


describe("configured source copy", () => {
  it("does not call a configured source unavailable in settings or onboarding copy", () => {
    render(
      createElement(SourceChoices, {
        credentials: { x: true, threads: true, instagram: true, tiktok: true },
        selected: ["x", "threads"],
        onChange: () => undefined,
      }),
    );
    expect(screen.queryByText(/sedang tidak tersedia/)).toBeNull();
  });
});
