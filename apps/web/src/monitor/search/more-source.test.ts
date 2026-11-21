import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { applyMigration, pgliteQueryable, type Queryable } from "@/db/migrate";
import { loadSearchSnapshot } from "./load";
import { SEARCH_RELEVANCE_VERSION } from "./relevance";
import { loadMoreSources, requestMoreSource } from "./more-source";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const search = "33333333-3333-4333-8333-333333333333";
const pg = new PGlite();
let db: Queryable;

beforeAll(async () => {
  db = pgliteQueryable(pg);
  await applyMigration(db);
  for (const customer of [owner, other]) {
    await db.query("insert into customers (id, customer_id, created_at) values ($1,$1,now())", [customer]);
  }
  await db.query(`insert into instant_searches (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
    language_filter, status, finished_at, deadline_at, retention_expires_at, relevance_version)
    values ($1,$2,'mandalika parfum','phrase','all','relevance','all','succeeded',now(),now(),now()+interval '1 day',$3)`, [search, owner, SEARCH_RELEVANCE_VERSION]);
  await db.query(`insert into instant_search_sources (search_id,customer_id,platform,provider,state)
    values ($1,$2,'tiktok','scrapeatlas','answered'),($1,$2,'youtube','scrapeatlas','answered')`, [search, owner]);
  await db.query(`insert into instant_search_continuations
    (search_id,customer_id,platform,route,cursor,companion,expires_at)
    values ($1,$2,'tiktok','scrapeatlas.tiktok.keyword','private-cursor','private-companion',now()+interval '15 minutes'),
           ($1,$2,'youtube','scrapeatlas.youtube.search','private-expired',null,now()-interval '1 minute')`, [search, owner]);
}, 30000);

afterAll(() => pg.close());

function request(customerId = owner, platform = "tiktok", generation = 0, enabled = true, allowlist?: string) {
  return requestMoreSource({
    db, customerId, searchId: search, platform, generation, dailyLimit: 20,
    env: { CARI_SEKARANG_ENABLED: "1", CARI_MORE_ENABLED: enabled ? "1" : "0", CARI_MORE_PLATFORMS: allowlist },
  });
}

it("admits eligible owner requests once and exposes only the public job state", async () => {
  expect(await request(other)).toEqual({ ok: false, error: "unavailable" });
  expect(await request(owner, "youtube")).toEqual({ ok: false, error: "unavailable" });
  expect(await request(owner, "tiktok", 0, false)).toEqual({ ok: false, error: "disabled" });
  expect(await request(owner, "tiktok", 1)).toEqual({ ok: false, error: "unavailable" });
  expect(await request(owner, "tiktok", 0, true, "reddit, youtube")).toEqual({ ok: false, error: "unavailable" });
  const job = await request();
  expect(job).toMatchObject({ ok: true });
  expect(await request()).toEqual(job);
  expect((await db.query("select count(*)::int as n from instant_search_more_jobs")).rows).toEqual([{ n: 1 }]);
  expect((await loadMoreSources(db, owner, search)).sources).toEqual({
    tiktok: { state: "pending", generation: 0, added: null },
    youtube: { state: "exhausted", generation: 0, added: null },
  });
  expect((await loadMoreSources(db, other, search)).sources).toEqual({});
  expect((await db.query(`select has_column_privilege('app_user','instant_search_continuations','cursor','select') as raw`)).rows)
    .toEqual([{ raw: false }]);

  await db.query(`update instant_search_more_jobs
                   set status = 'succeeded', new_result_count = 1 where search_id = $1`, [search]);
  await db.query(`update instant_search_continuations
                   set generation = 1, cursor = null where search_id = $1 and platform = 'tiktok'`, [search]);
  await db.query(`insert into instant_search_results
                   (id, search_id, customer_id, platform, external_id, text, relevance, source_provider, raw_ref)
                  values ('54444444-4444-4444-8444-444444444444', $1, $2, 'tiktok', 'new-post',
                          'Mandalika parfum', 'literal_match', 'scrapeatlas', 'fixture')`, [search, owner]);
  expect(await request()).toEqual(job);
  expect(await request(owner, "tiktok", 1)).toEqual({ ok: false, error: "unavailable" });
  expect((await db.query("select user_credits from instant_searches where id = $1", [search])).rows)
    .toEqual([{ user_credits: 1 }]);

  vi.stubEnv("CARI_SEKARANG_ENABLED", "1");
  vi.stubEnv("CARI_MORE_ENABLED", "1");
  try {
    const expanded = await loadSearchSnapshot(db, owner, search);
    expect(expanded).toMatchObject({ hasMoreResults: true, totals: { results: 1 } });
    expect(expanded?.sources.find((source) => source.platform === "tiktok")?.more)
      .toEqual({ state: "exhausted", generation: 1, added: 1 });
    vi.stubEnv("CARI_MORE_PLATFORMS", "reddit, youtube");
    const partial = await loadSearchSnapshot(db, owner, search);
    expect(partial?.hasMoreResults).toBe(true);
    expect(partial?.sources.find((source) => source.platform === "tiktok")?.more).toBeUndefined();
    vi.stubEnv("CARI_MORE_ENABLED", "0");
    const controlsOff = await loadSearchSnapshot(db, owner, search);
    expect(controlsOff).toMatchObject({ hasMoreResults: true, totals: { results: 1 } });
    expect(controlsOff?.sources.every((source) => !source.more)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
