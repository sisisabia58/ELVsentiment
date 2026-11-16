import { customerIdFromSessionToken } from "@/auth/session";
import { withSessionDeps } from "@/auth/request-session";
import type { Queryable } from "@/db/migrate";
import { parseKeyword } from "@/domain/keyword-intent";
import { validateSearchInput, type SearchFilters } from "@/monitor/search/filters";
import type { SearchLimits } from "@/monitor/search/limits";
import { readSearchLimits } from "@/monitor/search/limits";
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
  const keyword = parseKeyword(input.query);
  const invalid = validateSearchInput(keyword.text, input.filters);
  if (invalid) return { ok: false, error: invalid };
  const created = await createInstantSearch(
    input.db,
    input.customerId,
    { query: keyword.text, intent: keyword.intent, filters: input.filters },
    input.now,
    input.limits,
  );
  return created.ok ? { ok: true, searchId: created.searchId } : { ok: false, error: created.error };
}

export async function startSearchAction(input: StartSearchInput): Promise<StartSearchResult> {
  "use server";
  return withSessionDeps(async (deps) => {
    let customerId: string;
    try {
      customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    } catch {
      return { ok: false as const, error: "unauthenticated" };
    }
    return startSearchForCustomer({
      db: deps.db,
      customerId,
      query: input.query,
      filters: input.filters,
      env: process.env,
      limits: readSearchLimits(),
      now: new Date(),
    });
  });
}
