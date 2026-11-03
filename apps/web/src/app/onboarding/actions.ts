"use server";

import { customerIdFromSessionToken, type SessionActionDeps } from "@/auth/session";
import { createProject, ownsProject, saveActiveVariants } from "@/projects/handlers";

export async function createProjectAction(
  brandName: string,
  deps: SessionActionDeps,
): Promise<{ projectId: string; brandName: string; candidates: string[] } | null> {
  const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
  const trimmed = brandName.trim();
  if (!trimmed) return null;
  const created = await createProject(deps.db, customerId, trimmed);
  return { projectId: created.projectId, brandName: trimmed, candidates: created.candidates };
}

export async function saveVariantsAction(
  projectId: string,
  variants: string[],
  deps: SessionActionDeps,
): Promise<{ ok: true; active: string[] } | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string }> {
  const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
  if (!(await ownsProject(deps.db, customerId, projectId))) throw new Error("project_not_found");
  return saveActiveVariants(deps.db, customerId, projectId, variants, async () => undefined);
}
