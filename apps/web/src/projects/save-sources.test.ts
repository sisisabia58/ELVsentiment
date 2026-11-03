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
});
