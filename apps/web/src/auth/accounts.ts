import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import { hashPassword, verifyPassword } from "./password";
import { customerIdFromSessionToken } from "./session";

export const SESSION_COOKIE = "sm_session";

// A missing user still runs scrypt, so the response time does not reveal the email.
const DUMMY_PASSWORD_HASH = `scrypt$131072$8$1$${"11".repeat(16)}$${"22".repeat(32)}`;

export { verifyPassword, withCustomer };

export type SessionCookieContext = {
  nodeEnv?: string;
  protocol?: string | null;
  forwardedProto?: string | null;
};

function firstProto(value: string | null | undefined): string {
  if (!value) return "";
  return value.split(",")[0].trim().toLowerCase().replace(/:$/, "");
}

function requestIsHttps(protocol?: string | null, forwardedProto?: string | null): boolean {
  return firstProto(protocol) === "https" || firstProto(forwardedProto) === "https";
}

export function sessionCookieOptions(context: SessionCookieContext = {}) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 1209600,
    secure: context.nodeEnv === "production" || requestIsHttps(context.protocol, context.forwardedProto),
  };
}

export function sessionCookie(token: string, context: SessionCookieContext = {}): string {
  const options = sessionCookieOptions(context);
  const attributes = ["HttpOnly", "SameSite=Lax", `Path=${options.path}`, `Max-Age=${options.maxAge}`];
  if (options.secure) attributes.push("Secure");
  return [`${SESSION_COOKIE}=${token}`, ...attributes].join("; ");
}

export async function registerOwner(
  db: Queryable,
  input: { email: string; password: string; displayName?: string | null },
): Promise<{ customerId: string; userId: string }> {
  const customerId = randomUUID();
  const userId = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await db.exec("begin");
  try {
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.query(
      "insert into customers (id, customer_id, created_at) values ($1, $1, now())",
      [customerId],
    );
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at, display_name) values ($1, $2, $3, $4, now(), $5)",
      [userId, customerId, input.email.toLocaleLowerCase("id-ID"), passwordHash, input.displayName?.trim() || null],
    );
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { customerId, userId };
}

export async function authenticateOwner(
  db: Queryable,
  email: string,
  password: string,
): Promise<{ userId: string; customerId: string } | null> {
  const loginEmail = email.toLocaleLowerCase("id-ID");
  await db.exec("begin");
  try {
    await db.query("select set_config('app.login_email', $1, true)", [loginEmail]);
    await db.query(
      "select set_config('app.customer_id', '00000000-0000-0000-0000-000000000000', true)",
    );
    await db.exec("set local role app_user");
    const found = await db.query<{ id: string; customer_id: string; password_hash: string }>(
      "select id, customer_id, password_hash from users where email = current_setting('app.login_email', true)",
    );
    const user = found.rows[0];
    const passwordHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
    const matches = await verifyPassword(password, passwordHash);
    if (!user || !matches) {
      await db.exec("rollback");
      return null;
    }
    await db.exec("commit");
    return { userId: user.id, customerId: user.customer_id };
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

export async function openSession(
  db: Queryable,
  userId: string,
  customerId: string,
  context: SessionCookieContext = { nodeEnv: process.env.NODE_ENV },
): Promise<{ token: string; cookie: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.exec("begin");
  try {
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.exec("set local role app_user");
    await db.query("delete from sessions where user_id = $1", [userId]);
    await db.query(
      "insert into sessions (id, customer_id, user_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '14 days')",
      [randomUUID(), customerId, userId, tokenHash],
    );
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return {
    token,
    cookie: sessionCookie(token, context),
  };
}

export async function saveDisplayName(
  db: Queryable,
  customerId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Masukkan nama Anda." };
  if (trimmed.length > 80) return { ok: false, error: "Nama terlalu panjang." };
  const updated = await withCustomer(db, customerId, () =>
    db.query<{ id: string }>("update users set display_name = $1 where customer_id = $2 returning id", [trimmed, customerId]),
  );
  if (updated.rows.length < 1) return { ok: false, error: "Perubahan belum tersimpan. Coba lagi." };
  return { ok: true };
}

export async function signOut(db: Queryable, token: string): Promise<void> {
  const customerId = await customerIdFromSessionToken(db, token);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.exec("begin");
  try {
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.exec("set local role app_user");
    await db.query("delete from sessions where token_hash = $1", [tokenHash]);
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
