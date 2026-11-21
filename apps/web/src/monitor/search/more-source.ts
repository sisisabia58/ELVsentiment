import { randomUUID } from "node:crypto";
import { withCustomer, type Queryable } from "@/db/migrate";
import { cariMoreEnabled, type Env } from "./feature";
import { startOfJakartaDay } from "./filters";
import { isUuid } from "./search-id";
import { SEARCH_RELEVANCE_VERSION } from "./relevance";

const PLATFORMS = new Set(["tiktok", "youtube", "instagram", "facebook", "x", "reddit", "linkedin"]);
const PAGE_CAP = 3;

export type MoreSourceState = {
  generation: number;
  state: "available" | "pending" | "exhausted" | "failed";
  added: number | null;
};

export type RequestMoreResult =
  | { ok: true; jobId: string }
  | { ok: false; error: "disabled" | "unavailable" | "daily_limit" | "unauthenticated" };

export async function requestMoreSource(input: {
  db: Queryable;
  customerId: string;
  searchId: unknown;
  platform: unknown;
  generation: unknown;
  dailyLimit: number;
  env?: Env;
}): Promise<RequestMoreResult> {
  if (!cariMoreEnabled(input.env)) return { ok: false, error: "disabled" };
  const { db, customerId, searchId, platform, generation } = input;
  if (!isUuid(searchId) || typeof platform !== "string" || !PLATFORMS.has(platform) ||
      typeof generation !== "number" || !Number.isInteger(generation) || generation < 0 || generation >= PAGE_CAP) {
    return { ok: false, error: "unavailable" };
  }

  return withCustomer(db, customerId, async () => {
    await db.query("select pg_advisory_xact_lock(hashtext($1::text))", [customerId]);
    const key = [searchId, customerId, platform, generation];
    const existing = await db.query<{ id: string }>(
      `select j.id from instant_search_more_jobs j
       join instant_searches s on s.id = j.search_id and s.customer_id = j.customer_id
       where j.search_id = $1 and j.customer_id = $2 and j.platform = $3 and j.generation = $4
         and s.retention_expires_at > now()`, key,
    );
    if (existing.rows[0]) return { ok: true, jobId: existing.rows[0].id };

    const counted = await db.query<{ n: number }>(
      "select count(*)::int as n from instant_search_more_jobs where customer_id = $1 and created_at >= $2",
      [customerId, startOfJakartaDay(new Date()).toISOString()],
    );
    if ((counted.rows[0]?.n ?? 0) >= input.dailyLimit) return { ok: false, error: "daily_limit" };

    const admitted = await db.query<{ id: string }>(
      `insert into instant_search_more_jobs (id, search_id, customer_id, platform, generation)
       select $5, c.search_id, c.customer_id, c.platform, c.generation
       from instant_search_continuations c
       join instant_searches s on s.id = c.search_id and s.customer_id = c.customer_id
       where c.search_id = $1 and c.customer_id = $2 and c.platform = $3 and c.generation = $4
         and c.available and c.expires_at > now() and s.retention_expires_at > now()
         and s.status in ('succeeded', 'partial') and s.finished_at is not null
         and s.relevance_version = $6
       returning id`, [...key, randomUUID(), SEARCH_RELEVANCE_VERSION],
    );
    return admitted.rows[0] ? { ok: true, jobId: admitted.rows[0].id } : { ok: false, error: "unavailable" };
  });
}

export async function loadMoreSources(db: Queryable, customerId: string, searchId: string) {
  const { rows } = await db.query<{
    platform: string;
    generation: number;
    live: boolean;
    status: string | null;
    new_result_count: number | null;
    any_added: boolean;
  }>(
    `select c.platform, c.generation, c.available and c.expires_at > now() as live,
            latest.status, latest.new_result_count,
            exists (select 1 from instant_search_more_jobs added
                    where added.search_id = c.search_id and added.platform = c.platform
                      and added.status = 'succeeded' and added.new_result_count > 0) as any_added
     from instant_search_continuations c
     left join lateral (
       select j.status, j.new_result_count from instant_search_more_jobs j
       where j.search_id = c.search_id and j.platform = c.platform
       order by j.generation desc limit 1
     ) latest on true
     where c.search_id = $1 and c.customer_id = $2`,
    [searchId, customerId],
  );
  const sources: Record<string, MoreSourceState> = {};
  for (const row of rows) {
    const pending = row.status === "queued" || row.status === "running";
    sources[row.platform] = {
      generation: row.generation,
      state: pending ? "pending" : row.status === "failed" ? "failed"
        : row.live && row.generation < PAGE_CAP ? "available" : "exhausted",
      added: row.new_result_count,
    };
  }
  return { sources, hasMoreResults: rows.some((row) => row.any_added) };
}
