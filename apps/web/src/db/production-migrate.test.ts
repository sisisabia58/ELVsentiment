import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enableRoleLogin, migrate } from "./production-migrate.mjs";

const LOCK = [814158, 1];

type Query = { sql: string; params?: unknown[] };

function recordingClient(failSql?: string, superuser = true) {
  const queries: Query[] = [];
  return {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (failSql && sql.includes(failSql)) throw new Error("boom");
      if (sql.includes("to_regclass('public.schema_migrations')")) return { rows: [{ present: false }] };
      if (sql.includes("public.customers")) {
        return {
          rows: [{ customers: false, jobs: false, x_read_counters: false, sessions_token_lookup: false }],
        };
      }
      if (sql.includes("from public.schema_migrations")) return { rows: [] };
      if (sql.includes("from pg_roles where rolname in")) {
        return { rows: [{ rolname: "app_user" }, { rolname: "worker_role" }] };
      }
      if (sql.includes("rolsuper")) return { rows: [{ rolsuper: superuser }] };
      return { rows: [] };
    },
  };
}

describe("production migrate locking", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("takes the session advisory lock before reading the database and releases it when that read fails", async () => {
    const client = recordingClient("public.schema_migrations");
    const dir = mkdtempSync(path.join(tmpdir(), "sm-lock-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "001_init.sql"), "select 1;\n");

    await expect(migrate(client, { sqlDir: dir })).rejects.toThrow("boom");

    expect(client.queries[0]).toEqual({ sql: "select pg_advisory_lock($1, $2)", params: LOCK });
    expect(client.queries.at(-1)).toEqual({ sql: "select pg_advisory_unlock($1, $2)", params: LOCK });
  });

  it("revokes the ledger inside the same transaction that applies a migration file", async () => {
    const client = recordingClient();
    const dir = mkdtempSync(path.join(tmpdir(), "sm-revoke-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "005_marker.sql"), "select 1;\n");

    await migrate(client, { sqlDir: dir });

    const sqls = client.queries.map((query) => query.sql);
    const fileAt = sqls.findIndex((sql) => sql.includes("select 1"));
    expect(fileAt).toBeGreaterThan(0);
    const commitAt = sqls.findIndex((sql, index) => index > fileAt && sql === "commit");
    const between = sqls.slice(fileAt, commitAt);
    expect(between.some((sql) => sql.includes("revoke all on public.schema_migrations from app_user"))).toBe(true);
    expect(between.some((sql) => sql.includes("revoke all on public.schema_migrations from worker_role"))).toBe(true);
  });
});

describe("role login passwords", () => {
  it("rejects a blank or whitespace password before altering a role", async () => {
    const client = recordingClient();
    await expect(enableRoleLogin(client, { appPassword: "   ", workerPassword: "worker-secret" })).rejects.toThrow(
      "APP_DB_PASSWORD",
    );
    await expect(enableRoleLogin(client, { appPassword: "app-secret", workerPassword: " \n" })).rejects.toThrow(
      "WORKER_DB_PASSWORD",
    );
    expect(client.queries).toEqual([]);
  });

  it("quotes passwords and turns off statement logging before the alter when the migration role is superuser", async () => {
    const client = recordingClient();
    await enableRoleLogin(client, {
      appPassword: "p'; drop role app_user;--",
      workerPassword: "w'orker",
    });
    const sqls = client.queries.map((query) => query.sql);
    const alterAt = sqls.findIndex((sql) => sql.startsWith("alter role app_user"));
    expect(alterAt).toBeGreaterThan(0);
    const before = sqls.slice(0, alterAt);
    expect(before).toContain("begin");
    expect(before.some((sql) => sql.includes("log_statement") && sql.includes("none"))).toBe(true);
    expect(before.some((sql) => sql.includes("log_min_error_statement") && sql.includes("panic"))).toBe(true);
    expect(sqls[alterAt]).toBe("alter role app_user with login password 'p''; drop role app_user;--'");
    expect(sqls.some((sql) => sql === "alter role worker_role with login password 'w''orker'")).toBe(true);
    expect(sqls.join("\n")).not.toContain("password p'");
    expect(sqls.at(-1)).toBe("commit");
  });

  it("sets passwords without touching log settings when the migration role is not a superuser", async () => {
    const client = recordingClient(undefined, false);
    await enableRoleLogin(client, { appPassword: "app-secret", workerPassword: "worker-secret" });
    const sqls = client.queries.map((query) => query.sql);
    expect(sqls.some((sql) => sql.includes("log_min_error_statement"))).toBe(false);
    expect(sqls.some((sql) => sql.startsWith("alter role app_user with login password "))).toBe(true);
    expect(sqls.at(-1)).toBe("commit");
  });
});
