import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

export type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
};

export function pgliteQueryable(db: PGlite): Queryable {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await db.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}

export async function applyMigration(db: Queryable): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    await db.exec(readFileSync(path.join(dir, name), "utf8"));
  }
}

export async function withCustomer<T>(db: Queryable, customerId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.exec("set local role app_user");
    const value = await fn();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
