import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, type Queryable } from "@/db/migrate";
import { DEFAULT_FILTERS } from "@/monitor/search/filters";
import { startSearchForCustomer } from "./actions";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-16T10:00:00Z");

async function seededDb(): Promise<Queryable> {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [
    CUSTOMER,
  ]);
  return db;
}

const limits = { cariDailySearchLimit: 20 };

describe("startSearchForCustomer", () => {
  it("creates a search for the signed-in customer and returns its id", async () => {
    const db = await seededDb();
    const result = await startSearchForCustomer({
      customerId: CUSTOMER,
      query: "barayam",
      filters: DEFAULT_FILTERS,
      db,
      env: { CARI_SEKARANG_ENABLED: "1" },
      limits,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    const row = await db.query("select customer_id, query_text from instant_searches");
    expect(row.rows[0]).toEqual({ customer_id: CUSTOMER, query_text: "barayam" });
    if (result.ok) {
      expect(
        (await db.query<{ id: string }>("select id from instant_searches")).rows[0]?.id,
      ).toBe(result.searchId);
    }
  });

  it("rejects a search when the feature flag is off", async () => {
    const db = await seededDb();
    const result = await startSearchForCustomer({
      db,
      customerId: CUSTOMER,
      query: "barayam",
      filters: DEFAULT_FILTERS,
      env: { CARI_SEKARANG_ENABLED: "" },
      limits,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, error: "disabled" });
    expect(
      (await db.query<{ n: number }>("select count(*)::int as n from instant_searches")).rows[0]?.n,
    ).toBe(0);
  });

  it("maps query validation, hashtag intent, and the daily cap", async () => {
    const db = await seededDb();
    expect(
      await startSearchForCustomer({
        db,
        customerId: CUSTOMER,
        query: " ",
        filters: DEFAULT_FILTERS,
        env: { CARI_SEKARANG_ENABLED: "true" },
        limits,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "invalid_query" });
    expect(
      await startSearchForCustomer({
        db,
        customerId: CUSTOMER,
        query: "a".repeat(161),
        filters: DEFAULT_FILTERS,
        env: { CARI_SEKARANG_ENABLED: "true" },
        limits,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "query_too_long" });

    expect(
      await startSearchForCustomer({
        db,
        customerId: CUSTOMER,
        query: "  #Barayam ",
        filters: DEFAULT_FILTERS,
        env: { CARI_SEKARANG_ENABLED: "true" },
        limits: { cariDailySearchLimit: 1 },
        now: NOW,
      }),
    ).toMatchObject({ ok: true });
    const stored = await db.query<{ query_text: string; keyword_intent: string }>(
      "select query_text, keyword_intent from instant_searches",
    );
    expect(stored.rows[0]).toEqual({ query_text: "#Barayam", keyword_intent: "hashtag" });

    expect(
      await startSearchForCustomer({
        db,
        customerId: CUSTOMER,
        query: "barayam",
        filters: DEFAULT_FILTERS,
        env: { CARI_SEKARANG_ENABLED: "true" },
        limits: { cariDailySearchLimit: 1 },
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "daily_limit" });
  });
});
