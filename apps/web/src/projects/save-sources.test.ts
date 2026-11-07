import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject, saveProjectConfiguration } from "./handlers";
import { readLimits } from "./schedules";

describe("saving sources", () => {
  it("does not store a source whose server credential is missing", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "Kedai Contoh");
    const saved = await saveProjectConfiguration(
      db,
      owner.customerId,
      {
        projectId: project.projectId,
        brandName: "Kedai Contoh",
        variants: ["kedai contoh"],
        sources: ["x", "threads"],
        schedule: { mode: "off", intervalHours: 6 },
      },
      readLimits(),
      { x: true, threads: false },
    );
    expect(saved.ok).toBe(true);
    const row = await withCustomer(db, owner.customerId, () =>
      db.query<{ enabled_sources: string[] }>("select enabled_sources from project_settings where project_id = $1", [
        project.projectId,
      ]),
    );
    expect(row.rows[0]?.enabled_sources).toEqual(["x"]);
  });

  it("allows a project to be saved when every source key is missing", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "Kedai Contoh");
    const saved = await saveProjectConfiguration(
      db,
      owner.customerId,
      {
        projectId: project.projectId,
        brandName: "Kedai Contoh",
        variants: ["kedai contoh"],
        sources: ["x", "threads"],
        schedule: { mode: "off", intervalHours: 6 },
        now: new Date("2026-11-01T00:00:00.000Z"),
      },
      readLimits(),
      { x: false, threads: false },
    );
    expect(saved).toMatchObject({ ok: true });
    const row = await withCustomer(db, owner.customerId, () =>
      db.query<{ enabled_sources: string[] }>("select enabled_sources from project_settings where project_id = $1", [
        project.projectId,
      ]),
    );
    expect(row.rows[0]?.enabled_sources ?? []).toEqual([]);
    expect(randomUUID()).toHaveLength(36);
  });

  it("does not store X or Threads when the caller omits credentials", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "Kedai Contoh");
    const saved = await saveProjectConfiguration(
      db,
      owner.customerId,
      {
        projectId: project.projectId,
        brandName: "Kedai Contoh",
        variants: ["kedai contoh"],
        sources: ["x", "threads"],
        schedule: { mode: "off", intervalHours: 6 },
      },
      readLimits(),
    );
    expect(saved).toMatchObject({ ok: true });
    const row = await withCustomer(db, owner.customerId, () =>
      db.query<{ enabled_sources: string[] }>("select enabled_sources from project_settings where project_id = $1", [
        project.projectId,
      ]),
    );
    expect(row.rows[0]?.enabled_sources ?? []).toEqual([]);
  });

  it("still requires a working source when one is configured", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "Kedai Contoh");
    const saved = await saveProjectConfiguration(
      db,
      owner.customerId,
      {
        projectId: project.projectId,
        brandName: "Kedai Contoh",
        variants: ["kedai contoh"],
        sources: ["threads"],
        schedule: { mode: "off", intervalHours: 6 },
      },
      readLimits(),
      { x: true, threads: false },
    );
    expect(saved).toEqual({ ok: false, error: "Pilih setidaknya satu sumber." });
  });

  it("permits instagram and tiktok in project_settings, mentions, source_status, and source_cursors after migration 009", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "Kedai Contoh");

    const defaultRow = await withCustomer(db, owner.customerId, () =>
      db.query<{ enabled_sources: string[] }>("select enabled_sources from project_settings where project_id = $1", [
        project.projectId,
      ]),
    );
    expect(defaultRow.rows[0]?.enabled_sources).toEqual(["x", "threads", "instagram", "tiktok"]);

    await withCustomer(db, owner.customerId, async () => {
      await db.query("update project_settings set enabled_sources = $1 where project_id = $2", [
        ["x", "threads", "instagram", "tiktok"],
        project.projectId,
      ]);
      for (const source of ["instagram", "tiktok"] as const) {
        await db.query(
          `insert into mentions (
             id, customer_id, project_id, source, external_id, excerpt,
             posted_at, collected_at, matched_variants, scoring_status
           ) values ($1, $2, $3, $4, $5, 'uji', now(), now(), $6, 'pending')`,
          [randomUUID(), owner.customerId, project.projectId, source, `ext-${source}`, ["kedai contoh"]],
        );
        await db.query(
          `insert into source_status (customer_id, project_id, source, state, detail, updated_at)
           values ($1, $2, $3, 'ready', 'ok', now())`,
          [owner.customerId, project.projectId, source],
        );
        await db.query(
          `insert into source_cursors (customer_id, query_key, source)
           values ($1, $2, $3)`,
          [owner.customerId, `${project.projectId}:${source}`, source],
        );
      }
    });

    const row = await withCustomer(db, owner.customerId, () =>
      db.query<{ enabled_sources: string[] }>("select enabled_sources from project_settings where project_id = $1", [
        project.projectId,
      ]),
    );
    expect(row.rows[0]?.enabled_sources).toEqual(["x", "threads", "instagram", "tiktok"]);
  });
});

