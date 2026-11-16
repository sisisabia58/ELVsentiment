import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, type Queryable } from "@/db/migrate";
import { startOfJakartaDay } from "./filters";
import { createInstantSearch } from "./mutations";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER_CUSTOMER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-16T10:00:00Z");

function validInput() {
  return {
    query: "barayam",
    intent: "phrase" as const,
    filters: { dateWindow: "7d" as const, sort: "relevance" as const, language: "all" as const },
  };
}

async function migrated(): Promise<Queryable> {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  return db;
}

async function seed(db: Queryable, customer = CUSTOMER) {
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [customer]);
}

describe("createInstantSearch", () => {
  it("creates one search and seeds source rows", async () => {
    const db = await migrated();
    await seed(db);
    const result = await createInstantSearch(db, CUSTOMER, validInput(), NOW, { cariDailySearchLimit: 20 });
    expect(result.ok).toBe(true);
    const sources = await db.query<{ platform: string; provider: string; state: string }>(
      "select platform, provider, state from instant_search_sources order by platform",
    );
    expect(sources.rows.map((row) => row.platform).sort()).toEqual(
      ["facebook", "instagram", "linkedin", "reddit", "threads", "tiktok", "youtube"].sort(),
    );
    expect(sources.rows.every((row) => row.state === "queued")).toBe(true);
    const search = await db.query<{ deadline_at: Date; retention_expires_at: Date; created_at: Date }>(
      "select deadline_at, retention_expires_at, created_at from instant_searches",
    );
    expect(search.rows[0].created_at.toISOString()).toBe(NOW.toISOString());
    expect(search.rows[0].deadline_at.toISOString()).toBe("2026-11-16T10:00:40.000Z");
    expect(search.rows[0].retention_expires_at.toISOString()).toBe("2026-12-16T10:00:00.000Z");
  });

  it("returns daily_limit after the configured number of searches today", async () => {
    const db = await migrated();
    await seed(db);
    expect((await createInstantSearch(db, CUSTOMER, validInput(), NOW, { cariDailySearchLimit: 1 })).ok).toBe(true);
    expect(await createInstantSearch(db, CUSTOMER, validInput(), NOW, { cariDailySearchLimit: 1 })).toEqual({
      ok: false,
      error: "daily_limit",
    });
    const count = await db.query<{ n: number }>("select count(*)::int as n from instant_searches");
    expect(count.rows[0]?.n).toBe(1);
  });

  it("counts the Jakarta civil day and leaves other customers alone", async () => {
    const db = await migrated();
    await seed(db);
    await seed(db, OTHER_CUSTOMER);
    await createInstantSearch(db, OTHER_CUSTOMER, validInput(), NOW, { cariDailySearchLimit: 1 });
    const result = await createInstantSearch(db, CUSTOMER, validInput(), NOW, { cariDailySearchLimit: 1 });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid queries and filter enums without inserting", async () => {
    const db = await migrated();
    await seed(db);
    const limits = { cariDailySearchLimit: 20 };
    const invalidInputs = [
      { ...validInput(), query: "a" },
      { ...validInput(), query: "x".repeat(161) },
      { ...validInput(), intent: "words" },
      { ...validInput(), filters: { ...validInput().filters, dateWindow: "2d" } },
      { ...validInput(), filters: { ...validInput().filters, sort: "random" } },
      { ...validInput(), filters: { ...validInput().filters, language: "fr" } },
    ] as never[];
    for (const input of invalidInputs) {
      expect(await createInstantSearch(db, CUSTOMER, input, NOW, limits)).toEqual({
        ok: false,
        error: "invalid_query",
      });
    }
    expect((await db.query<{ n: number }>("select count(*)::int as n from instant_searches")).rows[0]?.n).toBe(0);
  });

  it("trims the query before validating and storing it", async () => {
    const db = await migrated();
    await seed(db);
    const result = await createInstantSearch(
      db,
      CUSTOMER,
      { ...validInput(), query: "  barayam  " },
      NOW,
      { cariDailySearchLimit: 20 },
    );
    expect(result.ok).toBe(true);
    const row = await db.query<{ query_text: string }>("select query_text from instant_searches");
    expect(row.rows[0]?.query_text).toBe("barayam");
  });
});

describe("startOfJakartaDay", () => {
  it("starts the Jakarta day at 17:00 UTC the previous day", () => {
    expect(startOfJakartaDay(new Date("2026-11-16T10:00:00Z")).toISOString()).toBe(
      "2026-11-15T17:00:00.000Z",
    );
    expect(startOfJakartaDay(new Date("2026-11-16T17:00:00Z")).toISOString()).toBe(
      "2026-11-16T17:00:00.000Z",
    );
  });
});
