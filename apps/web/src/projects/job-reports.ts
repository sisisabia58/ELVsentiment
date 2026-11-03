import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";

export type ExpiredClaimReport = {
  jobId: string;
  projectId: string;
  kind: "scheduled" | "manual";
  outcome: "failed";
  detail: "claim_expired";
  fetchedCount: null;
  claimedAt: string | null;
};

function claimedAtIso(value: string | Date | null): string | null {
  if (value == null) return null;
  return new Date(value).toISOString();
}

export async function expiredClaimReports(db: Queryable, customerId: string): Promise<ExpiredClaimReport[]> {
  const rows = await withCustomer(db, customerId, () =>
    db.query<{ id: string; project_id: string; kind: "scheduled" | "manual"; claimed_at: string | Date | null }>(
      `select id, project_id, kind, claimed_at
       from jobs
       where status = 'failed' and status_detail = 'claim_expired'
       order by claimed_at desc nulls last, id`,
    ),
  );
  return rows.rows.map((row) => ({
    jobId: row.id,
    projectId: row.project_id,
    kind: row.kind,
    outcome: "failed",
    detail: "claim_expired",
    fetchedCount: null,
    claimedAt: claimedAtIso(row.claimed_at),
  }));
}
