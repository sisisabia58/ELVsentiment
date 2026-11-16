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

  it("returns 401 for an unknown session token", async () => {
    hoisted.token = "synthetic-unknown-token";
    const response = await call(SEARCH);
    expect(response.status).toBe(401);
  });
});
