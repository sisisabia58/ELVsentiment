import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "../db/migrate";
import { registerOwner, verifyPassword, withCustomer } from "./accounts";

describe("owner isolation", () => {
  it("hides one customer's project from the other customer", async () => {
    const pg = new PGlite();
    const db = pgliteQueryable(pg);
    await applyMigration(db);
    const first = await registerOwner(db, { email: "a@example.com", password: "sangat-rahasia" });
    const second = await registerOwner(db, { email: "b@example.com", password: "sandi-lain" });
    await withCustomer(db, first.customerId, async () => {
      await db.query(
        "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, $3, now())",
        ["00000000-0000-4000-8000-000000000001", first.customerId, "ayam geprek pak gembus"],
      );
    });
    const seen = await withCustomer(db, second.customerId, async () => {
      return db.query<{ id: string }>("select id from projects");
    });
    expect(seen.rows).toEqual([]);
    const stored = await db.query<{ password_hash: string }>("select password_hash from users where id = $1", [
      first.userId,
    ]);
    expect(stored.rows[0].password_hash).not.toContain("sangat-rahasia");
    expect(await verifyPassword("sangat-rahasia", stored.rows[0].password_hash)).toBe(true);
    expect(second.customerId).not.toBe(first.customerId);
    const roles = await db.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('app_user', 'worker_role') order by rolname",
    );
    expect(roles.rows).toEqual([
      { rolname: "app_user", rolsuper: false, rolbypassrls: false },
      { rolname: "worker_role", rolsuper: false, rolbypassrls: false },
    ]);
    const forced = await db.query<{ relforcerowsecurity: boolean; owner: string }>(
      `select c.relforcerowsecurity, r.rolname as owner
       from pg_class c
       join pg_roles r on r.oid = c.relowner
       where c.relname = 'projects'`,
    );
    expect(forced.rows[0].relforcerowsecurity).toBe(true);
    expect(forced.rows[0].owner).not.toBe("app_user");
    expect(forced.rows[0].owner).not.toBe("worker_role");
  });
});
