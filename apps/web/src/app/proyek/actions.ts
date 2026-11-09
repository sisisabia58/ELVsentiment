"use server";

import { refresh } from "next/cache";
import { withSessionDeps } from "@/auth/request-session";
import { customerIdFromSessionToken } from "@/auth/session";
import { ownsProject, saveProjectConfiguration, type KeywordInput } from "@/projects/handlers";
import { readLimits, saveSchedule } from "@/projects/schedules";
import { sourceCredentials, type SourceId } from "@/monitor/policy";
import { toPersist, type ScheduleChoice } from "@/monitor/schedule-choice";

export async function saveProjectSettingsAction(input: {
  projectId: string;
  brandName: string;
  variants: KeywordInput[];
  sources: SourceId[];
  schedule: ScheduleChoice;
}): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const result = await withSessionDeps(async (deps) => {
    const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    return saveProjectConfiguration(
      deps.db,
      customerId,
      { ...input, now: new Date() },
      readLimits(),
      sourceCredentials(),
    );
  });
  if (result.ok) refresh();
  return result;
}

export async function saveScheduleAction(
  projectId: string,
  schedule: ScheduleChoice,
): Promise<{ ok: true; message: string; nextRunAt: string | null } | { ok: false; error: string }> {
  const persisted = toPersist(schedule);
  const result = await withSessionDeps(async (deps) => {
    const customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
    if (!(await ownsProject(deps.db, customerId, projectId))) return { ok: false as const, error: "Halaman tidak ditemukan atau Anda tidak memiliki akses." };
    const saved = await saveSchedule(deps.db, customerId, projectId, { ...persisted, now: new Date() }, readLimits());
    if (!saved.ok) return { ok: false as const, error: "Jarak jadwal minimal 6 jam." };
    return { ok: true as const, message: "Jadwal tersimpan.", nextRunAt: saved.nextRunAt };
  });
  if (result.ok) refresh();
  return result;
}
