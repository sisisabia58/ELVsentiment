"use server";

import { platformAdminForSession, sessionTokenHash } from "@/auth/admin";
import { customerIdFromSessionToken, type SessionActionDeps } from "@/auth/session";
import { cariSekarangEnabled } from "@/monitor/search/feature";
import { saveProviderSetting } from "@/monitor/search/provider-settings";

export type ProviderSettingActionInput = {
  platform: string;
  provider: string;
  fallbackProvider: string | null;
  fallbackOnFailure: boolean;
};

export type ProviderSettingActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function saveProviderSettingAction(
  input: ProviderSettingActionInput,
  deps: SessionActionDeps,
): Promise<ProviderSettingActionResult> {
  if (!cariSekarangEnabled()) return { ok: false, error: "disabled" };
  let customerId: string;
  let token: string;
  try {
    const read = await deps.readSessionToken();
    if (!read) return { ok: false, error: "not_admin" };
    token = read;
    customerId = await customerIdFromSessionToken(deps.db, token);
  } catch {
    return { ok: false, error: "not_admin" };
  }
  const hash = sessionTokenHash(token);
  const admin = await platformAdminForSession(deps.db, customerId, hash);
  if (!admin) return { ok: false, error: "not_admin" };
  return saveProviderSetting(deps.db, {
    actorEmail: admin.email,
    sessionTokenHash: hash,
    platform: input.platform,
    provider: input.provider,
    fallbackProvider: input.fallbackProvider,
    fallbackOnFailure: input.fallbackOnFailure,
  });
}
