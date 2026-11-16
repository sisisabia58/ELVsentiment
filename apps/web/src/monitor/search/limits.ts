import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SearchLimits = {
  cariDailySearchLimit: number;
};

function fromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid_${name}`);
  return parsed;
}

export function readSearchLimits(file?: string): SearchLimits {
  const configDir = process.env.CONFIG_DIR?.trim();
  const resolved =
    file ??
    (configDir
      ? path.join(configDir, "limits.json")
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../config/limits.json"));
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as {
    cari_daily_search_limit: number;
  };
  return {
    cariDailySearchLimit: fromEnv("CARI_DAILY_SEARCH_LIMIT", parsed.cari_daily_search_limit),
  };
}
