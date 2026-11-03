import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject, latestProject, saveActiveVariants } from "./handlers";

describe("saveActiveVariants", () => {
  it("rejects a duplicate and does not rescore history", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    expect(project.candidates).toContain("geprek gembus");
    const mentionId = randomUUID();
    await withCustomer(db, owner.customerId, async () => {
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'x', '100', 'geprek gembus enak', 'https://x.com/a/status/100', 'ani', now(), now(), array['geprek gembus'], 'succeeded')`,
        [mentionId, owner.customerId, project.projectId],
      );
    });
    const rescore = vi.fn(async () => undefined);
    const duplicate = await saveActiveVariants(
      db,
      owner.customerId,
      project.projectId,
      ["geprek gembus", "geprek gembus"],
      rescore,
    );
    expect(duplicate).toMatchObject({ ok: false, reason: "duplicate" });
    const saved = await saveActiveVariants(
      db,
      owner.customerId,
      project.projectId,
      ["geprek gembus", "ayam pak gembus"],
      rescore,
    );
    expect(saved).toEqual({ ok: true, active: ["geprek gembus", "ayam pak gembus"] });
    expect(rescore).not.toHaveBeenCalled();
    const status = await withCustomer(db, owner.customerId, () =>
      db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [mentionId]),
    );
    expect(status.rows[0].scoring_status).toBe("succeeded");
  });
});

describe("latestProject", () => {
  it("returns null for a customer with no project", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    expect(await latestProject(db, owner.customerId)).toBeNull();
  });

  it("returns the newest project with its active variants selected", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const other = await registerOwner(db, { email: "other@example.com", password: "sandi-panjang" });
    const older = await createProject(db, owner.customerId, "kopi lama");
    await withCustomer(db, owner.customerId, () =>
      db.query("update projects set created_at = now() - interval '1 day' where id = $1", [older.projectId]),
    );
    const newer = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    await createProject(db, other.customerId, "bakso tetangga");
    const rescore = async () => undefined;
    await saveActiveVariants(db, owner.customerId, newer.projectId, ["geprek gembus", "gembus pedas"], rescore);
    await saveActiveVariants(db, owner.customerId, newer.projectId, ["gembus pedas"], rescore);

    expect(await latestProject(db, owner.customerId)).toEqual({
      projectId: newer.projectId,
      brandName: "ayam geprek pak gembus",
      candidates: [...newer.candidates, "gembus pedas"],
      selected: ["gembus pedas"],
    });
  });
});
