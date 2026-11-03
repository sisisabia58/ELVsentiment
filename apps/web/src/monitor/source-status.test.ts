import { describe, expect, it } from "vitest";
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
