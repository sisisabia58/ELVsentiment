import { createHash } from "node:crypto";
import type { Queryable } from "../db/migrate";

export type SessionActionDeps = {
  db: Queryable;
  readSessionToken: () => Promise<string | null | undefined>;
};

export async function customerIdFromSessionToken(
  db: Queryable,
  token: string | null | undefined,
): Promise<string> {
  if (!token) throw new Error("unauthenticated");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.exec("begin");
  try {
    await db.query("select set_config('app.session_token_hash', $1, true)", [tokenHash]);
    // The tenant policy casts app.customer_id. PGlite yields '' when it is unset,
    // and ''::uuid errors. A nil id matches no customer; the token policy still matches.
    await db.query(
      "select set_config('app.customer_id', '00000000-0000-0000-0000-000000000000', true)",
    );
    await db.exec("set local role app_user");
    const found = await db.query<{ customer_id: string }>(
      `select customer_id from sessions
       where token_hash = current_setting('app.session_token_hash', true)
         and expires_at > now()`,
    );
    const customerId = found.rows[0]?.customer_id;
    if (!customerId) throw new Error("unauthenticated");
    await db.exec("commit");
    return customerId;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
