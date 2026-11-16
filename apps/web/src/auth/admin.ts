import { createHash } from "node:crypto";
import type { Queryable } from "../db/migrate";

// The operator grants platform admin explicitly, with SQL run after the real
// owner has signed up. An email allowlist let whoever registered an address
// first become admin, because sign-up has no email verification.
export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type PlatformAdmin = { userId: string; email: string };

export async function platformAdminForSession(
  db: Queryable,
  customerId: string,
  tokenHash: string,
): Promise<PlatformAdmin | null> {
  await db.exec("begin");
  try {
    await db.query("select set_config('app.session_token_hash', $1, true)", [tokenHash]);
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.exec("set local role app_user");
    const result = await db.query<{ user_id: string; email: string }>(
      `select s.user_id, u.email
         from sessions s
         join platform_admins pa on pa.user_id = s.user_id
         join users u on u.id = s.user_id
        where s.token_hash = current_setting('app.session_token_hash', true)
          and s.expires_at > now()
        limit 1`,
    );
    await db.exec("commit");
    const row = result.rows[0];
    return row ? { userId: row.user_id, email: row.email } : null;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
