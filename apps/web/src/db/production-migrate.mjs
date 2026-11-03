import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} MigrationClient */

const BASELINE_FILES = ["001_init.sql", "002_schedules_jobs.sql", "003_usage_caps.sql", "004_session_lookup.sql"];

// Two-key lock space, so this does not collide with the one-key customer locks.
export const MIGRATION_ADVISORY_LOCK = [814158, 1];

/** @param {Buffer} bytes */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @param {MigrationClient} client
 * @returns {Promise<"all" | "none" | "partial">}
 */
export async function baselineSentinelsPresent(client) {
  const { rows } = await client.query(`
    select
      to_regclass('public.customers') is not null as customers,
      to_regclass('public.jobs') is not null as jobs,
      to_regclass('public.x_read_counters') is not null as x_read_counters,
      exists (
        select 1 from pg_policy
        where polname = 'sessions_token_lookup' and polrelid = to_regclass('public.sessions')
      ) as sessions_token_lookup
  `);
  const present = Object.values(rows[0]);
  if (present.every(Boolean)) return "all";
  if (!present.some(Boolean)) return "none";
  return "partial";
}

/**
 * @param {MigrationClient} client
 * @param {() => Promise<void>} fn
 */
async function inTransaction(client, fn) {
  await client.query("begin");
  try {
    await fn();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

// 001 grants every table in public to app_user, the ledger included. Revoke in
// the same transaction as that grant so a crash cannot leave the grant behind.
async function revokeLedger(client) {
  const { rows: roles } = await client.query(
    "select rolname from pg_roles where rolname in ('app_user', 'worker_role') order by rolname",
  );
  for (const { rolname } of roles) {
    await client.query(`revoke all on public.schema_migrations from ${rolname}`);
  }
}

/**
 * @param {MigrationClient} client
 * @param {{ sqlDir: string }} options
 */
export async function migrate(client, { sqlDir }) {
  await client.query("select pg_advisory_lock($1, $2)", MIGRATION_ADVISORY_LOCK);
  try {
    await migrateLocked(client, { sqlDir });
  } finally {
    await client.query("select pg_advisory_unlock($1, $2)", MIGRATION_ADVISORY_LOCK);
  }
}

/**
 * @param {MigrationClient} client
 * @param {{ sqlDir: string }} options
 */
async function migrateLocked(client, { sqlDir }) {
  const files = readdirSync(sqlDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const contents = new Map(files.map((name) => [name, readFileSync(path.join(sqlDir, name))]));
  const checksums = new Map(files.map((name) => [name, sha256(/** @type {Buffer} */ (contents.get(name)))]));

  const { rows } = await client.query("select to_regclass('public.schema_migrations') is not null as present");
  if (!rows[0].present) {
    const sentinels = await baselineSentinelsPresent(client);
    if (sentinels === "partial") {
      throw new Error(
        "refusing to migrate a partial schema: some of 001-004 are present but public.schema_migrations is missing",
      );
    }
    await inTransaction(client, async () => {
      await client.query(`
        create table public.schema_migrations (
          filename text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);
      if (sentinels === "all") {
        for (const name of BASELINE_FILES.filter((file) => checksums.has(file))) {
          await client.query("insert into public.schema_migrations (filename, checksum) values ($1, $2)", [
            name,
            checksums.get(name),
          ]);
        }
      }
      await revokeLedger(client);
    });
  }

  const applied = new Map(
    (await client.query("select filename, checksum from public.schema_migrations")).rows.map((row) => [
      row.filename,
      row.checksum,
    ]),
  );
  for (const name of files) {
    if (applied.has(name) && applied.get(name) !== checksums.get(name)) {
      throw new Error(`${name} checksum does not match the applied migration; refusing to continue`);
    }
  }

  for (const name of files) {
    if (applied.has(name)) continue;
    await inTransaction(client, async () => {
      await client.query(String(contents.get(name)));
      await client.query("insert into public.schema_migrations (filename, checksum) values ($1, $2)", [
        name,
        checksums.get(name),
      ]);
      await revokeLedger(client);
    });
  }

  await revokeLedger(client);
}

/**
 * @param {MigrationClient} client
 * @param {{ appPassword?: string, workerPassword?: string }} passwords
 */
export async function enableRoleLogin(client, { appPassword, workerPassword }) {
  const app = typeof appPassword === "string" ? appPassword.trim() : "";
  const worker = typeof workerPassword === "string" ? workerPassword.trim() : "";
  if (!app) throw new Error("APP_DB_PASSWORD is required to enable app_user login");
  if (!worker) throw new Error("WORKER_DB_PASSWORD is required to enable worker_role login");
  await client.query("begin");
  try {
    // log_min_error_statement is superuser-only. A failed ALTER is otherwise
    // written to the server log with the statement, password included.
    const { rows } = await client.query("select rolsuper from pg_roles where rolname = session_user");
    if (rows[0]?.rolsuper) {
      await client.query("select set_config('log_statement', 'none', true)");
      await client.query("select set_config('log_min_error_statement', 'panic', true)");
    }
    await client.query(`alter role app_user with login password ${pg.escapeLiteral(app)}`);
    await client.query(`alter role worker_role with login password ${pg.escapeLiteral(worker)}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
