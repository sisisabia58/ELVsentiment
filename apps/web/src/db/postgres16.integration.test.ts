import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticateOwner, openSession, registerOwner } from "../auth/accounts";
import { runNowAction } from "../app/dasbor/actions";
import { saveVariantsAction } from "../app/onboarding/actions";
import { createProject } from "../projects/handlers";
import { type Queryable, withCustomer } from "./migrate";
import { enableRoleLogin, MIGRATION_ADVISORY_LOCK, migrate, sha256 } from "./production-migrate.mjs";

const ADMIN_URL = process.env.POSTGRES_TEST_URL ?? "";
const DB_NAME = "sm_deploy_migrate";
// Same key as scoring-postgres16.integration.test.ts. Held on the admin connection
// for the whole file so parallel Vitest runs cannot drop app_user and worker_role together.
const SHARED_ROLE_ADVISORY_LOCK = [814158, 648] as const;
const WEB_DIR = path.resolve(import.meta.dirname, "../..");
const SQL_DIR = path.join(WEB_DIR, "src", "db", "sql");
const BASELINE_FILES = ["001_init.sql", "002_schedules_jobs.sql", "003_usage_caps.sql", "004_session_lookup.sql"];
const APP_PASSWORD = "app-secret-not-for-logs";
const WORKER_PASSWORD = "worker-secret-not-for-logs";

// WHATWG URL rejects libpq's host-less socket form (postgresql://user@/db).
function parseAdminUrl() {
  const match = /^(postgres(?:ql)?:\/\/)(?:([^@/?]*)@)?([^/?]*)(?:\/([^?]*))?(?:\?(.*))?$/.exec(ADMIN_URL);
  if (!match) throw new Error("POSTGRES_TEST_URL is not a postgres URL");
  const [, scheme, userinfo = "", hostport, database = "", query = ""] = match;
  const [host, port = ""] = hostport.split(":");
  return { scheme, userinfo, hostport, host, port, database, query: new URLSearchParams(query) };
}

// pg (unlike libpq) treats a URL without a hostname as TCP to localhost, so
// point it at the default unix socket directory when the admin URL has none.
function dbUrl(dbname: string): string {
  const { scheme, userinfo, hostport, host, query } = parseAdminUrl();
  if (!host && !query.has("host")) query.set("host", process.env.PGHOST ?? "/var/run/postgresql");
  const search = query.toString();
  return `${scheme}${userinfo ? `${userinfo}@` : ""}${hostport}/${dbname}${search ? `?${search}` : ""}`;
}

// Password logins go over TCP: local sockets may use peer auth, which ignores passwords.
function loginConfig(user: string, password: string) {
  const { host, port } = parseAdminUrl();
  return {
    host: host || "127.0.0.1",
    port: Number(port || 5432),
    database: DB_NAME,
    user,
    password,
  };
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function dropDatabaseAndRoles(admin: Client): Promise<void> {
  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [DB_NAME],
  );
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.query("drop role if exists app_user");
  await admin.query("drop role if exists worker_role");
}

function copySqlDir(files: string[] = readdirSync(SQL_DIR).filter((name) => name.endsWith(".sql"))): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sm-migrate-"));
  for (const name of files) copyFileSync(path.join(SQL_DIR, name), path.join(dir, name));
  return dir;
}

async function checksums(client: Client): Promise<Record<string, string>> {
  const result = await client.query<{ filename: string; checksum: string }>(
    "select filename, checksum from schema_migrations order by filename",
  );
  return Object.fromEntries(result.rows.map((row) => [row.filename, row.checksum]));
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [
    `public.${name}`,
  ]);
  return result.rows[0].exists;
}

async function ledgerPrivileges(client: Client): Promise<Record<string, boolean>> {
  const result = await client.query<{ role: string; privilege: string; granted: boolean }>(
    `select role, privilege, has_table_privilege(role, 'public.schema_migrations', privilege) as granted
     from unnest(array['app_user', 'worker_role']) as role,
          unnest(array['select', 'insert', 'update', 'delete']) as privilege`,
  );
  return Object.fromEntries(result.rows.map((row) => [`${row.role}:${row.privilege}`, row.granted]));
}

const NO_LEDGER_PRIVILEGES = Object.fromEntries(
  ["app_user", "worker_role"].flatMap((role) =>
    ["select", "insert", "update", "delete"].map((privilege) => [`${role}:${privilege}`, false]),
  ),
);

function clientAsQueryable(client: Client): Queryable {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

function runCli(env: Record<string, string>) {
  return spawnSync(process.execPath, ["src/db/migrate-cli.mjs"], {
    cwd: WEB_DIR,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...env },
    encoding: "utf8",
  });
}

describe.skipIf(!ADMIN_URL)("production migrations on Postgres 16", { timeout: 60_000 }, () => {
  let admin: Client;
  let db: Client;
  let rolesLocked = false;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    admin = await connect(dbUrl(parseAdminUrl().database || "postgres"));
    await admin.query("select pg_advisory_lock($1, $2)", [...SHARED_ROLE_ADVISORY_LOCK]);
    rolesLocked = true;
    const version = await admin.query<{ server_version_num: string }>("show server_version_num");
    const major = Math.floor(Number(version.rows[0].server_version_num) / 10000);
    if (major !== 16) throw new Error(`need Postgres 16, connected to ${version.rows[0].server_version_num}`);
    await dropDatabaseAndRoles(admin);
  }, 180_000);

  beforeEach(async () => {
    await dropDatabaseAndRoles(admin);
    await admin.query(`create database ${DB_NAME}`);
    db = await connect(dbUrl(DB_NAME));
  });

  afterEach(async () => {
    await db?.end();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      if (rolesLocked) await dropDatabaseAndRoles(admin);
    } finally {
      if (rolesLocked) {
        await admin.query("select pg_advisory_unlock($1, $2)", [...SHARED_ROLE_ADVISORY_LOCK]);
        rolesLocked = false;
      }
      await admin.end();
    }
  }, 180_000);

  it("applies every sql file to a fresh database and is a no-op the second time", async () => {
    await migrate(db, { sqlDir: SQL_DIR });

    const files = readdirSync(SQL_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const expected = Object.fromEntries(
      files.map((name) => [name, sha256(readFileSync(path.join(SQL_DIR, name)))]),
    );
    expect(await checksums(db)).toEqual(expected);

    await migrate(db, { sqlDir: SQL_DIR });
    expect(await checksums(db)).toEqual(expected);

    const count = await db.query<{ count: string }>("select count(*) from customers");
    expect(count.rows[0].count).toBe("0");
    expect(await ledgerPrivileges(db)).toEqual(NO_LEDGER_PRIVILEGES);
  });

  it("refuses an applied file whose checksum changed and runs nothing after it", async () => {
    const dir = copySqlDir();
    tempDirs.push(dir);
    await migrate(db, { sqlDir: dir });

    const initPath = path.join(dir, "001_init.sql");
    const bytes = readFileSync(initPath);
    expect(bytes[0]).toBe("c".charCodeAt(0));
    bytes[0] = "C".charCodeAt(0);
    writeFileSync(initPath, bytes);
    writeFileSync(path.join(dir, "009_should_not_run.sql"), "create table should_not_run (id int primary key);\n");

    const error = await migrate(db, { sqlDir: dir }).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("001_init.sql");
    expect(error?.message).toContain("checksum");
    expect(await tableExists(db, "jobs")).toBe(true);
    expect(await tableExists(db, "should_not_run")).toBe(false);
    expect(Object.keys(await checksums(db))).not.toContain("009_should_not_run.sql");

    execFileSync(
      "git",
      ["diff", "--exit-code", "--", ...BASELINE_FILES.map((name) => `apps/web/src/db/sql/${name}`)],
      { cwd: path.resolve(WEB_DIR, "../..") },
    );
  });

  it("baselines a database that already has 001-004 without re-running them", async () => {
    for (const name of BASELINE_FILES) {
      execFileSync("psql", [dbUrl(DB_NAME), "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(SQL_DIR, name)], {
        stdio: "pipe",
      });
    }
    expect(await tableExists(db, "schema_migrations")).toBe(false);

    const dir = copySqlDir(BASELINE_FILES);
    tempDirs.push(dir);
    writeFileSync(path.join(dir, "005_marker.sql"), "create table migrate_marker (id int primary key);\n");

    await migrate(db, { sqlDir: dir });

    const rows = await checksums(db);
    expect(Object.keys(rows)).toEqual([...BASELINE_FILES, "005_marker.sql"]);
    for (const name of [...BASELINE_FILES, "005_marker.sql"]) {
      expect(rows[name]).toBe(sha256(readFileSync(path.join(dir, name))));
    }
    expect(await tableExists(db, "migrate_marker")).toBe(true);
    expect(await ledgerPrivileges(db)).toEqual(NO_LEDGER_PRIVILEGES);
  });

  it("holds the migration lock until the runner finishes", async () => {
    const holder = await connect(dbUrl(DB_NAME));
    try {
      await holder.query("select pg_advisory_lock($1, $2)", MIGRATION_ADVISORY_LOCK);
      let finished = false;
      const running = migrate(db, { sqlDir: SQL_DIR }).then(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      await holder.query("select pg_advisory_unlock($1, $2)", MIGRATION_ADVISORY_LOCK);
      await running;
      expect(finished).toBe(true);
      expect(await tableExists(db, "schema_migrations")).toBe(true);
    } finally {
      await holder.end();
    }
  });

  it("refuses a partial schema without schema_migrations", async () => {
    execFileSync(
      "psql",
      [dbUrl(DB_NAME), "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(SQL_DIR, "001_init.sql")],
      { stdio: "pipe" },
    );

    await expect(migrate(db, { sqlDir: SQL_DIR })).rejects.toThrow("partial schema");
    expect(await tableExists(db, "jobs")).toBe(false);
    expect(await tableExists(db, "schema_migrations")).toBe(false);
  });

  it("rejects a whitespace role password and does not enable login", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await expect(enableRoleLogin(db, { appPassword: "   ", workerPassword: WORKER_PASSWORD })).rejects.toThrow(
      "APP_DB_PASSWORD",
    );
    const roles = await db.query<{ rolcanlogin: boolean }>(
      "select rolcanlogin from pg_roles where rolname = 'app_user'",
    );
    expect(roles.rows[0].rolcanlogin).toBe(false);
  });

  it("logs in with a quoted password and keeps a failed alter out of the server log", async () => {
    const marker = "canary-token-9f3a";
    const canary = `pw-${marker}'; drop role app_user;--`;
    const logPath = "/var/log/postgresql/postgresql-16-main.log";
    const before = readFileSync(logPath, "utf8").length;
    const error = await enableRoleLogin(db, { appPassword: canary, workerPassword: `${canary}-w` }).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(`${error?.message ?? ""}\n${String(error)}`).not.toContain(marker);
    const added = readFileSync(logPath, "utf8").slice(before);
    expect(added).not.toContain(marker);

    await migrate(db, { sqlDir: SQL_DIR });
    const appPassword = "p'; drop role app_user;--";
    const workerPassword = "w'orker";
    await enableRoleLogin(db, { appPassword, workerPassword });
    const login = new Client(loginConfig("app_user", appPassword));
    await login.connect();
    try {
      const current = await login.query<{ current_user: string }>("select current_user");
      expect(current.rows[0].current_user).toBe("app_user");
    } finally {
      await login.end();
    }
    const survivor = await db.query("select 1 from pg_roles where rolname = 'app_user'");
    expect(survivor.rowCount).toBe(1);
  });

  it("enables password login for the app and worker roles without privileges or leaks", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });

    const roles = await db.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles
       where rolname in ('app_user', 'worker_role') order by rolname`,
    );
    expect(roles.rows).toEqual([
      { rolname: "app_user", rolcanlogin: true, rolsuper: false, rolbypassrls: false },
      { rolname: "worker_role", rolcanlogin: true, rolsuper: false, rolbypassrls: false },
    ]);
    const owner = await db.query<{ rolname: string }>(
      "select r.rolname from pg_class c join pg_roles r on r.oid = c.relowner where c.oid = 'public.projects'::regclass",
    );
    expect(["app_user", "worker_role"]).not.toContain(owner.rows[0].rolname);

    for (const [user, password] of [
      ["app_user", APP_PASSWORD],
      ["worker_role", WORKER_PASSWORD],
    ]) {
      const login = new Client(loginConfig(user, password));
      await login.connect();
      try {
        const current = await login.query<{ current_user: string }>("select current_user");
        expect(current.rows[0].current_user).toBe(user);
      } finally {
        await login.end();
      }
    }

    const migrationUrl = dbUrl(DB_NAME);
    const { userinfo } = parseAdminUrl();
    const env = {
      MIGRATION_DATABASE_URL: migrationUrl,
      APP_DB_PASSWORD: APP_PASSWORD,
      WORKER_DB_PASSWORD: WORKER_PASSWORD,
    };
    for (let run = 0; run < 2; run += 1) {
      const result = runCli(env);
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(0);
      expect(result.stdout).toBe("migrations applied\n");
      expect(output).not.toContain(APP_PASSWORD);
      expect(output).not.toContain(WORKER_PASSWORD);
      expect(output).not.toContain(migrationUrl);
      if (userinfo) expect(output).not.toContain(userinfo);
    }

    const missing = runCli({ ...env, APP_DB_PASSWORD: "" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("APP_DB_PASSWORD");
    expect(missing.stdout + missing.stderr).not.toContain(WORKER_PASSWORD);
  });

  it("runs sign-up, sign-in, onboarding, and Run now through the web pool as app_user", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });
    const login = loginConfig("app_user", APP_PASSWORD);
    process.env.DATABASE_URL = `postgresql://app_user:${encodeURIComponent(APP_PASSWORD)}@${login.host}:${login.port}/${DB_NAME}`;
    const { endPool, withClient } = await import("./pg");
    try {
      const role = await withClient((client) =>
        client.query<{ current_user: string; rolbypassrls: boolean; projects_owner: string }>(
          `select current_user,
             (select rolbypassrls from pg_roles where rolname = current_user) as rolbypassrls,
             (select r.rolname from pg_class c join pg_roles r on r.oid = c.relowner
              where c.oid = 'public.projects'::regclass) as projects_owner`,
        ),
      );
      expect(role.rows[0].current_user).toBe("app_user");
      expect(role.rows[0].rolbypassrls).toBe(false);
      expect(role.rows[0].projects_owner).not.toBe("app_user");

      const ownerA = await withClient((client) =>
        registerOwner(client, { email: "owner-a@example.com", password: "sandi-panjang" }),
      );
      const ownerB = await withClient((client) =>
        registerOwner(client, { email: "owner-b@example.com", password: "sandi-lain-sekali" }),
      );
      expect(await withClient((client) => authenticateOwner(client, "owner-a@example.com", "sandi-panjang"))).toEqual({
        userId: ownerA.userId,
        customerId: ownerA.customerId,
      });
      expect(await withClient((client) => authenticateOwner(client, "owner-a@example.com", "sandi-salah"))).toBeNull();
      expect(await withClient((client) => authenticateOwner(client, "nobody@example.com", "sandi-panjang"))).toBeNull();

      const sessionA = await withClient((client) => openSession(client, ownerA.userId, ownerA.customerId));
      const project = await withClient((client) => createProject(client, ownerA.customerId, "ayam geprek pak gembus"));
      const saved = await withClient((client) =>
        saveVariantsAction(project.projectId, ["geprek gembus"], {
          db: client,
          readSessionToken: async () => sessionA.token,
        }),
      );
      expect(saved).toEqual({ ok: true, active: ["geprek gembus"] });
      const asA = (sql: string) =>
        withClient((client) => withCustomer(client, ownerA.customerId, () => client.query(sql)));
      const asB = (sql: string) =>
        withClient((client) => withCustomer(client, ownerB.customerId, () => client.query(sql)));
      expect((await asA("select id from projects")).rows).toEqual([{ id: project.projectId }]);
      expect((await asA("select text from keyword_variants where active")).rows).toEqual([{ text: "geprek gembus" }]);
      expect((await asB("select id from projects")).rows).toEqual([]);
      expect((await asB("select id from keyword_variants")).rows).toEqual([]);

      const previousToken = process.env.X_BEARER_TOKEN;
      process.env.X_BEARER_TOKEN = "test-token";
      let run: Awaited<ReturnType<typeof runNowAction>>;
      try {
        run = await withClient((client) =>
          runNowAction(project.projectId, { db: client, readSessionToken: async () => sessionA.token }),
        );
      } finally {
        if (previousToken === undefined) delete process.env.X_BEARER_TOKEN;
        else process.env.X_BEARER_TOKEN = previousToken;
      }
      expect(run.ok).toBe(true);
      expect(
        (await asA("select customer_id, kind, status, run_after <= now() as due from jobs")).rows,
      ).toEqual([{ customer_id: ownerA.customerId, kind: "manual", status: "queued", due: true }]);
      expect((await asB("select id from jobs")).rows).toEqual([]);
    } finally {
      await endPool();
      delete process.env.DATABASE_URL;
    }
  });

  it("refuses to serve through the web pool as worker_role or a disguised superuser", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });
    const { endPool, withClient } = await import("./pg");
    const worker = loginConfig("worker_role", WORKER_PASSWORD);
    const urls = [
      `postgresql://worker_role:${encodeURIComponent(WORKER_PASSWORD)}@${worker.host}:${worker.port}/${DB_NAME}`,
      `${dbUrl(DB_NAME)}${dbUrl(DB_NAME).includes("?") ? "&" : "?"}options=${encodeURIComponent("-c role=app_user")}`,
    ];
    try {
      for (const url of urls) {
        process.env.DATABASE_URL = url;
        let called = false;
        await expect(
          withClient(async () => {
            called = true;
          }),
        ).rejects.toThrow("refusing to serve");
        expect(called).toBe(false);
        await endPool();
      }
    } finally {
      await endPool();
      delete process.env.DATABASE_URL;
    }
  });

  it("refuses to serve through the web pool as a superuser", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    process.env.DATABASE_URL = dbUrl(DB_NAME);
    const { endPool, withClient } = await import("./pg");
    try {
      let called = false;
      await expect(
        withClient(async () => {
          called = true;
        }),
      ).rejects.toThrow("refusing to serve");
      expect(called).toBe(false);
    } finally {
      await endPool();
      delete process.env.DATABASE_URL;
    }
  });

  it("does not match a blank email after a sign-in on the same app_user connection", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });
    const blankCustomer = randomUUID();
    await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [blankCustomer]);
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, '', 'x', now())",
      [randomUUID(), blankCustomer],
    );

    const login = new Client(loginConfig("app_user", APP_PASSWORD));
    await login.connect();
    try {
      const app = clientAsQueryable(login);
      const owner = await registerOwner(app, { email: "owner@example.com", password: "sandi-panjang" });
      expect(await authenticateOwner(app, "owner@example.com", "sandi-panjang")).toEqual(owner);
      const setting = await login.query<{ value: string | null }>(
        "select current_setting('app.login_email', true) as value",
      );
      expect(setting.rows[0].value).toBe("");

      await login.query("begin");
      await login.query("select set_config('app.customer_id', '00000000-0000-0000-0000-000000000000', true)");
      const blank = await login.query("select id from users where email = ''");
      await login.query("commit");
      expect(blank.rows).toEqual([]);
    } finally {
      await login.end();
    }
  });
});
