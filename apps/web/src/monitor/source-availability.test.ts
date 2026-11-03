import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceCredentials } from "./policy";
import { sourceStatusLines } from "./source-status";

describe("source availability without an X token", () => {
  it("reports Threads from its token and leaves X unavailable", () => {
    expect(sourceCredentials({ THREADS_ACCESS_TOKEN: "test-threads-token" })).toEqual({
      x: false,
      threads: true,
    });
    expect(
      sourceStatusLines([{ source: "x", state: "unavailable", configured: false }]),
    ).toEqual(["Status X: Tidak tersedia"]);
  });

  it("does not read x-budget.json from sourceCredentials", () => {
    const source = readFileSync(new URL("./policy.ts", import.meta.url), "utf8");
    const start = source.indexOf("export function sourceCredentials");
    const nextExport = source.indexOf("\nexport ", start + 1);
    const body = nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
    expect(body).not.toContain("x-budget.json");
  });
});
