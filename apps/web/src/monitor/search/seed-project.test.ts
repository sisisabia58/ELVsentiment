import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigration, pgliteQueryable, withCustomer } from "@/db/migrate";
import { monitorAsProjectForCustomer } from "@/app/cari/actions";
import { createProject, saveProjectConfiguration } from "@/projects/handlers";
import { seedProjectFromSearch } from "./seed-project";

const pg = new PGlite();
const db = pgliteQueryable(pg);
const customerId = randomUUID();
const foreignCustomerId = randomUUID();
let projectId: string;

beforeAll(async () => {
  await applyMigration(db);
  for (const id of [customerId, foreignCustomerId]) {
    await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [id]);
  }
  ({ projectId } = await createProject(db, customerId, "Tukuliling"));
  await saveProjectConfiguration(db, customerId, {
    projectId, brandName: "Tukuliling", variants: ["tukuliling", "#tukuliling kopi"], sources: ["threads"],
    schedule: { mode: "off", intervalHours: 6 },
  }, undefined, { x: false, threads: true, instagram: true });
  await db.query("update projects set pantau_filter_triage = true where id = $1", [projectId]);
}, 30000);

afterAll(() => pg.close());

async function snapshot(owner: string, options: { expired?: boolean; status?: string; posts?: number; prefix?: string; relevanceVersion?: number } = {}) {
  const searchId = randomUUID();
  await db.query(`insert into instant_searches
    (id, customer_id, query_text, keyword_intent, date_window, sort_mode, language_filter, status,
      finished_at, deadline_at, retention_expires_at, relevance_version)
    values ($1, $2, 'tukuliling kopi', 'phrase', 'all', 'relevance', 'all', $3,
      now(), now(), now() + $4::interval, $5)`,
    [searchId, owner, options.status ?? "succeeded", options.expired ? "-1 day" : "1 day", options.relevanceVersion ?? 1]);
  for (const source of ["threads", "instagram"]) {
    await db.query(`insert into instant_search_sources (search_id, customer_id, platform, provider, state)
      values ($1, $2, $3, 'scrapecreators', 'answered')`, [searchId, owner, source]);
  }
  for (let i = 0; i < (options.posts ?? 0); i += 1) {
    await db.query(`insert into instant_search_results
      (id, search_id, customer_id, platform, external_id, text, title, author_handle, url, published_at, relevance, source_provider, raw_ref, rank)
      values ($1, $2, $3, $4, $5, $6, $7, 'pelanggan', 'https://www.threads.net/@pelanggan/post/123',
        $8, 'literal_match', 'scrapecreators', 'raw-ref', $9)`,
      [randomUUID(), searchId, owner, i === 25 ? "instagram" : "threads", `${options.prefix ?? "post"}-${i}`,
        i === 24 ? "kopi terlalu dingin" : "Tukuliling kopi #TukulilingKopi dingin",
        i === 24 ? null : "Tukuliling", i === 0 ? null : "2026-11-01T00:00:00.000Z", i]);
  }
  return searchId;
}

function seed(searchId: string) {
  return withCustomer(db, customerId, () => seedProjectFromSearch({ db, customerId, projectId, searchId }));
}

describe("Cari project seeding", () => {
  it("rejects cross-tenant, expired, running and empty searches without importing", async () => {
    for (const searchId of [
      await snapshot(foreignCustomerId, { posts: 1 }),
      await snapshot(customerId, { expired: true, posts: 1 }),
      await snapshot(customerId, { status: "running", posts: 1 }),
      await snapshot(customerId),
    ]) {
      await expect(seed(searchId)).resolves.toMatchObject({ added: 0 });
    }
  });

  it("caps ranked evidence and retries idempotently using the project's final source and variants", async () => {
    const searchId = await snapshot(customerId, { posts: 26 });
    await expect(seed(searchId)).resolves.toEqual({ added: 20, alreadyPresent: 0, skipped: 6 });
    await expect(seed(searchId)).resolves.toEqual({ added: 0, alreadyPresent: 20, skipped: 6 });
    const found = await db.query(`select source, external_id, author, url, posted_at, pantau_title, pantau_hashtags, pantau_origin_search_id
      from mentions where project_id = $1`, [projectId]);
    expect(found.rows).toHaveLength(20);
    expect(found.rows).not.toContainEqual(expect.objectContaining({ source: "instagram" }));
    expect(found.rows).not.toContainEqual(expect.objectContaining({ external_id: "post-24" }));
    expect(found.rows).toContainEqual({
      source: "threads", external_id: "post-1", author: "pelanggan",
      url: "https://www.threads.net/@pelanggan/post/123", posted_at: new Date("2026-11-01T00:00:00.000Z"),
      pantau_title: "Tukuliling", pantau_hashtags: ["TukulilingKopi"], pantau_origin_search_id: searchId,
    });
  });

  it("stores an undated post as undated and applies the unique key used by scheduled collection", async () => {
    const other = await createProject(db, customerId, "Tukuliling");
    await saveProjectConfiguration(db, customerId, {
      projectId: other.projectId, brandName: "Tukuliling", variants: ["tukuliling"], sources: ["threads"],
      schedule: { mode: "off", intervalHours: 6 },
    }, undefined, { x: false, threads: true });
    await db.query("update projects set pantau_filter_triage = true where id = $1", [other.projectId]);
    const searchId = await snapshot(customerId, { posts: 1 });
    const seedOther = () => withCustomer(db, customerId, () => seedProjectFromSearch({
      db, customerId, projectId: other.projectId, searchId,
    }));
    await expect(seedOther()).resolves.toMatchObject({ added: 1 });
    await expect(seedOther()).resolves.toMatchObject({ alreadyPresent: 1 });
    const mentions = await db.query("select external_id, posted_at from mentions where project_id = $1", [other.projectId]);
    expect(mentions.rows).toEqual([{ external_id: "post-0", posted_at: null }]);
  });
});


it("uses one server-issued project per confirmed attempt and honors withdrawal and expiry", async () => {
  vi.stubEnv("PANTAU_FILTER_TRIAGE_ENABLED", "1");
  const configuration = {
    brandName: "Tukuliling", variants: ["tukuliling"], sources: ["threads"] as const,
    schedule: { mode: "off" as const, intervalHours: 6 },
  };
  try {
    for (const scenario of ["withdrawn", "expired", "draft-expired", "accepted"]) {
      const searchId = await snapshot(customerId, { posts: 1 });
      const started = await monitorAsProjectForCustomer({
        db, customerId, searchId, env: { CARI_SEKARANG_ENABLED: "1", PANTAU_FILTER_TRIAGE_ENABLED: "1" },
      });
      if (!started.ok || !started.cariAttemptId) throw new Error("expected server-issued Cari attempt");
      expect(started.originSearchId).toBe(searchId);
      if (scenario === "expired") {
        await db.query("update instant_searches set retention_expires_at = now() where id = $1", [searchId]);
      }
      const projectId = started.cariAttemptId;
      const expireAttempt = () => db.query("update cari_onboarding_attempts set expires_at = now() where id = $1", [projectId]);
      if (scenario === "draft-expired") await expireAttempt();
      const save = (consent: boolean, tenant = customerId) => saveProjectConfiguration(db, tenant,
        { ...configuration, sources: [...configuration.sources], projectId }, undefined,
        { x: false, threads: true }, { importSearchPosts: consent });
      await expect(save(true, foreignCustomerId)).resolves.toMatchObject({ ok: false });
      await expect(save(scenario !== "withdrawn")).resolves.toMatchObject({ ok: true });
      await expireAttempt();
      await expect(save(true)).resolves.toMatchObject({ ok: true });
      const project = await db.query("select pantau_filter_triage from projects where id = $1", [projectId]);
      expect(project.rows).toEqual([{ pantau_filter_triage: scenario === "accepted" }]);
      const mentions = await db.query("select external_id from mentions where project_id = $1", [projectId]);
      expect(mentions.rows).toEqual(scenario === "accepted" ? [{ external_id: "post-0" }] : []);
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps Cari provenance and opt-in outside worker write grants", async () => {
  const privileges = await db.query(`select
    has_column_privilege('worker_role', 'mentions', 'matched_variants', 'update') as variant_update,
    has_column_privilege('worker_role', 'mentions', 'scoring_status', 'update') as status_update,
    has_column_privilege('worker_role', 'mentions', 'pantau_title', 'insert') as title_insert,
    has_column_privilege('worker_role', 'mentions', 'pantau_origin_search_id', 'insert') as origin_insert,
    has_column_privilege('worker_role', 'projects', 'pantau_filter_triage', 'update') as pilot_update`);
  expect(privileges.rows).toEqual([{
    variant_update: true, status_update: true, title_insert: true, origin_insert: false, pilot_update: false,
  }]);
});


it("keeps ordinary prefill for a legacy snapshot and skips import of its untrusted ranks", async () => {
  const searchId = await snapshot(customerId, { posts: 1, relevanceVersion: 0 });
  const started = await monitorAsProjectForCustomer({
    db, customerId, searchId, env: { CARI_SEKARANG_ENABLED: "1", PANTAU_FILTER_TRIAGE_ENABLED: "1" },
  });
  expect(started).toMatchObject({ ok: true, fields: { brand: "tukuliling kopi" } });
  expect(started).not.toHaveProperty("cariAttemptId");
  await expect(seed(searchId)).resolves.toMatchObject({ added: 0, alreadyPresent: 0 });
});

it("prevents the application role from rewriting Cari provenance after insertion", async () => {
  const searchId = await snapshot(customerId, { posts: 1, prefix: "new-post" });
  await expect(seed(searchId)).resolves.toMatchObject({ added: 1 });
  await expect(withCustomer(db, customerId, () => db.query(
    "update mentions set pantau_origin_search_id = null where project_id = $1 and pantau_origin_search_id = $2",
    [projectId, searchId],
  ))).rejects.toThrow(/permission denied/i);
  await expect(withCustomer(db, customerId, () => db.query(
    "update mentions set read_at = now(), matched_variants = array['tukuliling'] where project_id = $1 returning id",
    [projectId],
  ))).resolves.toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]) });
});
