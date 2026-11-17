import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, type Queryable } from "@/db/migrate";
import { DEFAULT_FILTERS } from "@/monitor/search/filters";
import { askQuestionForCustomer, startSearchForCustomer } from "./actions";

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

  it("rejects non-string, missing, control-character, and zero-width-only queries", async () => {
    const db = await seededDb();
    for (const query of [undefined, null, 42, { text: "barayam" }, ["barayam"]] as unknown[]) {
      expect(
        await startSearchForCustomer({
          db,
          customerId: CUSTOMER,
          query: query as never,
          filters: DEFAULT_FILTERS,
          env: { CARI_SEKARANG_ENABLED: "1" },
          limits,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "invalid_query" });
    }
    expect(
      await startSearchForCustomer({
        db,
        customerId: CUSTOMER,
        query: "barayam",
        filters: null as never,
        env: { CARI_SEKARANG_ENABLED: "1" },
        limits,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: "invalid_query" });
    for (const query of [
      "bar\u0000ayam",
      "bar\u0001ayam",
      "\u200B\u200C\u200D\u2060\uFEFF",
      " \t \n ",
    ]) {
      expect(
        await startSearchForCustomer({
          db,
          customerId: CUSTOMER,
          query,
          filters: DEFAULT_FILTERS,
          env: { CARI_SEKARANG_ENABLED: "1" },
          limits,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: "invalid_query" });
    }
    expect(
      (await db.query<{ n: number }>("select count(*)::int as n from instant_searches")).rows[0]?.n,
    ).toBe(0);
  });

  it("stores a query with zero-width padding stripped", async () => {
    const db = await seededDb();
    const result = await startSearchForCustomer({
      db,
      customerId: CUSTOMER,
      query: "  \u200Bbarayam\u200D \u2060",
      filters: DEFAULT_FILTERS,
      env: { CARI_SEKARANG_ENABLED: "1" },
      limits,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    const stored = await db.query<{ query_text: string }>("select query_text from instant_searches");
    expect(stored.rows[0]?.query_text).toBe("barayam");
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

describe("askQuestionForCustomer", () => {
  it("queues one question for the owner and spends one user credit", async () => {
    const db = await seededDb();
    const started = await startSearchForCustomer({
      db,
      customerId: CUSTOMER,
      query: "barayam",
      filters: DEFAULT_FILTERS,
      env: { CARI_SEKARANG_ENABLED: "1" },
      limits,
      now: NOW,
    });
    if (!started.ok) throw new Error("search");
    const asked = await askQuestionForCustomer({
      db,
      customerId: CUSTOMER,
      searchId: started.searchId,
      question: "Apa keluhan utama?",
      env: { CARI_SEKARANG_ENABLED: "1" },
    });
    expect(asked.ok).toBe(true);
    const row = await db.query<{ status: string; user_credits: number; question: string }>(
      "select status, user_credits, question from instant_search_questions",
    );
    expect(row.rows[0]).toEqual({
      status: "queued",
      user_credits: 1,
      question: "Apa keluhan utama?",
    });
  });

  it("rejects a short question, a missing flag, and another customer's search", async () => {
    const db = await seededDb();
    const started = await startSearchForCustomer({
      db,
      customerId: CUSTOMER,
      query: "barayam",
      filters: DEFAULT_FILTERS,
      env: { CARI_SEKARANG_ENABLED: "1" },
      limits,
      now: NOW,
    });
    if (!started.ok) throw new Error("search");
    expect(
      await askQuestionForCustomer({
        db,
        customerId: CUSTOMER,
        searchId: started.searchId,
        question: "ap",
        env: { CARI_SEKARANG_ENABLED: "1" },
      }),
    ).toEqual({ ok: false, error: "invalid_question" });
    expect(
      await askQuestionForCustomer({
        db,
        customerId: CUSTOMER,
        searchId: started.searchId,
        question: "Apa keluhan utama?",
        env: { CARI_SEKARANG_ENABLED: "" },
      }),
    ).toEqual({ ok: false, error: "disabled" });
    expect(
      await askQuestionForCustomer({
        db,
        customerId: "22222222-2222-4222-8222-222222222222",
        searchId: started.searchId,
        question: "Apa keluhan utama?",
        env: { CARI_SEKARANG_ENABLED: "1" },
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      (await db.query<{ n: number }>("select count(*)::int as n from instant_search_questions")).rows[0]?.n,
    ).toBe(0);
  });
});
