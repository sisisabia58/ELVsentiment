import { afterEach, describe, expect, it } from "vitest";
import { readSearchLimits } from "./limits";

const previous = process.env.CARI_DAILY_SEARCH_LIMIT;

afterEach(() => {
  if (previous === undefined) delete process.env.CARI_DAILY_SEARCH_LIMIT;
  else process.env.CARI_DAILY_SEARCH_LIMIT = previous;
});

describe("readSearchLimits", () => {
  it("reads the shared default of 20", () => {
    delete process.env.CARI_DAILY_SEARCH_LIMIT;
    expect(readSearchLimits()).toEqual({ cariDailySearchLimit: 20 });
  });

  it("accepts an integer env override", () => {
    process.env.CARI_DAILY_SEARCH_LIMIT = "3";
    expect(readSearchLimits().cariDailySearchLimit).toBe(3);
  });

  it("rejects non-integers and values below one", () => {
    process.env.CARI_DAILY_SEARCH_LIMIT = "2.5";
    expect(() => readSearchLimits()).toThrow();
    process.env.CARI_DAILY_SEARCH_LIMIT = "abc";
    expect(() => readSearchLimits()).toThrow();
    process.env.CARI_DAILY_SEARCH_LIMIT = "0";
    expect(() => readSearchLimits()).toThrow();
  });
});
