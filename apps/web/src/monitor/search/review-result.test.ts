import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, withCustomer, type Queryable } from "@/db/migrate";
import { createProject, saveProjectConfiguration } from "@/projects/handlers";
import { admitReviewResult, resolveReviewResult, type ReviewKey } from "./review-result";
import { seedProjectFromSearch } from "./seed-project";

const pg = new PGlite();
const db = pgliteQueryable(pg);
const customerId = randomUUID();
const otherCustomerId = randomUUID();
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  await applyMigration(db);
  for (const owner of [customerId, otherCustomerId]) {
    await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [owner]);
    const created = await createProject(db, owner, "Tukuliling");
    await saveProjectConfiguration(db, owner, {
      projectId: created.projectId, brandName: "Tukuliling", variants: ["tukuliling"], sources: ["threads"],
      schedule: { mode: "off", intervalHours: 6 },
    }, undefined, { x: false, threads: true });
    await db.query("update projects set pantau_filter_triage = true where id = $1", [created.projectId]);
    if (owner === customerId) projectId = created.projectId;
    else otherProjectId = created.projectId;
  }
}, 30000);

afterAll(() => pg.close());

async function snapshot(options: {
  owner?: string; expired?: boolean; platform?: string; indexed?: boolean; text?: string;
  count?: number; externalId?: string; state?: string;
} = {}) {
  const owner = options.owner ?? customerId;
  const platform = options.platform ?? "threads";
  const searchId = randomUUID();
  const resultId = randomUUID();
  const externalId = options.externalId ?? resultId;
  const preceding = options.count ?? 0;
  await db.query(`insert into instant_searches
    (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter,
     status, finished_at, deadline_at, retention_expires_at, relevance_version)
    values ($1, $2, 'tukuliling', 'phrase', 'all', 'relevance', 'all', 'succeeded',
     now(), now(), now() + $3::interval, 1)`, [searchId, owner, options.expired ? "-1 day" : "1 day"]);
  await db.query(`insert into instant_search_sources (search_id, customer_id, platform, provider, state)
    values ($1, $2, $3, 'scrapecreators', $4)`, [searchId, owner, platform, options.state ?? "answered"]);
  for (let rank = 0; rank <= preceding; rank += 1) {
    const selected = rank === preceding;
    await db.query(`insert into instant_search_results
      (id, search_id, customer_id, platform, external_id, text, author_handle, author_name,
       url, published_at, relevance, source_provider, web_index, raw_ref, rank)
      values ($1, $2, $3, $4, $5, $6, '', 'Pelanggan', 'https://www.threads.net/@pelanggan/post/123',
       '2026-11-01T00:00:00Z', 'literal_match', 'scrapecreators', $7, 'raw-ref', $8)`,
      [selected ? resultId : randomUUID(), searchId, owner, platform, selected ? externalId : randomUUID(),
        options.text ?? "Tukuliling dingin #Kopi", options.indexed ?? false, rank]);
  }
  return { searchId, resultId, projectId };
}

function resolve(key: ReviewKey) {
  return withCustomer(db, customerId, () => resolveReviewResult(db, customerId, key));
}

function admit(key: ReviewKey, queryable = db) {
  return withCustomer(db, customerId, () => admitReviewResult(queryable, customerId, key));
}

async function expectRejection(key: ReviewKey, error: "not_found" | "ineligible") {
  await expect(resolve(key)).resolves.toEqual({ ok: false, error });
  await expect(admit(key)).resolves.toEqual({ ok: false, error });
}

it("rejects another tenant's result or project", async () => {
  await expectRejection(await snapshot({ owner: otherCustomerId }), "not_found");
  await expectRejection({ ...await snapshot(), projectId: otherProjectId }, "not_found");
});

it("rejects a result ID from another search in the same tenant", async () => {
  const key = await snapshot();
  const other = await snapshot();
  await expectRejection({ ...key, resultId: other.resultId }, "not_found");
});

it("rejects an expired snapshot", async () => {
  await expectRejection(await snapshot({ expired: true }), "not_found");
});

it.each([
  ["a post with no matching variant", { text: "Kopi dingin" }],
  ["indexed evidence", { indexed: true }],
  ["an unsupported source", { platform: "youtube" }],
  ["a disabled native source", { platform: "instagram" }],
  ["a source that has not answered", { state: "failed" }],
  ["a synthetic result identity", { externalId: "url:https://example.test/" }],
] as const)("rejects %s", async (_description, options) => {
  await expectRejection(await snapshot(options), "ineligible");
});

it("admits a selected post beyond the bulk limit with only retained evidence", async () => {
  const key = await snapshot({ count: 20 });
  await expect(withCustomer(db, customerId, () => seedProjectFromSearch({ db, customerId, ...key })))
    .resolves.toEqual({ added: 20, alreadyPresent: 0, skipped: 1 });
  await expect(resolve(key)).resolves.toMatchObject({
    ok: true, evidence: {
      id: key.resultId, externalId: key.resultId, authorName: "Pelanggan", text: "Tukuliling dingin #Kopi",
      publishedAt: "2026-11-01T00:00:00.000Z", rank: 20,
    }, mentionId: null,
  });
  const clientFields = { ...key, text: "Client text", source: "youtube", externalId: "client-id" };
  const result = await admit(clientFields);
  expect(result).toEqual({ ok: true, mentionId: expect.any(String) });
  const posts = await db.query(`select id, source, external_id, excerpt, author, scoring_status, matched_variants,
    pantau_hashtags, pantau_origin_search_id from mentions where project_id = $1 and external_id = $2`,
    [projectId, key.resultId]);
  expect(posts.rows).toEqual([{
    id: result.ok && result.mentionId, source: "threads", external_id: key.resultId,
    excerpt: "Tukuliling dingin #Kopi", author: "Pelanggan", scoring_status: "pending",
    matched_variants: ["tukuliling"], pantau_hashtags: ["Kopi"], pantau_origin_search_id: key.searchId,
  }]);
});

it("reuses the canonical mention ID from an earlier search", async () => {
  const externalId = randomUUID();
  const first = await snapshot({ externalId });
  const second = await snapshot({ externalId });
  const stored = await admit(first);
  expect(stored.ok).toBe(true);
  await expect(admit(second)).resolves.toEqual(stored);
  await expect(resolve(second)).resolves.toMatchObject({ mentionId: stored.ok && stored.mentionId });
});

it("revalidates the active variant when a write follows a successful read", async () => {
  const key = await snapshot();
  await expect(resolve(key)).resolves.toMatchObject({ ok: true });
  await db.query("update keyword_variants set active = false where project_id = $1", [projectId]);
  try {
    await expect(admit(key)).resolves.toEqual({ ok: false, error: "ineligible" });
  } finally {
    await db.query("update keyword_variants set active = true where project_id = $1", [projectId]);
  }
});

it("rechecks eligibility in the insert statement if settings change after the admission read", async () => {
  const key = await snapshot();
  const changedSettings: Queryable = {
    ...db,
    async query<T>(sql: string, params?: unknown[]) {
      if (sql.includes("insert into mentions")) {
        await db.query("update keyword_variants set active = false where project_id = $1", [projectId]);
      }
      return db.query<T>(sql, params);
    },
  };
  try {
    await expect(admit(key, changedSettings)).resolves.toEqual({ ok: false, error: "ineligible" });
    const posts = await db.query("select id from mentions where external_id = $1", [key.resultId]);
    expect(posts.rows).toEqual([]);
  } finally {
    await db.query("update keyword_variants set active = true where project_id = $1", [projectId]);
  }
});
