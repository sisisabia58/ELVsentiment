import { randomUUID } from "node:crypto";
import type { Queryable } from "@/db/migrate";
import { withCustomer } from "@/db/migrate";
import { startOfJakartaDay } from "./filters";
import type { SearchLimits } from "./limits";
import { resolveProviderChain, SEARCH_PLATFORMS } from "./platforms";
import { loadProviderSettings } from "./provider-settings";

export type CreateInstantSearchInput = {
  query: string;
  intent: "phrase" | "hashtag";
  filters: {
    dateWindow: "all" | "24h" | "7d" | "30d" | "12m";
    sort: "relevance" | "newest" | "popular";
    language: "all" | "id" | "en";
  };
};

export type CreateInstantSearchResult =
  | { ok: true; searchId: string }
  | { ok: false; error: "daily_limit" | "invalid_query" };

const DATE_WINDOWS = ["all", "24h", "7d", "30d", "12m"] as const;
const SORT_MODES = ["relevance", "newest", "popular"] as const;
const LANGUAGES = ["all", "id", "en"] as const;
const SEARCH_DEADLINE_MS = 40 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function invalid(input: CreateInstantSearchInput): boolean {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length < 2 || query.length > 160) return true;
  if (input.intent !== "phrase" && input.intent !== "hashtag") return true;
  if (!DATE_WINDOWS.includes(input.filters.dateWindow)) return true;
  if (!SORT_MODES.includes(input.filters.sort)) return true;
  if (!LANGUAGES.includes(input.filters.language)) return true;
  return false;
}

export async function createInstantSearch(
  db: Queryable,
  customerId: string,
  input: CreateInstantSearchInput,
  now: Date,
  limits: SearchLimits,
): Promise<CreateInstantSearchResult> {
  if (invalid(input)) return { ok: false, error: "invalid_query" };
  const query = input.query.trim();
  const dayStart = startOfJakartaDay(now);
  return withCustomer(db, customerId, async () => {
    await db.query("select pg_advisory_xact_lock(hashtext($1::text))", [customerId]);
    const counted = await db.query<{ n: number }>(
      "select count(*)::int as n from instant_searches where customer_id = $1 and created_at >= $2",
      [customerId, dayStart.toISOString()],
    );
    if ((counted.rows[0]?.n ?? 0) >= limits.cariDailySearchLimit) {
      return { ok: false as const, error: "daily_limit" as const };
    }
    const settings = await loadProviderSettings(db);
    const searchId = randomUUID();
    const createdAt = now.toISOString();
    await db.query(
      `insert into instant_searches
         (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
          language_filter, status, created_at, deadline_at, retention_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10)`,
      [
        searchId,
        customerId,
        query,
        input.intent,
        input.filters.dateWindow,
        input.filters.sort,
        input.filters.language,
        createdAt,
        new Date(now.getTime() + SEARCH_DEADLINE_MS).toISOString(),
        new Date(now.getTime() + RETENTION_MS).toISOString(),
      ],
    );
    for (const platform of SEARCH_PLATFORMS) {
      const chain = resolveProviderChain(platform, settings);
      if (chain.length === 0) continue;
      await db.query(
        `insert into instant_search_sources
           (search_id, customer_id, platform, provider, state, safe_detail)
         values ($1, $2, $3, $4, 'queued', 'queued')`,
        [searchId, customerId, platform, chain[0]],
      );
    }
    return { ok: true as const, searchId };
  });
}
