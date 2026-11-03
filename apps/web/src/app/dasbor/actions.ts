"use server";

import { customerIdFromSessionToken, type SessionActionDeps } from "@/auth/session";
import { ownsProject } from "@/projects/handlers";
import { readLimits, requestManualRun } from "@/projects/schedules";

export type { SessionActionDeps };

export async function runNowAction(
  projectId: string,
  deps: SessionActionDeps,
): Promise<
  | { ok: true; jobId: string }
  | { ok: false; reason: "manual_rate_limited"; retryAt: string }
  | { ok: false; reason: "run_in_progress"; jobId: string }
  | { ok: false; reason: "sources_unavailable" }
> {
  const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
  if (!(await ownsProject(deps.db, customerId, projectId))) throw new Error("project_not_found");
  return requestManualRun(deps.db, customerId, projectId, new Date(), readLimits());
}
