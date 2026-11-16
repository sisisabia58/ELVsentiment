import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "../db/migrate";
import { adminEmailForCustomer, isAdminEmail } from "./admin";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";

describe("admin allowlist", () => {
  it("accepts listed emails case-insensitively and trims spaces", () => {
    const env = { ADMIN_EMAILS: " owner@example.com, QA@example.com " };
    expect(isAdminEmail("owner@example.com", env)).toBe(true);
    expect(isAdminEmail("qa@example.com", env)).toBe(true);
    expect(isAdminEmail(" OWNER@example.com ", env)).toBe(true);
  });

  it("rejects missing, blank, and unlisted emails", () => {
    expect(isAdminEmail("owner@example.com", {})).toBe(false);
    expect(isAdminEmail("owner@example.com", { ADMIN_EMAILS: " " })).toBe(false);
    expect(isAdminEmail(null, { ADMIN_EMAILS: "owner@example.com" })).toBe(false);
    expect(isAdminEmail("", { ADMIN_EMAILS: "owner@example.com" })).toBe(false);
    expect(isAdminEmail("other@example.com", { ADMIN_EMAILS: "owner@example.com" })).toBe(false);
  });

  it("looks up the oldest customer email only for the given customer", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [CUSTOMER]);
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'owner@example.com', 'hash', now() - interval '1 day')",
      ["22222222-2222-4222-8222-222222222222", CUSTOMER],
    );
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'newer@example.com', 'hash', now())",
      ["33333333-3333-4333-8333-333333333333", CUSTOMER],
    );
    expect(await adminEmailForCustomer(db, CUSTOMER)).toBe("owner@example.com");
    expect(await adminEmailForCustomer(db, "44444444-4444-4444-8444-444444444444")).toBeNull();
  });
});
