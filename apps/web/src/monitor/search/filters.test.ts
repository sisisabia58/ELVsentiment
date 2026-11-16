import { describe, expect, it } from "vitest";
import {
  DATE_LABEL,
  DEFAULT_FILTERS,
  LANGUAGE_LABEL,
  SORT_LABEL,
  dateCutoff,
  dateWindowDays,
  startOfJakartaDay,
  validateSearchInput,
} from "./filters";

describe("cari sekarang filters", () => {
  it("rejects blank, too short, too long, and invalid filters", () => {
    expect(validateSearchInput(" ", DEFAULT_FILTERS)).toBe("invalid_query");
    expect(validateSearchInput("a", DEFAULT_FILTERS)).toBe("invalid_query");
    expect(validateSearchInput("a".repeat(161), DEFAULT_FILTERS)).toBe("query_too_long");
    expect(validateSearchInput("barayam", { ...DEFAULT_FILTERS, dateWindow: "2d" as never })).toBe(
      "invalid_query",
    );
    expect(validateSearchInput("barayam", { ...DEFAULT_FILTERS, sort: "random" as never })).toBe(
      "invalid_query",
    );
    expect(validateSearchInput("barayam", { ...DEFAULT_FILTERS, language: "fr" as never })).toBe(
      "invalid_query",
    );
    expect(validateSearchInput("  barayam  ", DEFAULT_FILTERS)).toBeNull();
    expect(validateSearchInput("a".repeat(160), DEFAULT_FILTERS)).toBeNull();
  });

  it("strips zero-width characters and rejects control characters", () => {
    expect(validateSearchInput("\u200B\u200C\u200D\u2060\uFEFF", DEFAULT_FILTERS)).toBe(
      "invalid_query",
    );
    expect(validateSearchInput("  \u200Bbarayam\u200D \u2060", DEFAULT_FILTERS)).toBeNull();
    expect(validateSearchInput("bar\u0000ayam", DEFAULT_FILTERS)).toBe("invalid_query");
    expect(validateSearchInput("bar\u0001ayam", DEFAULT_FILTERS)).toBe("invalid_query");
    expect(validateSearchInput("bar\u007Fayam", DEFAULT_FILTERS)).toBe("invalid_query");
  });

  it("computes date windows and a Jakarta-day start", () => {
    expect(dateWindowDays("24h")).toBe(1);
    expect(dateWindowDays("7d")).toBe(7);
    expect(dateWindowDays("30d")).toBe(30);
    expect(dateWindowDays("12m")).toBe(365);
    expect(dateWindowDays("all")).toBeNull();
    expect(startOfJakartaDay(new Date("2026-11-16T10:00:00Z")).toISOString()).toBe(
      "2026-11-15T17:00:00.000Z",
    );
  });

  it("returns a cutoff only for bounded windows", () => {
    const now = new Date("2026-11-16T10:00:00Z");
    expect(dateCutoff("all", now)).toBeNull();
    expect(dateCutoff("24h", now)?.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(dateCutoff("7d", now)?.toISOString()).toBe("2026-11-09T10:00:00.000Z");
  });

  it("uses the mockup labels", () => {
    expect(DATE_LABEL.all).toBe("Semua tanggal");
    expect(DATE_LABEL["24h"]).toBe("24 jam terakhir");
    expect(DATE_LABEL["7d"]).toBe("7 hari terakhir");
    expect(DATE_LABEL["30d"]).toBe("30 hari terakhir");
    expect(DATE_LABEL["12m"]).toBe("12 bulan terakhir");
    expect(SORT_LABEL.relevance).toBe("Paling cocok");
    expect(SORT_LABEL.newest).toBe("Terbaru");
    expect(SORT_LABEL.popular).toBe("Terpopuler");
    expect(LANGUAGE_LABEL.all).toBe("Semua bahasa");
    expect(LANGUAGE_LABEL.id).toBe("Bahasa Indonesia");
    expect(LANGUAGE_LABEL.en).toBe("Inggris");
  });
});
