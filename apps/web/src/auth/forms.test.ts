import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, type Queryable } from "../db/migrate";
import { signOut } from "./accounts";
import { signIn, signUp } from "./forms";
import { customerIdFromSessionToken } from "./session";

async function freshDb(): Promise<Queryable> {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  return db;
}

function emailKey(email: string): string {
  return createHash("sha256").update(`email:${email.trim().toLocaleLowerCase("id-ID")}`).digest("hex");
}

async function userCount(db: Queryable): Promise<number> {
  const result = await db.query<{ count: number }>("select count(*)::int as count from users");
  return result.rows[0].count;
}

describe("sign-up form", () => {
  it("rejects a password shorter than 8 characters and writes no row", async () => {
    const db = await freshDb();
    expect(await signUp(db, { email: "owner@example.com", password: "pendek7" })).toEqual({
      error: "Kata sandi minimal 8 karakter.",
    });
    expect(await userCount(db)).toBe(0);
  });

  it("rejects a blank email and writes no row", async () => {
    const db = await freshDb();
    expect(await signUp(db, { email: "   ", password: "sandi-panjang" })).toEqual({
      error: "Masukkan alamat email.",
    });
    expect(await userCount(db)).toBe(0);
  });

  it("rejects an email that is already registered, ignoring case", async () => {
    const db = await freshDb();
    expect(await signUp(db, { email: "owner@example.com", password: "sandi-panjang" })).toHaveProperty("token");
    expect(await signUp(db, { email: "Owner@Example.com", password: "sandi-lain-sekali" })).toEqual({
      error: "Email ini sudah terdaftar.",
    });
    expect(await userCount(db)).toBe(1);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await signUp(db, { email: "owner@example.com", password: "sandi-lain-sekali" })).toEqual({
        error: "Email ini sudah terdaftar.",
      });
    }
    const lockedSignUp = await signUp(db, { email: "owner@example.com", password: "sandi-lain-sekali" });
    expect(lockedSignUp).toMatchObject({ error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." });
    expect(lockedSignUp).toHaveProperty("lockExpiresAt");
  });

  it("treats surrounding spaces as the same email and stores it trimmed", async () => {
    const db = await freshDb();
    expect(await signUp(db, { email: " a@b.com ", password: "sandi-panjang" })).toHaveProperty("token");
    expect(await signUp(db, { email: "a@b.com", password: "sandi-lain-sekali" })).toEqual({
      error: "Email ini sudah terdaftar.",
    });
    const users = await db.query<{ email: string }>("select email from users");
    expect(users.rows).toEqual([{ email: "a@b.com" }]);
  });

  it("returns a session token for the new owner", async () => {
    const db = await freshDb();
    const result = await signUp(db, { email: "owner@example.com", password: "sandi-panjang" });
    if (!("token" in result)) throw new Error("expected a token");
    const customerId = await customerIdFromSessionToken(db, result.token);
    const users = await db.query<{ customer_id: string }>("select customer_id from users");
    expect(users.rows).toEqual([{ customer_id: customerId }]);
  });
});

describe("sign-in form", () => {
  it("returns a session token for the right password", async () => {
    const db = await freshDb();
    const created = await signUp(db, { email: "owner@example.com", password: "sandi-panjang" });
    if (!("token" in created)) throw new Error("expected a token");
    const owner = await customerIdFromSessionToken(db, created.token);
    const result = await signIn(db, { email: "OWNER@example.com", password: "sandi-panjang" });
    if (!("token" in result)) throw new Error("expected a token");
    expect(result.token).not.toBe(created.token);
    expect(await customerIdFromSessionToken(db, result.token)).toBe(owner);
    await expect(customerIdFromSessionToken(db, created.token)).rejects.toThrow("unauthenticated");
  });

  it("signs in when the email has surrounding spaces", async () => {
    const db = await freshDb();
    const created = await signUp(db, { email: "a@b.com", password: "sandi-panjang" });
    if (!("token" in created)) throw new Error("expected a token");
    const owner = await customerIdFromSessionToken(db, created.token);
    const result = await signIn(db, { email: " a@b.com ", password: "sandi-panjang" });
    if (!("token" in result)) throw new Error(`expected a token, got ${JSON.stringify(result)}`);
    expect(await customerIdFromSessionToken(db, result.token)).toBe(owner);
  });

  it("gives one message for an unknown email and a wrong password", async () => {
    const db = await freshDb();
    await signUp(db, { email: "owner@example.com", password: "sandi-panjang" });
    const wrong = { error: "Email atau kata sandi salah." };
    expect(await signIn(db, { email: "owner@example.com", password: "sandi-salah" })).toEqual(wrong);
    expect(await signIn(db, { email: "nobody@example.com", password: "sandi-panjang" })).toEqual(wrong);
    const sessions = await db.query<{ count: number }>("select count(*)::int as count from sessions");
    expect(sessions.rows[0].count).toBe(1);
  });

  it("locks sign-in after five failures for that email, then allows it once the window has passed", async () => {
    const db = await freshDb();
    await signUp(db, { email: "owner@example.com", password: "sandi-panjang" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const email = attempt % 2 === 0 ? "owner@example.com" : "OWNER@example.com";
      expect(await signIn(db, { email, password: "sandi-salah" })).toEqual({
        error: "Email atau kata sandi salah.",
      });
    }
    const locked = await signIn(db, { email: "owner@example.com", password: "sandi-panjang" });
    expect(locked).toMatchObject({ error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." });
    if (!("lockExpiresAt" in locked) || !locked.lockExpiresAt) throw new Error("expected a lock expiry");
    expect(new Date(locked.lockExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await signIn(db, { email: "nobody@example.com", password: "sandi-panjang" })).toEqual({
      error: "Email atau kata sandi salah.",
    });
    await db.exec("begin");
    await db.query("select set_config('app.throttle_key', $1, true)", [emailKey("owner@example.com")]);
    await db.exec("set local role app_user");
    const own = await db.query<{ attempt_key: string }>("select attempt_key from auth_throttle");
    await db.exec("rollback");
    expect(own.rows.map((row) => row.attempt_key)).toEqual([emailKey("owner@example.com")]);
    await db.exec("begin");
    await db.query("select set_config('app.throttle_key', $1, true)", ["0".repeat(64)]);
    await db.exec("set local role app_user");
    const hidden = await db.query("select attempt_key from auth_throttle");
    await db.exec("rollback");
    expect(hidden.rows).toEqual([]);
    await db.query("update auth_throttle set window_started_at = now() - interval '16 minutes'");
    const again = await signIn(db, { email: "owner@example.com", password: "sandi-panjang" });
    expect(again).toHaveProperty("token");
  });

  it("locks further guesses from one client address", async () => {
    const db = await freshDb();
    await signUp(db, { email: "owner@example.com", password: "sandi-panjang" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await signIn(db, { email: `nobody${attempt}@example.com`, password: "sandi-salah", ip: "203.0.113.8" }),
      ).toEqual({ error: "Email atau kata sandi salah." });
    }
    const addressLocked = await signIn(db, { email: "owner@example.com", password: "sandi-panjang", ip: "203.0.113.8" });
    expect(addressLocked).toMatchObject({ error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." });
    if (!("lockExpiresAt" in addressLocked) || typeof addressLocked.lockExpiresAt !== "string") {
      throw new Error("expected a lock expiry");
    }
    expect(new Date(addressLocked.lockExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await signIn(db, { email: "owner@example.com", password: "sandi-panjang", ip: "203.0.113.9" })).toHaveProperty(
      "token",
    );
  });

  it("tells the person how many minutes remain in the throttle window", async () => {
    const db = await freshDb();
    await signUp(db, { email: "owner@example.com", password: "sandi-panjang" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await signIn(db, { email: "owner@example.com", password: "sandi-salah" })).toEqual({
        error: "Email atau kata sandi salah.",
      });
    }
    await db.query("update auth_throttle set window_started_at = now() - interval '10 minutes 30 seconds'");
    expect(await signIn(db, { email: "owner@example.com", password: "sandi-panjang" })).toMatchObject({
      error: "Terlalu banyak percobaan. Coba lagi dalam 5 menit.",
    });
  });

  it("ends the session on sign-out", async () => {
    const db = await freshDb();
    const created = await signUp(db, { email: "owner@example.com", password: "sandi-panjang" });
    if (!("token" in created)) throw new Error("expected a token");
    await signOut(db, created.token);
    await expect(customerIdFromSessionToken(db, created.token)).rejects.toThrow("unauthenticated");
  });
});
