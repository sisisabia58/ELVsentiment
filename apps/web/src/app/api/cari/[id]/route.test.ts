import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openSession, registerOwner } from "@/auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer, type Queryable } from "@/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as Queryable | null,
  token: undefined as string | undefined,
}));

vi.mock("@/db/pg", () => ({
  withClient: async (fn: (db: Queryable) => Promise<unknown>) => fn(hoisted.db as Queryable),
}));
vi.mock("@/auth/request-session", () => ({
  readSessionToken: async () => hoisted.token,
}));

import { GET } from "./route";

const SEARCH = "33333333-3333-4333-8333-333333333333";
const FOREIGN_SEARCH = "44444444-4444-4444-8444-444444444444";

let ownerToken = "";
let otherToken = "";

beforeAll(async () => {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  hoisted.db = db;
  const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
  const other = await registerOwner(db, { email: "other@example.com", password: "sandi-panjang" });
  ownerToken = (await openSession(db, owner.userId, owner.customerId)).token;
  otherToken = (await openSession(db, other.userId, other.customerId)).token;
  for (const [id, customerId, query] of [
    [SEARCH, owner.customerId, "barayam"],
    [FOREIGN_SEARCH, other.customerId, "rahasia"],
  ] as const) {
    await withCustomer(db, customerId, async () => {
      await db.query(
        `insert into instant_searches
           (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter,
            status, deadline_at)
         values ($1, $2, $3, 'phrase', 'all', 'relevance', 'all', 'succeeded', now())`,
        [id, customerId, query],
      );
    });
  }
  await withCustomer(db, owner.customerId, async () => {
    await db.query(
      `insert into instant_search_sources
         (search_id, customer_id, platform, provider, state, result_count, safe_detail,
          credits_charged, attempted_providers)
       values ($1, $2, 'youtube', 'scrapeatlas', 'answered', 2, 'ok', 2, array['scrapeatlas'])`,
      [SEARCH, owner.customerId],
    );
  });
  // A saved search written by the old worker leaves relevance_version at its default.
  await db.query(
    `insert into instant_search_results
       (id, search_id, customer_id, platform, external_id, text, relevance, source_provider, raw_ref)
     values ('55555555-5555-4555-8555-555555555555', $1, $2, 'youtube', 'eligible', 'Barayam enak',
             'literal_match', 'scrapeatlas', 'fixture:eligible'),
            ('66666666-6666-4666-8666-666666666666', $1, $2, 'youtube', 'weak', 'Kopi keliling',
             'no_match', 'scrapeatlas', 'fixture:weak')`,
    [SEARCH, owner.customerId],
  );
  await db.query(
    `insert into instant_search_ai (search_id, customer_id, overall_summary, overall_stance, model)
     values ($1, $2, 'Ringkasan lama', 'netral', 'demo')`,
    [SEARCH, owner.customerId],
  );
});

beforeEach(() => {
  vi.stubEnv("CARI_SEKARANG_ENABLED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function call(id: string) {
  return GET(new Request(`http://localhost/api/cari/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /api/cari/[id]", () => {
  it("returns the same 404 as a foreign id while the feature flag is off", async () => {
    vi.stubEnv("CARI_SEKARANG_ENABLED", "");
    hoisted.token = ownerToken;
    const response = await call(SEARCH);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("returns 401 for a signed-out caller", async () => {
    hoisted.token = undefined;
    const response = await call(SEARCH);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("returns the owner's snapshot with no-store caching", async () => {
    hoisted.token = ownerToken;
    const response = await call(SEARCH);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.search.query).toBe("barayam");
    expect(body.search.filters).toEqual({ dateWindow: "all", sort: "relevance", language: "all" });
    expect(body.search).not.toHaveProperty("credits");
    expect(body.totals).not.toHaveProperty("credits");
    expect(body.sources[0]).not.toHaveProperty("provider");
    expect(body.sources[0]).not.toHaveProperty("attemptedProviders");
    expect(body.sources[0]).not.toHaveProperty("creditsCharged");
  });

  it("opens an old URL with only results still supported by saved evidence", async () => {
    hoisted.token = ownerToken;
    const response = await call(SEARCH);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.search.legacyEvidence).toBe(true);
    expect(body.results.map((result: { externalId: string }) => result.externalId)).toEqual(["eligible"]);
    expect(body.sources[0].resultCount).toBe(1);
    expect(body.totals.results).toBe(1);
    expect(body.ai).toBeNull();
  });

  it("returns 404 for a foreign search id without leaking its data", async () => {
    hoisted.token = ownerToken;
    const response = await call(FOREIGN_SEARCH);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("rahasia");

    hoisted.token = otherToken;
    const reverse = await call(SEARCH);
    expect(reverse.status).toBe(404);
    expect(JSON.stringify(await reverse.json())).not.toContain("barayam");
  });

  it.each(["not-a-uuid", "' or 1=1--", "a".repeat(5000)])(
    "returns 404 instead of 500 for the malformed id %s",
    async (id) => {
      hoisted.token = ownerToken;
      const response = await call(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    },
  );

  it("returns 401 for an unknown session token", async () => {
    hoisted.token = "synthetic-unknown-token";
    const response = await call(SEARCH);
    expect(response.status).toBe(401);
  });
});
