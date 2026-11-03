import { createHash } from "node:crypto";
import type { Queryable } from "../db/migrate";

const MAX_FAILURES = 5;
const WINDOW = "15 minutes";

export function ipThrottleKey(ip: string | null | undefined): string | null {
  const address = ip?.trim() ?? "";
  if (!address) return null;
  return createHash("sha256").update(`ip:${address}`).digest("hex");
}

export function authThrottleKeys(email: string, ip?: string): string[] {
  const normalized = email.trim().toLocaleLowerCase("id-ID");
  const keys = [createHash("sha256").update(`email:${normalized}`).digest("hex")];
  const addressKey = ipThrottleKey(ip);
  if (addressKey) keys.push(addressKey);
  return keys;
}

async function withThrottleKey<T>(db: Queryable, key: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('app.throttle_key', $1, true)", [key]);
    await db.exec("set local role app_user");
    const value = await fn();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

export function retryMinutesFromSeconds(retrySeconds: number): number {
  if (!Number.isFinite(retrySeconds)) return 1;
  return Math.max(1, Math.ceil(retrySeconds / 60));
}

export function lockoutMessage(retryMinutes: number): string {
  return `Terlalu banyak percobaan. Coba lagi dalam ${retryMinutes} menit.`;
}

export type ActiveLock = { expiresAt: Date; retryMinutes: number };

export async function authThrottleLockExpiresAt(db: Queryable, keys: string[]): Promise<ActiveLock | null> {
  let latest: ActiveLock | null = null;
  for (const key of keys) {
    const expires = await withThrottleKey(db, key, async () => {
      const found = await db.query<{ lock_expires_at: Date | string | null; retry_minutes: number | string | null }>(
        `select case
           when failures >= ${MAX_FAILURES}
             and window_started_at + interval '${WINDOW}' > now()
           then window_started_at + interval '${WINDOW}'
           else null
         end as lock_expires_at,
         case
           when failures >= ${MAX_FAILURES}
             and window_started_at + interval '${WINDOW}' > now()
           then ceil(extract(epoch from (window_started_at + interval '${WINDOW}' - now())) / 60.0)
           else null
         end as retry_minutes
         from auth_throttle`,
      );
      const row = found.rows[0];
      if (!row || row.lock_expires_at == null || row.retry_minutes == null) return null;
      const expiresAt = row.lock_expires_at instanceof Date ? row.lock_expires_at : new Date(row.lock_expires_at);
      const retryMinutes = Math.max(1, Math.ceil(Number(row.retry_minutes)));
      if (Number.isNaN(expiresAt.getTime()) || !Number.isFinite(retryMinutes)) return null;
      return { expiresAt, retryMinutes };
    });
    if (expires && (latest == null || expires.expiresAt.getTime() > latest.expiresAt.getTime())) latest = expires;
  }
  return latest;
}

export async function recordAuthFailure(db: Queryable, keys: string[]): Promise<void> {
  for (const key of keys) {
    await withThrottleKey(db, key, async () => {
      await db.query(
        `insert into auth_throttle (attempt_key, failures, window_started_at)
         values (current_setting('app.throttle_key', true), 1, now())
         on conflict (attempt_key) do update set
           failures = case
             when auth_throttle.window_started_at <= now() - interval '${WINDOW}' then 1
             else auth_throttle.failures + 1
           end,
           window_started_at = case
             when auth_throttle.window_started_at <= now() - interval '${WINDOW}' then now()
             else auth_throttle.window_started_at
           end`,
      );
    });
  }
}

export async function clearAuthThrottle(db: Queryable, keys: string[]): Promise<void> {
  for (const key of keys) {
    await withThrottleKey(db, key, () => db.query("delete from auth_throttle"));
  }
}
