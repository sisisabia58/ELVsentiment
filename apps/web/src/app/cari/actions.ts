import type { Queryable } from "@/db/migrate";
import { parseKeyword } from "@/domain/keyword-intent";
import { cleanQuery, validateSearchInput, type SearchFilters } from "@/monitor/search/filters";
import type { SearchLimits } from "@/monitor/search/limits";
import { createInstantSearch } from "@/monitor/search/mutations";
import { cariSekarangEnabled, type Env } from "@/monitor/search/feature";

export type StartSearchResult =
  | { ok: true; searchId: string }
  | { ok: false; error: string };

export type StartSearchInput = {
  query: string;
  filters: SearchFilters;
};

export async function startSearchForCustomer(input: {
  db: Queryable;
  customerId: string;
  query: string;
  filters: SearchFilters;
  env?: Env;
  limits: SearchLimits;
  now: Date;
}): Promise<StartSearchResult> {
  if (!cariSekarangEnabled(input.env ?? process.env)) {
    return { ok: false, error: "disabled" };
  }
  if (typeof input.query !== "string") return { ok: false, error: "invalid_query" };
  const text = cleanQuery(input.query);
  const invalid = validateSearchInput(text, input.filters);
  if (invalid) return { ok: false, error: invalid };
  const keyword = parseKeyword(text);
  const created = await createInstantSearch(
    input.db,
    input.customerId,
    { query: keyword.text, intent: keyword.intent, filters: input.filters },
    input.now,
    input.limits,
  );
  return created.ok ? { ok: true, searchId: created.searchId } : { ok: false, error: created.error };
}
