"use server";

import { adminEmailForCustomer, isAdminEmail } from "@/auth/admin";
import { customerIdFromSessionToken, type SessionActionDeps } from "@/auth/session";
import { withCustomer } from "@/db/migrate";
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
  let customerId: string;
  try {
    customerId = await customerIdFromSessionToken(deps.db, await deps.readSessionToken());
  } catch {
    return { ok: false, error: "not_admin" };
  }
  const email = await withCustomer(deps.db, customerId, () =>
    adminEmailForCustomer(deps.db, customerId),
  );
  if (!isAdminEmail(email)) return { ok: false, error: "not_admin" };
  return saveProviderSetting(deps.db, {
    actorEmail: email as string,
    platform: input.platform,
    provider: input.provider,
    fallbackProvider: input.fallbackProvider,
    fallbackOnFailure: input.fallbackOnFailure,
  });
}
