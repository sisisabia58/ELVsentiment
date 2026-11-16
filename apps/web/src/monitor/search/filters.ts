const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export type DateWindow = "all" | "24h" | "7d" | "30d" | "12m";
export type SortMode = "relevance" | "newest" | "popular";
export type LanguageFilter = "all" | "id" | "en";

export type SearchFilters = {
  dateWindow: DateWindow;
  sort: SortMode;
  language: LanguageFilter;
};

export const DEFAULT_FILTERS: SearchFilters = {
  dateWindow: "all",
  sort: "relevance",
  language: "all",
};

export const DATE_WINDOWS: DateWindow[] = ["all", "24h", "7d", "30d", "12m"];
export const SORT_MODES: SortMode[] = ["relevance", "newest", "popular"];
export const LANGUAGE_FILTERS: LanguageFilter[] = ["all", "id", "en"];

export const DATE_LABEL: Record<DateWindow, string> = {
  all: "Semua tanggal",
  "24h": "24 jam terakhir",
  "7d": "7 hari terakhir",
  "30d": "30 hari terakhir",
  "12m": "12 bulan terakhir",
};

export const DATE_SHORT_LABEL: Record<DateWindow, string> = {
  all: "Semua",
  "24h": "24 jam",
  "7d": "7 hari",
  "30d": "30 hari",
  "12m": "12 bulan",
};

export const SORT_LABEL: Record<SortMode, string> = {
  relevance: "Paling cocok",
  newest: "Terbaru",
  popular: "Terpopuler",
};

export const LANGUAGE_LABEL: Record<LanguageFilter, string> = {
  all: "Semua bahasa",
  id: "Bahasa Indonesia",
  en: "Inggris",
};

export const LANGUAGE_SHORT_LABEL: Record<LanguageFilter, string> = {
  all: "Semua",
  id: "Indonesia",
  en: "Inggris",
};

export const QUERY_MIN_LENGTH = 2;
export const QUERY_MAX_LENGTH = 160;

export function validateSearchInput(
  query: string,
  filters: SearchFilters,
): "invalid_query" | "query_too_long" | null {
  const text = typeof query === "string" ? query.trim() : "";
  if (text.length < QUERY_MIN_LENGTH) return "invalid_query";
  if (text.length > QUERY_MAX_LENGTH) return "query_too_long";
  if (!DATE_WINDOWS.includes(filters?.dateWindow)) return "invalid_query";
  if (!SORT_MODES.includes(filters?.sort)) return "invalid_query";
  if (!LANGUAGE_FILTERS.includes(filters?.language)) return "invalid_query";
  return null;
}

export function dateWindowDays(window: DateWindow): number | null {
  switch (window) {
    case "24h":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "12m":
      return 365;
    default:
      return null;
  }
}

export function dateCutoff(window: DateWindow, now: Date): Date | null {
  const days = dateWindowDays(window);
  if (days === null) return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function startOfJakartaDay(now: Date): Date {
  const shifted = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - JAKARTA_OFFSET_MS);
}
