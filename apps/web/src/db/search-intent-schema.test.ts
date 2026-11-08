import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "./migrate";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PROJECT_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";

async function seed(db: ReturnType<typeof pgliteQueryable>) {
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [CUSTOMER]);
  await db.query(
    "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, 'A', now())",
    [PROJECT_A, CUSTOMER],
  );
  await db.query(
    "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, 'B', now())",
    [PROJECT_B, CUSTOMER],
  );
}

const INSERT_MENTION = `insert into mentions
  (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
  values (gen_random_uuid(), $1, $2, 'threads', 'same-post', 'kopi', null, null, now(), now(), array['kopi'], 'pending')`;

describe("search intent schema", () => {
  it("adds keyword intent, project-scoped mention uniqueness, and associations", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    await seed(db);
    const oldConstraint = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conname = 'mentions_customer_id_source_external_id_key'",
    );
    expect(oldConstraint.rows[0]?.n).toBe(0);
    const newConstraint = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conname = 'mentions_customer_id_project_id_source_external_id_key'",
    );
    expect(newConstraint.rows[0]?.n).toBe(1);
    await db.query(
      `insert into keyword_variants (id, customer_id, project_id, text, active, created_at, intent)
       values (gen_random_uuid(), $1, $2, '#kopi', true, now(), 'hashtag')`,
      [CUSTOMER, PROJECT_A],
    );
    const keywords = await db.query<{ intent: string }>(
      "select intent from keyword_variants where project_id = $1",
      [PROJECT_A],
    );
    expect(keywords.rows[0]?.intent).toBe("hashtag");

    await db.query(INSERT_MENTION, [CUSTOMER, PROJECT_A]);
    await db.query(INSERT_MENTION, [CUSTOMER, PROJECT_B]);
    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from mentions where customer_id = $1",
      [CUSTOMER],
    );
    expect(count.rows[0]?.n).toBe(2);
    await expect(db.query(INSERT_MENTION, [CUSTOMER, PROJECT_A])).rejects.toThrow();

    await db.query(
      `insert into mention_keyword_associations
         (id, customer_id, project_id, mention_id, keyword_text, intent, route_id, source, status, collected_at)
       select gen_random_uuid(), $1, $2, m.id, '#kopi', 'hashtag', 'instagram.hashtag', 'instagram', 'literal_match', now()
       from mentions m where m.project_id = $2`,
      [CUSTOMER, PROJECT_A],
    );
    const association = await db.query<{ status: string }>(
      "select status from mention_keyword_associations where project_id = $1",
      [PROJECT_A],
    );
    expect(association.rows[0]?.status).toBe("literal_match");

    // PGlite does not model role logins here. Task 8's
    // test_postgres16_worker_association_rejects_other_customer asserts that a
    // worker-context insert for a different customer is rejected by the
    // tenant-scoped worker policy.
  });
});
