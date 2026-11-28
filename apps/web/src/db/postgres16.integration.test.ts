import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticateOwner, openSession, registerOwner } from "../auth/accounts";
import { runNowAction } from "../app/dasbor/actions";
import { saveVariantsAction } from "../app/onboarding/actions";
import { createProject, saveProjectConfiguration } from "../projects/handlers";
import { createInstantSearch } from "../monitor/search/mutations";
import { routeCariResult, undoCariRoute } from "../monitor/search/review-routing";
import { saveProviderSetting } from "../monitor/search/provider-settings";
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
function loginConfig(user: string, password: string, database: string = DB_NAME) {
  const { host, port } = parseAdminUrl();
  return {
    host: host || "127.0.0.1",
    port: Number(port || 5432),
    database,
    user,
    password,
  };
}

function loginUrl(database: string, user: string, password: string): string {
  const { host, port } = loginConfig(user, password, database);
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
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

  it("isolates manual routes and serializes competing first writes, retries, and stale undo", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    const customerId = randomUUID(), foreignId = randomUUID(), searchId = randomUUID();
    const local = clientAsQueryable(db);
    const peer = await connect(dbUrl(DB_NAME));
    const env = { CARI_SEKARANG_ENABLED: "1", PANTAU_FILTER_TRIAGE_ENABLED: "1" };
    try {
      await db.query("insert into customers (id,customer_id,created_at) values ($1,$1,now()),($2,$2,now())", [customerId,foreignId]);
      const projectId = (await createProject(local, customerId, "Tukuliling")).projectId;
      await saveProjectConfiguration(local, customerId, { projectId, brandName: "Tukuliling", variants: ["tukuliling"],
        sources: ["threads"], schedule: { mode: "off", intervalHours: 6 } }, undefined, { x: false, threads: true });
      await db.query("update projects set pantau_filter_triage=true where id=$1", [projectId]);
      await db.query(`insert into instant_searches (id,customer_id,query_text,keyword_intent,date_window,sort_mode,
        language_filter,status,finished_at,deadline_at,retention_expires_at,relevance_version)
        values ($1,$2,'tukuliling','phrase','all','relevance','all','succeeded',now(),now(),now()+interval '1 day',1)`, [searchId,customerId]);
      await db.query(`insert into instant_search_sources (search_id,customer_id,platform,provider,state)
        values ($1,$2,'threads','scrapecreators','answered')`, [searchId,customerId]);
      const connections = [local, clientAsQueryable(peer)].map((db) => ({ db, customerId, env }));
      for (const replay of [false,true]) {
        const resultId = randomUUID();
        await db.query(`insert into instant_search_results
          (id,search_id,customer_id,platform,external_id,text,relevance,source_provider,web_index,raw_ref,rank)
          values ($1,$2,$3,'threads',$4,'Tukuliling dingin','literal_match','scrapecreators',false,'fixture',1)`,
          [resultId, searchId, customerId, resultId]);
        const input = { searchId, resultId, projectId, requestId: randomUUID(), expectedRevision: null, destination: "attention" as const };
        const outcomes = await Promise.all(connections.map((ctx, index) => routeCariResult(ctx,
          { ...input, requestId: index && !replay ? randomUUID() : input.requestId })));
        const winner = outcomes.find((outcome) => outcome.ok && !outcome.replayed);
        if (!winner?.ok) throw new Error("no winning route");
        if (replay) expect(outcomes).toEqual(expect.arrayContaining([winner, { ...winner, replayed: true }]));
        else expect(outcomes).toContainEqual({ ok: false, error: "conflict" });
        const next = await routeCariResult(connections[0], { ...input, expectedRevision: winner.route.revision,
          destination: "ambiguous", requestId: randomUUID() });
        expect(next).toMatchObject({ ok: true, route: { destination: "ambiguous" } });
        const stale = { projectId, mentionId: winner.mentionId, revision: winner.route.revision! };
        expect(await undoCariRoute(connections[1], stale)).toEqual({ ok: false, error: "conflict" });
        expect(await undoCariRoute({ ...connections[0], customerId: foreignId }, stale)).toEqual({ ok: false, error: "not_found" });
        await withCustomer(local, foreignId, async () => {
          expect((await local.query("select mention_id from pantau_manual_routes where mention_id=$1", [winner.mentionId])).rows).toEqual([]);
          expect((await local.query("update pantau_manual_routes set destination='attention' where mention_id=$1 returning mention_id", [winner.mentionId])).rows).toEqual([]);
        });
      }
    } finally {
      await peer.end();
    }
  });

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
    const logPath =
      process.env.POSTGRES_TEST_LOG_PATH ?? "/var/log/postgresql/postgresql-16-main.log";
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

      const previousToken = process.env.SCRAPEATLAS_API_KEY;
      process.env.SCRAPEATLAS_API_KEY = "fixture-key";
      let run: Awaited<ReturnType<typeof runNowAction>>;
      try {
        const configured = await withClient((client) => saveProjectConfiguration(
          client, ownerA.customerId, {
            projectId: project.projectId,
            brandName: "ayam geprek pak gembus",
            variants: ["geprek gembus"],
            sources: ["x"],
            schedule: { mode: "off", intervalHours: 6 },
          }, undefined, { x: true, threads: false },
        ));
        expect(configured.ok).toBe(true);
        run = await withClient((client) =>
          runNowAction(project.projectId, { db: client, readSessionToken: async () => sessionA.token }),
        );
      } finally {
        if (previousToken === undefined) delete process.env.SCRAPEATLAS_API_KEY;
        else process.env.SCRAPEATLAS_API_KEY = previousToken;
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

  it("applies migration 012 with seeded routing and the admin-only write gate", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });

    const app = new Client(loginConfig("app_user", APP_PASSWORD));
    await app.connect();
    const worker = new Client(loginConfig("worker_role", WORKER_PASSWORD));
    await worker.connect();
    try {
      const seeded = await app.query<{ platform: string; provider: string }>(
        "select platform, provider from provider_settings order by platform",
      );
      expect(seeded.rows).toHaveLength(10);
      expect(seeded.rows.find((row) => row.platform === "youtube")?.provider).toBe("scrapeatlas");
      expect(seeded.rows.find((row) => row.platform === "comments")?.provider).toBe("scrapeatlas");

      const workerRows = await worker.query<{ n: number }>(
        "select count(*)::int as n from provider_settings",
      );
      expect(workerRows.rows[0].n).toBe(10);

      const denied = await app.query(
        "update provider_settings set provider = 'off' where platform = 'youtube'",
      );
      expect(denied.rowCount).toBe(0);
      await expect(
        app.query(
          "insert into provider_settings (platform, provider) values ('myspace', 'scrapeatlas')",
        ),
      ).rejects.toThrow();

      // The old app.is_admin GUC is no longer trusted: app_user can set it
      // itself, so it must not grant writes.
      await app.query("begin");
      await app.query("select set_config('app.is_admin', 'on', true)");
      const updated = await app.query(
        "update provider_settings set provider = 'off' where platform = 'youtube'",
      );
      expect(updated.rowCount).toBe(0);
      await expect(
        app.query(
          `insert into provider_settings_audit
             (id, platform, old_provider, new_provider, actor_email)
           values ($1, 'youtube', 'scrapeatlas', 'off', 'owner@example.com')`,
          [randomUUID()],
        ),
      ).rejects.toThrow();
      await app.query("rollback");

      expect(
        (
          await app.query<{ provider: string }>(
            "select provider from provider_settings where platform = 'youtube'",
          )
        ).rows[0].provider,
      ).toBe("scrapeatlas");
      expect(
        (await app.query<{ n: number }>("select count(*)::int as n from provider_settings_audit")).rows[0].n,
      ).toBe(0);
    } finally {
      await app.end();
      await worker.end();
    }
  });

  it("allows provider writes only for a platform-admin session", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });

    const customerId = randomUUID();
    const adminUserId = randomUUID();
    const plainUserId = randomUUID();
    const adminToken = "synthetic-admin-session-token";
    const plainToken = "synthetic-plain-session-token";
    const hash = (token: string) => createHash("sha256").update(token).digest("hex");
    await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [customerId]);
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'admin@example.com', 'hash', now() - interval '1 day')",
      [adminUserId, customerId],
    );
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'plain@example.com', 'hash', now())",
      [plainUserId, customerId],
    );
    await db.query(
      "insert into sessions (id, customer_id, user_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '1 day')",
      [randomUUID(), customerId, adminUserId, hash(adminToken)],
    );
    await db.query(
      "insert into sessions (id, customer_id, user_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '1 day')",
      [randomUUID(), customerId, plainUserId, hash(plainToken)],
    );
    await db.query("insert into platform_admins (user_id, note) values ($1, 'qa grant')", [adminUserId]);

    const app = new Client(loginConfig("app_user", APP_PASSWORD));
    await app.connect();
    const worker = new Client(loginConfig("worker_role", WORKER_PASSWORD));
    await worker.connect();
    try {
      await expect(
        app.query("insert into platform_admins (user_id) values ($1)", [plainUserId]),
      ).rejects.toThrow();
      await expect(app.query("update platform_admins set note = 'nope'")).rejects.toThrow();
      await expect(app.query("delete from platform_admins")).rejects.toThrow();
      await expect(worker.query("select count(*) from platform_admins")).rejects.toThrow();

      expect(
        (await app.query<{ n: number }>("select count(*)::int as n from platform_admins")).rows[0].n,
      ).toBe(0);

      await app.query("begin");
      await app.query("select set_config('app.is_admin', 'on', true)");
      const guc = await app.query(
        "update provider_settings set provider = 'off' where platform = 'youtube'",
      );
      expect(guc.rowCount).toBe(0);
      await app.query("rollback");

      await app.query("begin");
      await app.query("select set_config('app.session_token_hash', $1, true)", [hash(plainToken)]);
      const nonAdmin = await app.query(
        "update provider_settings set provider = 'off' where platform = 'youtube'",
      );
      expect(nonAdmin.rowCount).toBe(0);
      await app.query("rollback");

      await app.query("begin");
      await app.query("select set_config('app.session_token_hash', $1, true)", [hash(adminToken)]);
      expect(
        (
          await app.query<{ user_id: string }>("select user_id from platform_admins")
        ).rows,
      ).toEqual([{ user_id: adminUserId }]);
      const updated = await app.query(
        "update provider_settings set provider = 'off' where platform = 'youtube'",
      );
      expect(updated.rowCount).toBe(1);
      await app.query(
        `insert into provider_settings_audit
           (id, platform, old_provider, new_provider, actor_email)
         values ($1, 'youtube', 'scrapeatlas', 'off', 'admin@example.com')`,
        [randomUUID()],
      );
      await app.query("commit");

      expect(
        (await app.query<{ n: number }>("select count(*)::int as n from provider_settings_audit")).rows[0].n,
      ).toBe(0);
      expect(
        (
          await app.query<{ provider: string }>(
            "select provider from provider_settings where platform = 'youtube'",
          )
        ).rows[0].provider,
      ).toBe("off");
    } finally {
      await app.end();
      await worker.end();
    }
  });

  it("saves provider settings on a reused app_user connection after a tenant transaction", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });

    const customerId = randomUUID();
    const adminUserId = randomUUID();
    const adminToken = "synthetic-reused-connection-admin-token";
    const hash = (token: string) => createHash("sha256").update(token).digest("hex");
    await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [customerId]);
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'reused@example.com', 'hash', now())",
      [adminUserId, customerId],
    );
    await db.query(
      "insert into sessions (id, customer_id, user_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '1 day')",
      [randomUUID(), customerId, adminUserId, hash(adminToken)],
    );
    await db.query("insert into platform_admins (user_id, note) values ($1, 'qa grant')", [adminUserId]);

    // A pool client is reused across requests. An earlier request sets the
    // tenant GUC with is_local=true and commits; afterwards the GUC reads back
    // as '' on that same client, which used to make the sessions policy cast
    // ''::uuid error before the token policy could match.
    const app = new Client(loginConfig("app_user", APP_PASSWORD));
    await app.connect();
    try {
      await app.query("begin");
      await app.query("select set_config('app.customer_id', $1, true)", [customerId]);
      await app.query("commit");
      expect((await app.query<{ value: string }>("select current_setting('app.customer_id', true) as value")).rows[0].value).toBe("");

      const result = await saveProviderSetting(clientAsQueryable(app), {
        actorEmail: "reused@example.com",
        customerId,
        sessionTokenHash: hash(adminToken),
        platform: "youtube",
        provider: "off",
        fallbackProvider: null,
        fallbackOnFailure: false,
      });
      expect(result).toEqual({ ok: true });
      expect(
        (await db.query<{ provider: string }>("select provider from provider_settings where platform = 'youtube'"))
          .rows[0].provider,
      ).toBe("off");
      expect(
        (await db.query<{ n: number }>("select count(*)::int as n from provider_settings_audit")).rows[0].n,
      ).toBe(1);
    } finally {
      await app.end();
    }
  });

  it("applies migration 012 as a non-superuser owner and lets that owner grant platform admin", async () => {
    const OWNER_DB = "sm_owner_migrate";
    const OWNER = "sm_migration_owner";
    const OWNER_PASSWORD = "synthetic-migration-owner-password";
    const ownerAdmin = await connect(dbUrl(parseAdminUrl().database || "postgres"));
    try {
      await ownerAdmin.query(`drop database if exists ${OWNER_DB}`);
      await ownerAdmin.query(`drop role if exists ${OWNER}`);
      await ownerAdmin.query(
        `create role ${OWNER} login nosuperuser nobypassrls createrole password '${OWNER_PASSWORD}'`,
      );
      await ownerAdmin.query(`create database ${OWNER_DB} owner ${OWNER}`);

      const ownerUrl = loginUrl(OWNER_DB, OWNER, OWNER_PASSWORD);
      const files = readdirSync(SQL_DIR)
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const name of files) {
        execFileSync("psql", [ownerUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", path.join(SQL_DIR, name)], {
          stdio: "pipe",
        });
      }

      const customerId = randomUUID();
      const adminUserId = randomUUID();
      const plainUserId = randomUUID();
      const adminOnOwner = await connect(dbUrl(OWNER_DB));
      try {
        await adminOnOwner.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [
          customerId,
        ]);
        await adminOnOwner.query(
          "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'owner@example.com', 'hash', now())",
          [adminUserId, customerId],
        );
        await adminOnOwner.query(
          "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, 'plain@example.com', 'hash', now())",
          [plainUserId, customerId],
        );
      } finally {
        await adminOnOwner.end();
      }

      // The README's documented grant is run by the migration/table owner.
      const owner = new Client({ connectionString: ownerUrl });
      await owner.connect();
      try {
        const grant = await owner.query(
          "insert into platform_admins (user_id) select id from users where email = 'owner@example.com'",
        );
        expect(grant.rowCount).toBe(1);
        expect(
          (await owner.query<{ n: number }>("select count(*)::int as n from platform_admins")).rows[0].n,
        ).toBe(1);
      } finally {
        await owner.end();
      }

      await ownerAdmin.query(`alter role app_user login password '${APP_PASSWORD}'`);
      const app = new Client(loginConfig("app_user", APP_PASSWORD, OWNER_DB));
      await app.connect();
      try {
        await expect(
          app.query("insert into platform_admins (user_id) values ($1)", [plainUserId]),
        ).rejects.toThrow();
        await expect(app.query("update platform_admins set note = 'nope'")).rejects.toThrow();
        await expect(app.query("delete from platform_admins")).rejects.toThrow();

        await app.query("begin");
        await app.query("select set_config('app.is_admin', 'on', true)");
        const guc = await app.query(
          "update provider_settings set provider = 'off' where platform = 'youtube'",
        );
        expect(guc.rowCount).toBe(0);
        await app.query("rollback");
      } finally {
        await app.end();
      }
    } finally {
      await ownerAdmin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [OWNER_DB],
      );
      await ownerAdmin.query(`drop database if exists ${OWNER_DB}`);
      await ownerAdmin.query(`drop role if exists ${OWNER}`);
      await ownerAdmin.end();
    }
  });

  it("enforces the instant-search daily cap race-safely under the web pool", async () => {
    await migrate(db, { sqlDir: SQL_DIR });
    await enableRoleLogin(db, { appPassword: APP_PASSWORD, workerPassword: WORKER_PASSWORD });
    const login = loginConfig("app_user", APP_PASSWORD);
    process.env.DATABASE_URL = `postgresql://app_user:${encodeURIComponent(APP_PASSWORD)}@${login.host}:${login.port}/${DB_NAME}`;
    const { endPool, withClient } = await import("./pg");
    try {
      const owner = await withClient((client) =>
        registerOwner(client, { email: "cap@example.com", password: "sandi-panjang" }),
      );
      const input = {
        query: "barayam",
        intent: "phrase" as const,
        filters: { dateWindow: "7d" as const, sort: "relevance" as const, language: "all" as const },
      };
      const now = new Date("2026-11-16T10:00:00Z");
      const results = await Promise.all([
        withClient((client) => createInstantSearch(client, owner.customerId, input, now, { cariDailySearchLimit: 1 })),
        withClient((client) => createInstantSearch(client, owner.customerId, input, now, { cariDailySearchLimit: 1 })),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.error === "daily_limit")).toHaveLength(1);
      const count = await withClient((client) =>
        withCustomer(client, owner.customerId, () =>
          client.query<{ n: number }>("select count(*)::int as n from instant_searches"),
        ),
      );
      expect(count.rows[0].n).toBe(1);
      const sources = await withClient((client) =>
        withCustomer(client, owner.customerId, () =>
          client.query<{ platform: string }>("select platform from instant_search_sources order by platform"),
        ),
      );
      expect(sources.rows.map(({ platform }) => platform)).toEqual([
        "facebook", "instagram", "linkedin", "reddit", "threads", "tiktok", "x", "youtube",
      ]);
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
