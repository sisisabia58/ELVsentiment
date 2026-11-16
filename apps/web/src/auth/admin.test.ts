import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "../db/migrate";
import { openSession } from "./accounts";
import { platformAdminForSession, sessionTokenHash } from "./admin";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function seeded(options: { admin?: boolean; email?: string; expires?: string } = {}) {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [CUSTOMER]);
  await db.query(
    "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, $3, 'hash', now())",
    [USER, CUSTOMER, options.email ?? "owner@example.com"],
  );
  const session = await openSession(db, USER, CUSTOMER);
  if (options.admin) {
    await db.query("insert into platform_admins (user_id, note) values ($1, 'test grant')", [USER]);
  }
  if (options.expires) {
    await db.query("update sessions set expires_at = $1 where user_id = $2", [options.expires, USER]);
  }
  return { db, token: session.token, userId: USER };
}

describe("platform admin sessions", () => {
  it("hashes the session token the same way the database stores it", () => {
    expect(sessionTokenHash("token-a")).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionTokenHash("token-a")).toBe(sessionTokenHash("token-a"));
    expect(sessionTokenHash("token-a")).not.toBe(sessionTokenHash("token-b"));
  });

  it("recognises only a live session whose user was granted platform admin", async () => {
    const { db, token, userId } = await seeded({ admin: true });
    expect(await platformAdminForSession(db, CUSTOMER, sessionTokenHash(token))).toEqual({
      userId,
      email: "owner@example.com",
    });
  });

  it("rejects a signed-in user who was never granted", async () => {
    const { db, token } = await seeded();
    expect(await platformAdminForSession(db, CUSTOMER, sessionTokenHash(token))).toBeNull();
  });

  it("rejects an expired admin session", async () => {
    const { db, token } = await seeded({ admin: true, expires: "2000-01-01T00:00:00Z" });
    expect(await platformAdminForSession(db, CUSTOMER, sessionTokenHash(token))).toBeNull();
  });

  it("rejects a token that does not belong to the admin", async () => {
    const { db } = await seeded({ admin: true });
    expect(await platformAdminForSession(db, CUSTOMER, sessionTokenHash("not-a-session"))).toBeNull();
  });

  it("ignores the email entirely, including an ADMIN_EMAILS-looking address", async () => {
    const other = await seeded({ email: "admin@example.com" });
    const stored = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "admin@example.com";
    try {
      expect(await platformAdminForSession(other.db, CUSTOMER, sessionTokenHash(other.token))).toBeNull();
    } finally {
      if (stored === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = stored;
    }
  });
});
