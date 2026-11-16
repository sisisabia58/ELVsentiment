import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSession } from "@/auth/accounts";
import { applyMigration, pgliteQueryable } from "@/db/migrate";
import { saveProviderSettingAction } from "./actions";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function seeded(admin = false) {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [
    CUSTOMER,
  ]);
  await db.query(
    "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'owner@example.com', 'hash', now())",
    [USER, CUSTOMER],
  );
  if (admin) {
    await db.query("insert into platform_admins (user_id, note) values ($1, 'test grant')", [USER]);
  }
  const session = await openSession(db, USER, CUSTOMER);
  return { db, token: session.token };
}

const CHANGE = {
  platform: "youtube",
  provider: "off",
  fallbackProvider: null,
  fallbackOnFailure: false,
};

beforeEach(() => {
  vi.stubEnv("CARI_SEKARANG_ENABLED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider settings server action", () => {
  it("rejects a signed-out caller", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const result = await saveProviderSettingAction(CHANGE, {
      db,
      readSessionToken: async () => undefined,
    });
    expect(result).toEqual({ ok: false, error: "not_admin" });
  });

  it("rejects a signed-in non-admin without writing", async () => {
    const { db, token } = await seeded(false);
    const result = await saveProviderSettingAction(CHANGE, {
      db,
      readSessionToken: async () => token,
    });
    expect(result).toEqual({ ok: false, error: "not_admin" });
    const audit = await db.query<{ n: number }>(
      "select count(*)::int as n from provider_settings_audit",
    );
    expect(audit.rows[0]?.n).toBe(0);
  });

  it("rejects writes while the Cari feature flag is off", async () => {
    const { db, token } = await seeded(true);
    vi.stubEnv("CARI_SEKARANG_ENABLED", "0");
    const result = await saveProviderSettingAction(CHANGE, {
      db,
      readSessionToken: async () => token,
    });
    expect(result).toEqual({ ok: false, error: "disabled" });
    const audit = await db.query<{ n: number }>(
      "select count(*)::int as n from provider_settings_audit",
    );
    expect(audit.rows[0]?.n).toBe(0);
  });

  it("saves for a granted platform admin and audits the actor", async () => {
    const { db, token } = await seeded(true);
    const result = await saveProviderSettingAction(CHANGE, {
      db,
      readSessionToken: async () => token,
    });
    expect(result).toEqual({ ok: true });
    const rows = await db.query<{ provider: string }>(
      "select provider from provider_settings where platform = 'youtube'",
    );
    expect(rows.rows[0]?.provider).toBe("off");
    const audit = await db.query<{ actor_email: string; new_provider: string }>(
      "select actor_email, new_provider from provider_settings_audit",
    );
    expect(audit.rows).toEqual([{ actor_email: "owner@example.com", new_provider: "off" }]);
  });
});
