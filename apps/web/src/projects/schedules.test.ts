import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer, type Queryable } from "../db/migrate";
import { createProject } from "./handlers";
import { collectionControlState, readLimits, requestManualRun, saveSchedule } from "./schedules";

describe("readLimits CONFIG_DIR", () => {
  it("reads limits.json from CONFIG_DIR when set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "config-dir-"));
    writeFileSync(
      path.join(dir, "limits.json"),
      JSON.stringify({
        schedule_min_interval_hours: 11,
        manual_min_interval_seconds: 901,
        worker_heartbeat_stale_seconds: 91,
      }),
    );
    const previous = process.env.CONFIG_DIR;
    process.env.CONFIG_DIR = dir;
    try {
      expect(readLimits()).toEqual({
        scheduleMinIntervalHours: 11,
        manualMinIntervalSeconds: 901,
        workerHeartbeatStaleSeconds: 91,
      });
    } finally {
      if (previous === undefined) delete process.env.CONFIG_DIR;
      else process.env.CONFIG_DIR = previous;
    }
  });

  it("uses committed limits when CONFIG_DIR is unset", () => {
    const previous = process.env.CONFIG_DIR;
    delete process.env.CONFIG_DIR;
    try {
      expect(readLimits()).toMatchObject({
        scheduleMinIntervalHours: 6,
        manualMinIntervalSeconds: 900,
        workerHeartbeatStaleSeconds: 90,
      });
    } finally {
      if (previous === undefined) delete process.env.CONFIG_DIR;
      else process.env.CONFIG_DIR = previous;
    }
  });

  it("prefers an explicit file argument over CONFIG_DIR", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "config-dir-"));
    writeFileSync(
      path.join(dir, "limits.json"),
      JSON.stringify({
        schedule_min_interval_hours: 11,
        manual_min_interval_seconds: 901,
        worker_heartbeat_stale_seconds: 91,
      }),
    );
    const explicitDir = mkdtempSync(path.join(tmpdir(), "explicit-limits-"));
    const explicitFile = path.join(explicitDir, "limits.json");
    writeFileSync(
      explicitFile,
      JSON.stringify({
        schedule_min_interval_hours: 99,
        manual_min_interval_seconds: 999,
        worker_heartbeat_stale_seconds: 999,
      }),
    );
    const previous = process.env.CONFIG_DIR;
    process.env.CONFIG_DIR = dir;
    try {
      expect(readLimits(explicitFile)).toMatchObject({
        scheduleMinIntervalHours: 99,
        manualMinIntervalSeconds: 999,
        workerHeartbeatStaleSeconds: 999,
      });
    } finally {
      if (previous === undefined) delete process.env.CONFIG_DIR;
      else process.env.CONFIG_DIR = previous;
    }
  });
});

describe("shared collection limits", () => {
  it("applies SCHEDULE_MIN_INTERVAL_HOURS from the environment over the file", () => {
    const previous = process.env.SCHEDULE_MIN_INTERVAL_HOURS;
    process.env.SCHEDULE_MIN_INTERVAL_HOURS = "12";
    try {
      expect(readLimits().scheduleMinIntervalHours).toBe(12);
    } finally {
      if (previous === undefined) delete process.env.SCHEDULE_MIN_INTERVAL_HOURS;
      else process.env.SCHEDULE_MIN_INTERVAL_HOURS = previous;
    }
  });

  it("rejects a saved interval below the shared minimum", async () => {
    const previous = process.env.SCHEDULE_MIN_INTERVAL_HOURS;
    process.env.SCHEDULE_MIN_INTERVAL_HOURS = "12";
    try {
      const db = pgliteQueryable(new PGlite());
      await applyMigration(db);
      const limits = readLimits();
      const owner = await registerOwner(db, { email: "limits@example.com", password: "sandi-panjang" });
      const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
      const saved = await saveSchedule(
        db,
        owner.customerId,
        project.projectId,
        { enabled: true, intervalHours: 6 },
        limits,
      );
      expect(saved).toEqual({ ok: false, reason: "interval_too_short" });
    } finally {
      if (previous === undefined) delete process.env.SCHEDULE_MIN_INTERVAL_HOURS;
      else process.env.SCHEDULE_MIN_INTERVAL_HOURS = previous;
    }
  });
});

describe("project schedules and manual jobs", () => {
  it("stores a WIB schedule and rate-limits a second manual run", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const limits = readLimits();
    expect(limits).toMatchObject({ scheduleMinIntervalHours: 6, manualMinIntervalSeconds: 900 });
    const owner = await registerOwner(db, { email: "a@example.com", password: "sandi-panjang" });
    const other = await registerOwner(db, { email: "b@example.com", password: "sandi-lain-sekali" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const tooSoon = await saveSchedule(db, owner.customerId, project.projectId, { enabled: true, intervalHours: 5 }, limits);
    expect(tooSoon).toEqual({ ok: false, reason: "interval_too_short" });
    const saved = await saveSchedule(db, owner.customerId, project.projectId, { enabled: true, intervalHours: 6 }, limits);
    expect(saved.ok).toBe(true);
    const row = await withCustomer(db, owner.customerId, () =>
      db.query<{ time_zone: string; interval_hours: number }>(
        "select time_zone, interval_hours from project_schedules where project_id = $1",
        [project.projectId],
      ),
    );
    expect(row.rows[0]).toEqual({ time_zone: "Asia/Jakarta", interval_hours: 6 });
    const now = new Date("2026-11-01T03:00:00.000Z");
    const ready = { x: true, threads: true };
    const first = await requestManualRun(db, owner.customerId, project.projectId, now, limits, ready);
    expect(first.ok).toBe(true);
    const blocked = await requestManualRun(
      db,
      owner.customerId,
      project.projectId,
      new Date(now.getTime() + 14 * 60 * 1000),
      limits,
      ready,
    );
    expect(blocked).toMatchObject({ ok: false, reason: "manual_rate_limited" });
    await db.query(
      "insert into worker_heartbeat (id, worker_id, last_seen_at) values (1, 'worker-1', $1)",
      [now.toISOString()],
    );
    const state = await collectionControlState(
      db,
      owner.customerId,
      new Date(now.getTime() + 14 * 60 * 1000),
      limits,
    );
    expect(state.manualBlocked).toBe(true);
    expect(state.retryAt).toEqual(expect.any(String));
    expect(state.lastSeenAt).toEqual(expect.any(String));
    const jobs = await withCustomer(db, owner.customerId, () =>
      db.query<{ kind: string; status: string }>("select kind, status from jobs"),
    );
    expect(jobs.rows).toEqual([{ kind: "manual", status: "queued" }]);
    const hidden = await withCustomer(db, other.customerId, () => db.query("select id from jobs"));
    expect(hidden.rows).toEqual([]);
    const later = await requestManualRun(
      db,
      owner.customerId,
      project.projectId,
      new Date(now.getTime() + 15 * 60 * 1000),
      limits,
      ready,
    );
    expect(later).toMatchObject({ ok: false, reason: "run_in_progress" });
    await withCustomer(db, owner.customerId, () =>
      db.query("update jobs set status = 'succeeded' where status = 'queued'"),
    );
    const after = await requestManualRun(
      db,
      owner.customerId,
      project.projectId,
      new Date(now.getTime() + 15 * 60 * 1000),
      limits,
      ready,
    );
    expect(after.ok).toBe(true);
    const history = await withCustomer(db, owner.customerId, () =>
      db.query<{ status: string; status_detail: string | null }>(
        "select status, status_detail from jobs order by created_at, id",
      ),
    );
    expect(history.rows.map((row) => row.status_detail)).toContain("skipped_overlap");
  });

  it("locks the customer before reading the latest manual job", async () => {
    const recorded: { sql: string; params?: unknown[] }[] = [];
    const db: Queryable = {
      async query(sql, params) {
        recorded.push({ sql, params });
        return { rows: [] };
      },
      async exec(sql) {
        recorded.push({ sql });
      },
    };
    const customerId = "11111111-1111-4111-8111-111111111111";
    const result = await requestManualRun(
      db,
      customerId,
      "22222222-2222-4222-8222-222222222222",
      new Date("2026-11-01T03:00:00.000Z"),
      readLimits(),
      { x: true, threads: false },
    );
    expect(result.ok).toBe(true);
    const lockAt = recorded.findIndex((entry) => entry.sql.includes("pg_advisory_xact_lock"));
    const jobsAt = recorded.findIndex((entry) => /\bfrom\s+jobs\b/i.test(entry.sql));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(recorded[lockAt]?.sql.replace(/\s+/g, " ")).toContain(
      "select pg_advisory_xact_lock(hashtext($1::text))",
    );
    expect(recorded[lockAt]?.params).toEqual([customerId]);
    expect(jobsAt).toBeGreaterThan(lockAt);
  });

  it("does not queue a manual run when every selected source is unconfigured", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "kosong@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const now = new Date("2026-11-01T03:00:00.000Z");
    const refused = await requestManualRun(db, owner.customerId, project.projectId, now, readLimits(), {
      x: false,
      threads: false,
    });
    expect(refused).toEqual({ ok: false, reason: "sources_unavailable" });
    const jobs = await withCustomer(db, owner.customerId, () => db.query("select id from jobs"));
    expect(jobs.rows).toEqual([]);
  });
});
