import { describe, expect, it } from "vitest";
import { resolveSourceState } from "./load";
import { sourceStatusLines } from "./source-status";

describe("dashboard source status", () => {
  it("lists Threads as well as X", () => {
    expect(
      sourceStatusLines([
        { source: "x", state: "unavailable", configured: false },
        { source: "threads", state: "unavailable", configured: false },
      ]),
    ).toEqual(["Status X: Tidak tersedia", "Status Threads: Tidak tersedia"]);
    expect(
      sourceStatusLines([
        { source: "x", state: "ready", configured: true },
        { source: "threads", state: "rate_limited", configured: true },
      ]),
    ).toEqual(["Status X: Siap", "Status Threads: Dibatasi sementara"]);
  });
});

describe("truthful source state", () => {
  it("derives untested only for configured sources with no row", () => {
    expect(resolveSourceState(false, null)).toBe("unavailable");
    expect(resolveSourceState(false, "ready")).toBe("unavailable");
    expect(resolveSourceState(true, null)).toBe("untested");
    for (const state of ["ready", "unavailable", "authorization_failed", "rate_limited"] as const) {
      expect(resolveSourceState(true, state)).toBe(state);
    }
  });

  it("renders Belum diuji for a configured source without a row", () => {
    expect(sourceStatusLines([{ source: "threads", state: "untested", configured: true }])).toEqual([
      "Status Threads: Belum diuji",
    ]);
  });
});
