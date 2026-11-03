import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject } from "./handlers";
import { expiredClaimReports } from "./job-reports";

describe("expired claim reports", () => {
  it("returns only this customer's claim_expired jobs", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const other = await registerOwner(db, { email: "other@example.com", password: "sandi-lain-sekali" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const otherProject = await createProject(db, other.customerId, "merek lain");
    const expired = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const older = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const succeeded = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const otherExpired = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const httpFailed = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    async function insert(
      customerId: string,
      id: string,
      projectId: string,
      status: string,
      detail: string | null,
      claimedAt: string,
    ) {
      await withCustomer(db, customerId, () =>
        db.query(
          `insert into jobs (id, customer_id, project_id, kind, status, run_after, claimed_at, status_detail, created_at)
           values ($1, $2, $3, 'manual', $4, now(), $5, $6, now())`,
          [id, customerId, projectId, status, claimedAt, detail],
        ),
      );
    }

    await insert(owner.customerId, older, project.projectId, "failed", "claim_expired", "2026-11-01T00:00:00.000Z");
    await insert(owner.customerId, expired, project.projectId, "failed", "claim_expired", "2026-11-01T02:00:00.000Z");
    await insert(owner.customerId, succeeded, project.projectId, "succeeded", null, "2026-11-01T03:00:00.000Z");
    await insert(owner.customerId, httpFailed, project.projectId, "failed", "x_http_429", "2026-11-01T04:00:00.000Z");
    await insert(other.customerId, otherExpired, otherProject.projectId, "failed", "claim_expired", "2026-11-01T05:00:00.000Z");

    const reports = await expiredClaimReports(db, owner.customerId);
    expect(reports).toEqual([
      {
        jobId: expired,
        projectId: project.projectId,
        kind: "manual",
        outcome: "failed",
        detail: "claim_expired",
        fetchedCount: null,
        claimedAt: "2026-11-01T02:00:00.000Z",
      },
      {
        jobId: older,
        projectId: project.projectId,
        kind: "manual",
        outcome: "failed",
        detail: "claim_expired",
        fetchedCount: null,
        claimedAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
  });
});
