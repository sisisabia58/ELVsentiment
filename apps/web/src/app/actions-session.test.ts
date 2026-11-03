import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { openSession, registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject } from "../projects/handlers";
import { runNowAction } from "./dasbor/actions";
import { createProjectAction, saveVariantsAction } from "./onboarding/actions";

describe("server actions take the customer from the session", () => {
  it("attributes a manual run to the session customer and ignores a client id", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const intruder = await registerOwner(db, { email: "intruder@example.com", password: "sandi-lain-sekali" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const session = await openSession(db, owner.userId, owner.customerId);
    const forged = {
      db,
      readSessionToken: async () => session.token,
      customerId: intruder.customerId,
    };
    const previousToken = process.env.X_BEARER_TOKEN;
    process.env.X_BEARER_TOKEN = "test-token";
    let result: Awaited<ReturnType<typeof runNowAction>>;
    try {
      result = await runNowAction(project.projectId, forged);
    } finally {
      if (previousToken === undefined) delete process.env.X_BEARER_TOKEN;
      else process.env.X_BEARER_TOKEN = previousToken;
    }
    expect(result.ok).toBe(true);
    const jobs = await withCustomer(db, owner.customerId, () =>
      db.query<{ customer_id: string }>("select customer_id from jobs"),
    );
    expect(jobs.rows).toEqual([{ customer_id: owner.customerId }]);
    const hidden = await withCustomer(db, intruder.customerId, () => db.query("select id from jobs"));
    expect(hidden.rows).toEqual([]);
  });

  it("does not collect when the session token is missing", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    await expect(
      runNowAction(project.projectId, { db, readSessionToken: async () => null }),
    ).rejects.toThrow("unauthenticated");
    const jobs = await withCustomer(db, owner.customerId, () => db.query("select id from jobs"));
    expect(jobs.rows).toEqual([]);
  });

  it("saves variants for the session customer and ignores a client id", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const intruder = await registerOwner(db, { email: "intruder@example.com", password: "sandi-lain-sekali" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const session = await openSession(db, owner.userId, owner.customerId);
    const forged = {
      db,
      readSessionToken: async () => session.token,
      customerId: intruder.customerId,
    };
    const saved = await saveVariantsAction(project.projectId, ["geprek gembus"], forged);
    expect(saved).toEqual({ ok: true, active: ["geprek gembus"] });
    const rows = await withCustomer(db, owner.customerId, () =>
      db.query<{ customer_id: string; text: string }>(
        "select customer_id, text from keyword_variants where active",
      ),
    );
    expect(rows.rows).toEqual([{ customer_id: owner.customerId, text: "geprek gembus" }]);
    const hidden = await withCustomer(db, intruder.customerId, () =>
      db.query("select id from keyword_variants"),
    );
    expect(hidden.rows).toEqual([]);
  });

  it("creates a project for the session customer and returns its candidates", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const session = await openSession(db, owner.userId, owner.customerId);
    const created = await createProjectAction(" ayam geprek pak gembus ", {
      db,
      readSessionToken: async () => session.token,
    });
    expect(created?.brandName).toBe("ayam geprek pak gembus");
    expect(created?.candidates).toContain("geprek gembus");
    const rows = await withCustomer(db, owner.customerId, () =>
      db.query<{ id: string; brand_name: string }>("select id, brand_name from projects"),
    );
    expect(rows.rows).toEqual([{ id: created?.projectId, brand_name: "ayam geprek pak gembus" }]);
  });

  it("does not create a project for a blank brand name", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const session = await openSession(db, owner.userId, owner.customerId);
    expect(await createProjectAction("   ", { db, readSessionToken: async () => session.token })).toBeNull();
    const rows = await withCustomer(db, owner.customerId, () => db.query("select id from projects"));
    expect(rows.rows).toEqual([]);
  });

  it("refuses to queue a run or save variants against another customer's project", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const intruder = await registerOwner(db, { email: "intruder@example.com", password: "sandi-lain-sekali" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const intruderSession = await openSession(db, intruder.userId, intruder.customerId);
    const deps = { db, readSessionToken: async () => intruderSession.token };
    await expect(runNowAction(project.projectId, deps)).rejects.toThrow("project_not_found");
    await expect(saveVariantsAction(project.projectId, ["geprek gembus"], deps)).rejects.toThrow("project_not_found");
    const jobs = await db.query("select id from jobs");
    const variants = await db.query("select id from keyword_variants");
    expect(jobs.rows).toEqual([]);
    expect(variants.rows).toEqual([]);
  });
});
