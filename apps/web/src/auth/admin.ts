import type { Queryable } from "../db/migrate";

type AdminEnv = { ADMIN_EMAILS?: string };

export function isAdminEmail(
  email: string | null | undefined,
  env: AdminEnv = process.env,
): boolean {
  const candidate = email?.trim().toLocaleLowerCase("id-ID");
  if (!candidate) return false;
  const allowed = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLocaleLowerCase("id-ID"))
    .filter(Boolean);
  return allowed.includes(candidate);
}

export async function adminEmailForCustomer(
  db: Queryable,
  customerId: string,
): Promise<string | null> {
  const result = await db.query<{ email: string }>(
    "select email from users where customer_id = $1 order by created_at limit 1",
    [customerId],
  );
  return result.rows[0]?.email ?? null;
}
