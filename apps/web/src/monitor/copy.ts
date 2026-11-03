const numberFormat = new Intl.NumberFormat("id-ID");

export const SCORE_FORMULA_LABEL = "Perhitungan awal";

export const ONBOARDING_BRAND_HINT =
  "Contoh: ayam geprek pak gembus. Itu hanya contoh. Nama yang Anda ketik di kolom inilah yang tersimpan.";

export const ONBOARDING_SCHEDULE_HINT =
  "Pengumpulan otomatis belum aktif. Anda bisa membiarkannya nonaktif, atau memilih interval maupun jam tertentu dalam WIB.";

export const SCHEDULE_ZONE_HINT = "Waktu dalam WIB. Jarak jadwal minimal 6 jam.";

export function emptyCollectionBody(runAvailable: boolean): string {
  return runAvailable
    ? "Jalankan pengumpulan pertama untuk melihat hasil."
    : "Data akan muncul setelah pengumpulan aktif.";
}

export function scoringFailureCopy(failed: number): string | null {
  if (!Number.isFinite(failed) || failed <= 0) return null;
  return `Penilaian gagal ${numberFormat.format(Math.trunc(failed))}. Sebutan ini tidak dihitung sebagai netral.`;
}
