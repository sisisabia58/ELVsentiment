import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer, type Queryable } from "../db/migrate";
import { createProject } from "./handlers";
import {
  collectionOutcome,
  collectionSentence,
  formatCollectedAt,
  readProjectCollection,
  sourceStateSummary,
} from "./dashboard-status";

describe("collection status copy", () => {
  it("formats a success instant in Asia/Jakarta", () => {
    expect(formatCollectedAt("2026-11-01T00:00:00.000Z")).toBe("1 November 2026, 07.00 WIB");
  });

  it("keeps the four collection cases distinct", () => {
    expect(collectionOutcome({ hasProject: false, latestStatus: null })).toBe("none");
    expect(collectionSentence("none", "")).toBe("Belum ada pengumpulan data");

    expect(collectionOutcome({ hasProject: true, latestStatus: null })).toBe("none");
    expect(collectionSentence("none", "2026-11-01T00:00:00.000Z")).toBe("Belum ada pengumpulan data");

    expect(collectionOutcome({ hasProject: true, latestStatus: "failed" })).toBe("failed");
    expect(collectionOutcome({ hasProject: true, latestStatus: "deferred" })).toBe("failed");
    expect(collectionSentence("failed", "2026-11-01T00:00:00.000Z")).toBe(
      "Pengumpulan gagal. Ini bukan nol sebutan.",
    );

    expect(collectionOutcome({ hasProject: true, latestStatus: "succeeded" })).toBe("succeeded");
    expect(collectionSentence("succeeded", "2026-11-01T00:00:00.000Z")).toBe(
      "Pengumpulan terakhir berhasil 1 November 2026, 07.00 WIB",
    );

    expect(collectionOutcome({ hasProject: true, latestStatus: "queued" })).toBe("queued");
    expect(collectionSentence("queued", "")).toBe("Pekerjaan masuk antrean.");
    expect(collectionOutcome({ hasProject: true, latestStatus: "claimed" })).toBe("claimed");
  });

  it("does not call a missing source status unavailable", () => {
    expect(sourceStateSummary([])).toBe("Status sumber belum tercatat.");
    expect(
      sourceStateSummary([
        { source: "x", state: "ready" },
        { source: "threads", state: "unavailable" },
      ]),
    ).toBe("Status X: Siap. Status Threads: Tidak tersedia");
  });
});

describe("project collection rows", () => {
  async function ownerProject(): Promise<{ db: Queryable; customerId: string; projectId: string }> {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "Ayam Geprek Uji");
    return { db, customerId: owner.customerId, projectId: project.projectId };
  }

  it("reads no jobs as an empty collection and ignores another tenant", async () => {
    const { db, customerId, projectId } = await ownerProject();
    const other = await registerOwner(db, { email: "other@example.com", password: "sandi-panjang" });
    const empty = await withCustomer(db, customerId, () => readProjectCollection(db, projectId));
    expect(empty).toMatchObject({
      latestStatus: null,
      lastCollectedAt: "",
      pending: 0,
      failed: 0,
      sourceState: "Status sumber belum tercatat.",
    });
    const hidden = await withCustomer(db, other.customerId, () => readProjectCollection(db, projectId));
    expect(hidden.latestStatus).toBeNull();
    expect(hidden.pending).toBe(0);
  });

  it("uses the newest job, real scoring counts, and recorded source status", async () => {
    const { db, customerId, projectId } = await ownerProject();
    const succeeded = randomUUID();
    const failed = randomUUID();
    await withCustomer(db, customerId, async () => {
      await db.query(
        `insert into project_schedules (project_id, customer_id, enabled, interval_hours, time_zone, last_collected_at)
         values ($1, $2, false, 6, 'Asia/Jakarta', '2026-11-01T00:00:00.000Z')`,
        [projectId, customerId],
      );
      await db.query(
        `insert into jobs (id, customer_id, project_id, kind, status, run_after, created_at)
         values ($1, $2, $3, 'manual', 'succeeded', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
        [succeeded, customerId, projectId],
      );
      await db.query(
        `insert into jobs (id, customer_id, project_id, kind, status, run_after, created_at)
         values ($1, $2, $3, 'scheduled', 'failed', '2026-11-01T01:00:00.000Z', '2026-11-01T01:00:00.000Z')`,
        [failed, customerId, projectId],
      );
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'x', '1', 'satu', 'https://x.com/a/status/1', 'ani', now(), now(), array['ayam'], 'pending')`,
        [randomUUID(), customerId, projectId],
      );
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'x', '2', 'dua', 'https://x.com/a/status/2', 'ani', now(), now(), array['ayam'], 'scoring')`,
        [randomUUID(), customerId, projectId],
      );
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'threads', '3', 'tiga', 'https://www.threads.net/@a/post/3', 'ani', now(), now(), array['ayam'], 'failed')`,
        [randomUUID(), customerId, projectId],
      );
      await db.query(
        `insert into source_status (customer_id, project_id, source, state, detail, updated_at)
         values ($1, $2, 'threads', 'unavailable', '', now()), ($1, $2, 'x', 'ready', '', now())`,
        [customerId, projectId],
      );
    });
    const row = await withCustomer(db, customerId, () => readProjectCollection(db, projectId));
    expect(row.latestStatus).toBe("failed");
    expect(row.lastCollectedAt).toContain("2026-11-01");
    expect(row.pending).toBe(2);
    expect(row.failed).toBe(1);
    expect(row.sourceState).toBe("Status X: Siap. Status Threads: Tidak tersedia");
    expect(collectionSentence(collectionOutcome({ hasProject: true, latestStatus: row.latestStatus }), row.lastCollectedAt)).toBe(
      "Pengumpulan gagal. Ini bukan nol sebutan.",
    );
  });

  it("ignores a newer skipped overlap when choosing the latest collection", async () => {
    const { db, customerId, projectId } = await ownerProject();
    await withCustomer(db, customerId, async () => {
      await db.query(
        `insert into jobs (id, customer_id, project_id, kind, status, run_after, created_at)
         values ($1, $2, $3, 'manual', 'succeeded', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
        [randomUUID(), customerId, projectId],
      );
      await db.query(
        `insert into jobs (id, customer_id, project_id, kind, status, status_detail, run_after, created_at)
         values ($1, $2, $3, 'manual', 'deferred', 'skipped_overlap', '2026-11-01T02:00:00.000Z', '2026-11-01T02:00:00.000Z')`,
        [randomUUID(), customerId, projectId],
      );
    });
    const row = await withCustomer(db, customerId, () => readProjectCollection(db, projectId));
    expect(row.latestStatus).toBe("succeeded");
  });
});
