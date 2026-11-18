import { randomUUID } from "node:crypto";
import type { Queryable } from "@/db/migrate";
import {
  DEFAULT_PROVIDER_SETTINGS,
  SEARCH_PLATFORMS,
  type ProviderId,
  type ProviderSetting,
  type SettingTarget,
  validateProviderChoice,
} from "./platforms";

export type ProviderSettingRow = ProviderSetting & { target: SettingTarget };

export type SaveProviderSettingInput = {
  actorEmail: string;
  customerId: string;
  sessionTokenHash: string;
  platform: string;
  provider: string;
  fallbackProvider: string | null;
  fallbackOnFailure: boolean;
};

export type SaveProviderSettingError =
  | "unknown_platform"
  | "unsupported_provider"
  | "fallback_requires_provider";

export type SaveProviderSettingResult = { ok: true } | { ok: false; error: SaveProviderSettingError };

const TARGETS: SettingTarget[] = [...SEARCH_PLATFORMS, "comments"];

function isTarget(value: string): value is SettingTarget {
  return (TARGETS as string[]).includes(value);
}

function validationError(
  target: SettingTarget,
  provider: string,
  fallbackProvider: string | null,
  fallbackOnFailure: boolean,
): SaveProviderSettingError | null {
  return validateProviderChoice(target, provider, fallbackProvider, fallbackOnFailure)
    ? null
    : "unsupported_provider";
}

export async function loadProviderSettings(
  db: Queryable,
): Promise<Record<SettingTarget, ProviderSetting>> {
  const result = await db.query<{
    platform: string;
    provider: string;
    fallback_provider: string | null;
    fallback_on_failure: boolean;
  }>("select platform, provider, fallback_provider, fallback_on_failure from provider_settings");
  const settings = { ...DEFAULT_PROVIDER_SETTINGS };
  for (const row of result.rows) {
    if (!isTarget(row.platform)) continue;
    if (validationError(row.platform, row.provider, row.fallback_provider, row.fallback_on_failure)) {
      continue;
    }
    settings[row.platform] = {
      provider: row.provider as ProviderId,
      fallbackProvider: row.fallback_provider as ProviderId | null,
      fallbackOnFailure: row.fallback_on_failure,
    };
  }
  return settings;
}

export async function loadProviderSettingRows(db: Queryable): Promise<ProviderSettingRow[]> {
  const settings = await loadProviderSettings(db);
  return TARGETS.map((target) => ({ target, ...settings[target] }));
}

export async function saveProviderSetting(
  db: Queryable,
  input: SaveProviderSettingInput,
): Promise<SaveProviderSettingResult> {
  if (!isTarget(input.platform)) return { ok: false, error: "unknown_platform" };
  const error = validationError(
    input.platform,
    input.provider,
    input.fallbackProvider,
    input.fallbackOnFailure,
  );
  if (error) return { ok: false, error };

  await db.exec("begin");
  try {
    await db.query("select set_config('app.session_token_hash', $1, true)", [
      input.sessionTokenHash,
    ]);
    // Policy providers (_set_customer in the worker, customerIdFromSessionToken
    // in the web app) use transaction-local GUCs. After a commit the value
    // reads back as '' on a reused pool connection, and ''::uuid aborts the
    // sessions policy before the token policy can match. Set it explicitly.
    await db.query("select set_config('app.customer_id', $1, true)", [input.customerId]);
    const current = await db.query<{
      provider: string;
      fallback_provider: string | null;
      fallback_on_failure: boolean;
    }>(
      "select provider, fallback_provider, fallback_on_failure from provider_settings where platform = $1",
      [input.platform],
    );
    const previous = current.rows[0] ?? null;
    await db.query(
      `insert into provider_settings
         (platform, provider, fallback_provider, fallback_on_failure, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (platform) do update set
         provider = excluded.provider,
         fallback_provider = excluded.fallback_provider,
         fallback_on_failure = excluded.fallback_on_failure,
         updated_by = excluded.updated_by,
         updated_at = now()`,
      [
        input.platform,
        input.provider,
        input.fallbackProvider,
        input.fallbackOnFailure,
        input.actorEmail,
      ],
    );
    await db.query(
      `insert into provider_settings_audit
         (id, platform, old_provider, new_provider, old_fallback_provider,
          new_fallback_provider, old_fallback_on_failure, new_fallback_on_failure, actor_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        input.platform,
        previous?.provider ?? null,
        input.provider,
        previous?.fallback_provider ?? null,
        input.fallbackProvider,
        previous?.fallback_on_failure ?? null,
        input.fallbackOnFailure,
        input.actorEmail,
      ],
    );
    await db.exec("commit");
    return { ok: true };
  } catch (failure) {
    await db.exec("rollback");
    throw failure;
  }
}
