import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, withCustomer, type Queryable } from "@/db/migrate";
import { loadHistory, loadSearchSnapshot } from "./load";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const OTHER_CUSTOMER = "22222222-2222-4222-8222-222222222222";
const SEARCH = "33333333-3333-4333-8333-333333333333";

async function migrated(): Promise<Queryable> {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [
    CUSTOMER,
  ]);
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [
    OTHER_CUSTOMER,
  ]);
  return db;
}

async function insertSearch(
  db: Queryable,
  id: string,
  customerId: string,
  overrides: {
    query?: string; status?: string; credits?: number; stance?: string | null; createdAt?: string; legacy?: boolean;
  } = {},
) {
  await withCustomer(db, customerId, async () => {
    await db.query(
      `insert into instant_searches
         (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter,
          status, overall_stance, credits_used, created_at, finished_at, deadline_at)
       values ($1, $2, $3, 'phrase', '7d', 'relevance', 'all', $4, $5, $6, $7, $7, $7)`,
      [
        id,
        customerId,
        overrides.query ?? "barayam",
        overrides.status ?? "succeeded",
        "stance" in overrides ? overrides.stance : "positif",
        overrides.credits ?? 12,
        overrides.createdAt ?? "2026-11-16T09:00:00Z",
      ],
    );
  });
  if (!overrides.legacy) {
    await db.query("update instant_searches set relevance_version = 1 where id = $1", [id]);
  }
}

async function insertResult(
  db: Queryable,
  searchId: string,
  customerId: string,
  result: {
    id: string;
    platform?: string;
    externalId: string;
    publishedAt: string | null;
    rank?: number | null;
    likes?: number;
    text?: string;
    title?: string;
    relevance?: string;
  },
) {
  await db.query(
    `insert into instant_search_results
       (id, search_id, customer_id, platform, external_id, text, published_at, rank, likes, title,
        relevance, source_provider, raw_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'scrapeatlas', $12)`,
    [
      result.id,
      searchId,
      customerId,
      result.platform ?? "threads",
      result.externalId,
      result.text ?? `isi ${result.externalId}`,
      result.publishedAt,
      result.rank ?? null,
      result.likes ?? 0,
      result.title ?? null,
      result.relevance ?? "literal_match",
      `fixture:${result.externalId}`,
    ],
  );
}

async function insertSource(
  db: Queryable,
  searchId: string,
  customerId: string,
  platform: string,
  state: string,
  resultCount: number,
) {
  await withCustomer(db, customerId, async () => {
    await db.query(
      `insert into instant_search_sources
         (search_id, customer_id, platform, provider, state, result_count, safe_detail)
       values ($1, $2, $3, 'scrapeatlas', $4, $5, 'ok')`,
      [searchId, customerId, platform, state, resultCount],
    );
  });
}

describe("loadSearchSnapshot", () => {
  it("rechecks a legacy search's saved evidence and preserves the original records", async () => {
    const db = await migrated();
    await insertSearch(db, SEARCH, CUSTOMER, { query: "tukuliling kopi", legacy: true });
    const evidence = [
      { externalId: "weak", text: "Kopi keliling lewat tiap pagi", relevance: "no_match", rank: 1 },
      { externalId: "unverifiable", text: "", relevance: "literal_match", rank: 2 },
      { externalId: "anchor", text: "Ada Tukuliling di MRT Blok M.", relevance: "no_match", rank: 3 },
      { externalId: "exact", text: "Mari ke MRT. ＃ＴｕｋｕｌｉｌｉｎｇＫｏｐｉ", relevance: "literal_match", rank: 4 },
      { externalId: "wrong", text: "Hanya Kopi Sekarputih", relevance: "all_words_match", rank: 5, platform: "youtube" },
    ];
    for (const [index, item] of evidence.entries()) {
      const id = "77777777-7777-4777-8777-77777777777" + index;
      await insertResult(db, SEARCH, CUSTOMER, { id, publishedAt: "2026-11-15T09:00:00Z", ...item });
      await db.query(
        `insert into instant_search_comments
           (id, search_id, customer_id, result_id, platform, external_id, text, source_provider, raw_ref)
         values ($1, $2, $3, $4, 'threads', $5, $5, 'scrapeatlas', $5)`,
        ["88888888-8888-4888-8888-88888888888" + index, SEARCH, CUSTOMER, id, "reply-" + item.externalId],
      );
    }
    await insertSource(db, SEARCH, CUSTOMER, "threads", "answered", 4);
    await insertSource(db, SEARCH, CUSTOMER, "youtube", "answered", 1);
    await db.query("update instant_searches set summary_status = 'done' where id = $1", [SEARCH]);
    await db.query(
      `insert into instant_search_ai (search_id, customer_id, overall_summary, overall_stance, model)
       values ($1, $2, 'Ringkasan lama', 'campuran', 'demo')`, [SEARCH, CUSTOMER],
    );
    await db.query(
      `insert into instant_search_questions (id, search_id, customer_id, question, status, answer)
       values ('99999999-9999-4999-8999-999999999999', $1, $2, 'Apa keluhannya?', 'done', 'Jawaban lama')`,
      [SEARCH, CUSTOMER],
    );
    await db.query(
      `insert into search_credit_ledger (id, search_id, customer_id, provider, platform, route, credits_charged, latency_ms)
       values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1, $2, 'scrapeatlas', 'threads', 'search', 12, 10)`,
      [SEARCH, CUSTOMER],
    );

    const old = await loadSearchSnapshot(db, CUSTOMER, SEARCH);
    expect(old?.search).toMatchObject({ legacyEvidence: true, summaryStatus: "skipped", overallStance: null });
    expect(old?.results.map((item) => [item.externalId, item.relevance])).toEqual([
      ["exact", "literal_match"], ["anchor", "all_words_match"],
    ]);
    expect(old?.comments.map((item) => item.externalId)).toEqual(["reply-anchor", "reply-exact"]);
    expect(old?.totals).toEqual({ sources: 2, done: 2, results: 2 });
    expect(old?.sources.map((source) => [source.platform, source.resultCount])).toEqual([["threads", 2], ["youtube", 0]]);
    expect(old?.ai).toBeNull();
    expect(old?.questions).toEqual([]);
    expect((await loadHistory(db, CUSTOMER))[0]).toMatchObject({ resultCount: 2, sourceCount: 2, stance: null });
    expect(await loadSearchSnapshot(db, OTHER_CUSTOMER, SEARCH)).toBeNull();

    expect((await db.query("select raw_ref, relevance from instant_search_results where search_id = $1 order by rank", [SEARCH])).rows)
      .toEqual(evidence.map((item) => ({ raw_ref: "fixture:" + item.externalId, relevance: item.relevance })));
    expect((await db.query("select count(*)::int as n from instant_search_comments")).rows).toEqual([{ n: 5 }]);
    expect((await db.query("select summary_status from instant_searches")).rows).toEqual([{ summary_status: "done" }]);
    expect((await db.query("select overall_summary from instant_search_ai")).rows).toEqual([{ overall_summary: "Ringkasan lama" }]);
    expect((await db.query("select answer from instant_search_questions")).rows).toEqual([{ answer: "Jawaban lama" }]);
    expect((await db.query("select credits_charged::int from search_credit_ledger")).rows).toEqual([{ credits_charged: 12 }]);
  });

  it("keeps the receipt when a legacy search has no verifiable results", async () => {
    const db = await migrated();
    await insertSearch(db, SEARCH, CUSTOMER, { query: "kopi keliling", legacy: true });
    await insertSource(db, SEARCH, CUSTOMER, "threads", "answered", 1);
    await insertResult(db, SEARCH, CUSTOMER, {
      id: "77777777-7777-4777-8777-777777777777",
      externalId: "missing-evidence",
      publishedAt: null,
      text: "Keliling setiap pagi.",
    });
    const old = await loadSearchSnapshot(db, CUSTOMER, SEARCH);
    expect(old?.search).toMatchObject({ query: "kopi keliling", status: "succeeded", legacyEvidence: true });
    expect(old?.totals).toEqual({ sources: 1, done: 1, results: 0 });
    expect(old?.results).toEqual([]);
    expect((await loadHistory(db, CUSTOMER))[0]).toMatchObject({ resultCount: 0 });
  });

  it("returns only the customer's search and sorts undated results last", async () => {
    const db = await migrated();
    await insertSearch(db, SEARCH, CUSTOMER);
    await insertResult(db, SEARCH, CUSTOMER, {
      id: "44444444-4444-4444-8444-444444444444",
      externalId: "undated",
      publishedAt: null,
      rank: 1,
    });
    await insertResult(db, SEARCH, CUSTOMER, {
      id: "55555555-5555-4555-8555-555555555555",
      externalId: "dated",
      publishedAt: "2026-11-15T09:00:00Z",
      rank: 2,
    });
    const snapshot = await loadSearchSnapshot(db, CUSTOMER, SEARCH);
    expect(snapshot?.search.query).toBe("barayam");
    expect(snapshot?.results.map((row) => row.externalId)).toEqual(["dated", "undated"]);
    expect(await loadSearchSnapshot(db, OTHER_CUSTOMER, SEARCH)).toBeNull();
    expect(await loadSearchSnapshot(db, CUSTOMER, "66666666-6666-4666-8666-666666666666")).toBeNull();
    expect(await loadSearchSnapshot(db, CUSTOMER, "not-a-uuid")).toBeNull();
    expect(await loadSearchSnapshot(db, CUSTOMER, "' or 1=1--")).toBeNull();
    expect(await loadSearchSnapshot(db, CUSTOMER, "a".repeat(5000))).toBeNull();
  });

  it("returns progress totals without providers or credits", async () => {
    const db = await migrated();
    await insertSearch(db, SEARCH, CUSTOMER, { status: "running", credits: 12 });
    const states: Array<[string, string, number]> = [
      ["threads", "answered", 14],
      ["tiktok", "answered", 11],
      ["youtube", "answered", 11],
      ["facebook", "answered", 7],
      ["instagram", "searching", 0],
      ["web", "queued", 0],
      ["x", "queued", 0],
      ["reddit", "unavailable", 0],
    ];
    for (const [platform, state, count] of states) {
      await insertSource(db, SEARCH, CUSTOMER, platform, state, count);
    }
    await insertResult(db, SEARCH, CUSTOMER, {
      id: "77777777-7777-4777-8777-777777777777",
      externalId: "stored-1",
      publishedAt: "2026-11-15T09:00:00Z",
      rank: 1,
    });
    await insertResult(db, SEARCH, CUSTOMER, {
      id: "88888888-8888-4888-8888-888888888888",
      externalId: "stored-2",
      publishedAt: "2026-11-15T10:00:00Z",
      rank: 2,
    });
    const snapshot = await loadSearchSnapshot(db, CUSTOMER, SEARCH);
    // 43 is the stale sum of source result_count; the header must use rows.
    expect(snapshot?.totals).toEqual({ sources: 8, done: 4, results: 2 });
    expect(snapshot?.search).not.toHaveProperty("credits");
    expect(snapshot?.search.status).toBe("running");
    for (const source of snapshot?.sources ?? []) {
      expect(source).not.toHaveProperty("provider");
      expect(source).not.toHaveProperty("attemptedProviders");
      expect(source).not.toHaveProperty("creditsCharged");
    }
    expect(snapshot?.sources.map((row) => row.platform)).toEqual([
      "threads",
      "tiktok",
      "youtube",
      "instagram",
      "facebook",
      "x",
      "reddit",
      "web",
    ]);
  });

  it("loads every stored result so the header, tabs, and history share one count", async () => {
    const db = await migrated();
    await insertSearch(db, SEARCH, CUSTOMER);
    const platforms = ["threads", "tiktok", "youtube", "instagram", "facebook", "reddit", "linkedin"];
    const stored = 51;
    for (let index = 0; index < stored; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      await insertResult(db, SEARCH, CUSTOMER, {
        id: `44444444-4444-4444-8444-${suffix}`,
        platform: platforms[index % platforms.length],
        externalId: `post-${index}`,
        publishedAt: "2026-11-15T09:00:00Z",
        rank: index + 1,
      });
    }
    // Source counters are a different number on purpose. The page must not use them.
    await insertSource(db, SEARCH, CUSTOMER, "threads", "answered", 180);

    const snapshot = await loadSearchSnapshot(db, CUSTOMER, SEARCH);
    const history = await loadHistory(db, CUSTOMER);
    expect(snapshot?.results).toHaveLength(stored);
    expect(snapshot?.totals.results).toBe(stored);
    expect(snapshot?.totals.results).toBe(snapshot?.results.length);
    expect(history[0]?.resultCount).toBe(stored);
    const byPlatform = new Map<string, number>();
    for (const result of snapshot?.results ?? []) {
      byPlatform.set(result.platform, (byPlatform.get(result.platform) ?? 0) + 1);
    }
    expect([...byPlatform.values()].reduce((sum, count) => sum + count, 0)).toBe(stored);
  });

  it("loads comments, AI, and questions for the search only", async () => {
    const db = await migrated();
    await insertSearch(db, SEARCH, CUSTOMER);
    const resultId = "77777777-7777-4777-8777-777777777777";
    await insertResult(db, SEARCH, CUSTOMER, {
      id: resultId,
      externalId: "tiktok-1",
      publishedAt: "2026-11-15T09:00:00Z",
      rank: 1,
    });
    await db.query(
      `insert into instant_search_comments
         (id, search_id, customer_id, result_id, platform, external_id, text, likes,
          source_provider, raw_ref)
       values ($1, $2, $3, $4, 'tiktok', 'c-1', 'kriuknya beda sih', 41, 'scrapeatlas', 'fixture:c1')`,
      ["88888888-8888-4888-8888-888888888888", SEARCH, CUSTOMER, resultId],
    );
    await db.query(
      `insert into instant_search_ai
         (search_id, customer_id, overall_summary, overall_stance, platform_summaries,
          quotes, themes, model)
       values ($1, $2, 'Ringkasan', 'campuran', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'demo')`,
      [SEARCH, CUSTOMER],
    );
    await db.query(
      `insert into instant_search_questions
         (id, search_id, customer_id, question, status, answer, citations, user_credits)
       values ($1, $2, $3, 'Apa keluhannya?', 'done', 'Antrean.', '[]'::jsonb, 1)`,
      ["99999999-9999-4999-8999-999999999999", SEARCH, CUSTOMER],
    );
    const snapshot = await loadSearchSnapshot(db, CUSTOMER, SEARCH);
    expect(snapshot?.comments).toHaveLength(1);
    expect(snapshot?.comments[0]).toMatchObject({
      resultId,
      text: "kriuknya beda sih",
      likes: 41,
    });
    expect(snapshot?.ai).toMatchObject({ overallSummary: "Ringkasan", overallStance: "campuran" });
    expect(snapshot?.questions).toHaveLength(1);
    expect(snapshot?.questions[0]?.answer).toBe("Antrean.");
    expect(await loadSearchSnapshot(db, OTHER_CUSTOMER, SEARCH)).toBeNull();
  });

  it("orders comments by likes then published time and keeps them out of the result count", async () => {
    const db = await migrated();
    await insertSearch(db, SEARCH, CUSTOMER);
    const resultId = "77777777-7777-4777-8777-777777777777";
    await insertResult(db, SEARCH, CUSTOMER, {
      id: resultId,
      externalId: "tiktok-1",
      publishedAt: "2026-11-15T09:00:00Z",
      rank: 1,
    });
    const rows = [
      ["88888888-8888-4888-8888-888888888881", "low", 1, "2026-11-01T00:00:00Z"],
      ["88888888-8888-4888-8888-888888888882", "later", 5, "2026-11-03T00:00:00Z"],
      ["88888888-8888-4888-8888-888888888883", "earlier", 5, "2026-11-02T00:00:00Z"],
    ] as const;
    for (const [id, externalId, likes, publishedAt] of rows) {
      await db.query(
        `insert into instant_search_comments
           (id, search_id, customer_id, result_id, platform, external_id, text, likes,
            published_at, source_provider, raw_ref)
         values ($1, $2, $3, $4, 'tiktok', $5, $5, $6, $7, 'scrapeatlas', $5)`,
        [id, SEARCH, CUSTOMER, resultId, externalId, likes, publishedAt],
      );
    }
    const snapshot = await loadSearchSnapshot(db, CUSTOMER, SEARCH);
    expect(snapshot?.comments.map((comment) => comment.externalId)).toEqual(["earlier", "later", "low"]);
    expect(snapshot?.totals.results).toBe(1);
    expect(snapshot?.results).toHaveLength(1);
  });
});

describe("loadHistory", () => {
  it("lists only the customer's searches, newest first, with counts", async () => {
    const db = await migrated();
    const otherSearch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await insertSearch(db, SEARCH, CUSTOMER, { createdAt: "2026-11-16T09:00:00Z", stance: "campuran" });
    await insertSearch(db, otherSearch, CUSTOMER, {
      query: "mandalika",
      createdAt: "2026-11-16T10:00:00Z",
      status: "failed",
      stance: null,
      credits: 0,
    });
    const foreignSearch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await insertSearch(db, foreignSearch, OTHER_CUSTOMER, { query: "rahasia" });
    await insertSource(db, SEARCH, CUSTOMER, "threads", "answered", 14);
    await insertSource(db, SEARCH, CUSTOMER, "tiktok", "answered", 11);
    await insertResult(db, SEARCH, CUSTOMER, {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      externalId: "one",
      publishedAt: "2026-11-15T09:00:00Z",
    });

    const rows = await loadHistory(db, CUSTOMER);
    expect(rows.map((row) => row.query)).toEqual(["mandalika", "barayam"]);
    expect(rows[0]).toMatchObject({ id: otherSearch, status: "failed", stance: null });
    expect(rows[1]).toMatchObject({
      id: SEARCH,
      resultCount: 1,
      sourceCount: 2,
      stance: "campuran",
    });
    expect(rows.some((row) => row.query === "rahasia")).toBe(false);
    expect(await loadHistory(db, CUSTOMER, 1)).toHaveLength(1);
  });
});
