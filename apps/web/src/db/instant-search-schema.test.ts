import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "./migrate";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SEARCH = "22222222-2222-4222-8222-222222222222";

async function migrated() {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  return db;
}

async function seedCustomer(db: Awaited<ReturnType<typeof migrated>>) {
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [
    CUSTOMER,
  ]);
}

describe("instant search schema", () => {
  it("seeds provider settings and rejects unsupported values", async () => {
    const db = await migrated();
    const rows = await db.query<{
      platform: string;
      provider: string;
      fallback_provider: string | null;
    }>("select platform, provider, fallback_provider from provider_settings order by platform");
    expect(rows.rows.find((row) => row.platform === "instagram")).toEqual({
      platform: "instagram",
      provider: "scrapecreators",
      fallback_provider: null,
    });
    expect(rows.rows.find((row) => row.platform === "youtube")?.provider).toBe("scrapeatlas");
    expect(rows.rows.find((row) => row.platform === "web")?.provider).toBe("off");
    expect(rows.rows.find((row) => row.platform === "comments")?.provider).toBe("scrapeatlas");
    expect(rows.rows.find((row) => row.platform === "threads")?.fallback_provider).toBe(
      "scrapeatlas",
    );
    expect(rows.rows).toHaveLength(10);
    await expect(
      db.query("update provider_settings set provider = 'nope' where platform = 'youtube'"),
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into provider_settings (platform, provider) values ('youtube', 'scrapecreators')",
      ),
    ).rejects.toThrow();
  });

  it("enforces fallback and platform checks on provider settings", async () => {
    const db = await migrated();
    await expect(
      db.query(
        "insert into provider_settings (platform, provider, fallback_on_failure) values ('youtube', 'off', true)",
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into provider_settings (platform, provider) values ('myspace', 'scrapeatlas')",
      ),
    ).rejects.toThrow();
  });

  it("cascades a search delete through sources", async () => {
    const db = await migrated();
    await seedCustomer(db);
    await db.query(
      `insert into instant_searches
         (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter,
          status, deadline_at, retention_expires_at)
       values ($1, $2, 'barayam', 'phrase', 'all', 'relevance', 'all', 'queued',
               now() + interval '40 seconds', now() + interval '30 days')`,
      [SEARCH, CUSTOMER],
    );
    await db.query(
      `insert into instant_search_sources (search_id, customer_id, platform, provider, state)
       values ($1, $2, 'youtube', 'scrapeatlas', 'queued')`,
      [SEARCH, CUSTOMER],
    );
    await db.query("delete from instant_searches where id = $1", [SEARCH]);
    const left = await db.query<{ n: number }>(
      "select count(*)::int as n from instant_search_sources",
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it("cascades comments through their result and the search", async () => {
    const db = await migrated();
    await seedCustomer(db);
    await db.query(
      `insert into instant_searches
         (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter,
          status, deadline_at)
       values ($1, $2, 'barayam', 'hashtag', '24h', 'newest', 'id', 'running', now() + interval '40 seconds')`,
      [SEARCH, CUSTOMER],
    );
    const resultId = "33333333-3333-4333-8333-333333333333";
    await db.query(
      `insert into instant_search_results
         (id, search_id, customer_id, platform, external_id, relevance, source_provider, raw_ref)
       values ($1, $2, $3, 'youtube', 'vid-1', 'literal_match', 'scrapeatlas', 'fixture:1')`,
      [resultId, SEARCH, CUSTOMER],
    );
    await db.query(
      `insert into instant_search_comments
         (id, search_id, customer_id, result_id, platform, external_id, text, source_provider, raw_ref)
       values ($1, $2, $3, $4, 'youtube', 'c-1', 'halo', 'scrapeatlas', 'fixture:c1')`,
      ["44444444-4444-4444-8444-444444444444", SEARCH, CUSTOMER, resultId],
    );
    await db.query("delete from instant_search_results where id = $1", [resultId]);
    const left = await db.query<{ n: number }>(
      "select count(*)::int as n from instant_search_comments",
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it("creates every instant-search table and its tenant policies", async () => {
    const db = await migrated();
    const tables = await db.query<{ name: string }>(
      `select tablename as name from pg_tables
       where schemaname = 'public'
         and tablename = any($1::text[]) order by tablename`,
      [
        [
          "provider_settings",
          "provider_settings_audit",
          "instant_searches",
          "instant_search_sources",
          "instant_search_results",
          "instant_search_comments",
          "instant_search_ai",
          "instant_search_questions",
          "search_credit_ledger",
          "gemini_gate",
        ],
      ],
    );
    expect(tables.rows.map((row) => row.name)).toHaveLength(10);

    const policies = await db.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies
       where schemaname = 'public' and tablename = any($1::text[])`,
      [
        [
          "provider_settings",
          "provider_settings_audit",
          "instant_searches",
          "instant_search_sources",
          "instant_search_results",
          "instant_search_comments",
          "instant_search_ai",
          "instant_search_questions",
          "search_credit_ledger",
          "gemini_gate",
        ],
      ],
    );
    const names = new Set(policies.rows.map((row) => row.policyname));
    expect(names.has("provider_settings_admin_insert")).toBe(true);
    expect(names.has("provider_settings_admin_update")).toBe(true);
    expect(names.has("instant_searches_tenant")).toBe(true);
    expect(names.has("instant_search_questions_insert")).toBe(true);
    expect(names.has("gemini_gate_worker")).toBe(true);
    expect(names.has("search_credit_ledger_tenant")).toBe(true);
  });

  it("enforces instant-search column checks", async () => {
    const db = await migrated();
    await seedCustomer(db);
    await expect(
      db.query(
        `insert into instant_searches
           (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter,
            status, deadline_at)
         values ($1, $2, 'x', 'phrase', 'forever', 'relevance', 'all', 'queued', now())`,
        [SEARCH, CUSTOMER],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into instant_search_results
           (id, search_id, customer_id, platform, external_id, language, relevance, source_provider, raw_ref)
         values ('55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
                 $1, 'youtube', 'v', 'fr', 'literal_match', 'scrapeatlas', 'x')`,
        [CUSTOMER],
      ),
    ).rejects.toThrow();
    await db.query(
      "insert into gemini_gate (id) values (1) on conflict do nothing",
    );
    await expect(db.query("insert into gemini_gate (id) values (2)")).rejects.toThrow();
  });
});
