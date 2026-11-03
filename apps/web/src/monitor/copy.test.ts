import { describe, expect, it } from "vitest";
import {
  ONBOARDING_BRAND_HINT,
  ONBOARDING_SCHEDULE_HINT,
  SCHEDULE_ZONE_HINT,
  SCORE_FORMULA_LABEL,
  emptyCollectionBody,
  scoringFailureCopy,
} from "./copy";

describe("release 2 copy", () => {
  it("does not tell the owner to run a first collection when Run now is unavailable", () => {
    expect(emptyCollectionBody(false)).toBe("Data akan muncul setelah pengumpulan aktif.");
    expect(emptyCollectionBody(false)).not.toContain("Jalankan pengumpulan pertama");
    expect(emptyCollectionBody(true)).toBe("Jalankan pengumpulan pertama untuk melihat hasil.");
  });

  it("names the score formula Perhitungan awal", () => {
    expect(SCORE_FORMULA_LABEL).toBe("Perhitungan awal");
    expect(SCORE_FORMULA_LABEL).not.toContain("Rumus sementara");
  });

  it("hides the scoring failure line when nothing failed", () => {
    expect(scoringFailureCopy(0)).toBeNull();
    expect(scoringFailureCopy(2)).toBe("Penilaian gagal 2. Sebutan ini tidak dihitung sebagai netral.");
  });

  it("explains the brand example and the inactive schedule in plain Indonesian, using WIB", () => {
    expect(ONBOARDING_BRAND_HINT).toContain("ayam geprek pak gembus");
    expect(ONBOARDING_BRAND_HINT).not.toContain("tidak disimpan sampai Anda mengetiknya");
    expect(ONBOARDING_BRAND_HINT.toLocaleLowerCase("id-ID")).toContain("ketik");
    expect(ONBOARDING_SCHEDULE_HINT).not.toContain("Jadwal dimulai nonaktif");
    expect(ONBOARDING_SCHEDULE_HINT).toContain("WIB");
    expect(ONBOARDING_SCHEDULE_HINT).not.toContain("Asia/Jakarta");
    expect(SCHEDULE_ZONE_HINT).toContain("WIB");
    expect(SCHEDULE_ZONE_HINT).toContain("6 jam");
    expect(SCHEDULE_ZONE_HINT).not.toContain("Asia/Jakarta");
  });
});
