import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { TYPESAFE_MODEL } from "../jev/client";
import { scoreUnscoredMentions } from "../scoring/run";
import { type Queryable } from "./migrate";
import { migrate } from "./production-migrate.mjs";

const ADMIN_URL = process.env.POSTGRES_TEST_URL ?? "";
const DB_NAME = "sm_scoring_claim";
// Same key as postgres16.integration.test.ts. Held on the admin connection for the
// whole file so parallel Vitest runs cannot drop app_user and worker_role together.
const SHARED_ROLE_ADVISORY_LOCK = [814158, 648] as const;
const SQL_DIR = path.join(import.meta.dirname, "sql");

// WHATWG URL rejects libpq's host-less socket form (postgresql://user@/db).
function parseAdminUrl() {
  const match = /^(postgres(?:ql)?:\/\/)(?:([^@/?]*)@)?([^/?]*)(?:\/([^?]*))?(?:\?(.*))?$/.exec(ADMIN_URL);
  if (!match) throw new Error("POSTGRES_TEST_URL is not a postgres URL");
  const [, scheme, userinfo = "", hostport, database = "", query = ""] = match;
  const [host] = hostport.split(":");
  return { scheme, userinfo, hostport, host, database, query: new URLSearchParams(query) };
}

function dbUrl(dbname: string): string {
  const { scheme, userinfo, hostport, host, query } = parseAdminUrl();
  if (!host && !query.has("host")) query.set("host", process.env.PGHOST ?? "/var/run/postgresql");
  const search = query.toString();
  return `${scheme}${userinfo ? `${userinfo}@` : ""}${hostport}/${dbname}${search ? `?${search}` : ""}`;
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function reset(admin: Client): Promise<void> {
  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [DB_NAME],
  );
  await admin.query(`drop database if exists ${DB_NAME}`);
  await admin.query("drop role if exists app_user");
  await admin.query("drop role if exists worker_role");
}

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

describe.skipIf(!ADMIN_URL)("worker claims do not score the same mention twice", { timeout: 60_000 }, () => {
  let admin: Client | undefined;
  let rolesLocked = false;

  beforeAll(async () => {
    admin = await connect(dbUrl(parseAdminUrl().database || "postgres"));
    await admin.query("select pg_advisory_lock($1, $2)", [...SHARED_ROLE_ADVISORY_LOCK]);
    rolesLocked = true;
    const version = await admin.query<{ server_version_num: string }>("show server_version_num");
    const major = Math.floor(Number(version.rows[0].server_version_num) / 10000);
    if (major !== 16) throw new Error(`need Postgres 16, connected to ${version.rows[0].server_version_num}`);
    await reset(admin);
  }, 180_000);

  afterAll(async () => {
    if (!admin) return;
    try {
      if (rolesLocked) await reset(admin);
    } finally {
      if (rolesLocked) {
        await admin.query("select pg_advisory_unlock($1, $2)", [...SHARED_ROLE_ADVISORY_LOCK]);
        rolesLocked = false;
      }
      await admin.end();
    }
  }, 180_000);

  it("splits five pending rows across two worker connections without scoring any id twice", async () => {
    if (!admin) throw new Error("admin connection missing");
    await reset(admin);
    await admin.query(`create database ${DB_NAME}`);
    const leftClient = await connect(dbUrl(DB_NAME));
    const rightClient = await connect(dbUrl(DB_NAME));
    try {
      await migrate(leftClient, { sqlDir: SQL_DIR });
      await leftClient.query("set statement_timeout = '15s'");
      await leftClient.query("set lock_timeout = '5s'");
      await rightClient.query("set statement_timeout = '15s'");
      await rightClient.query("set lock_timeout = '5s'");

      const customerId = randomUUID();
      const projectId = randomUUID();
      const mentionIds: string[] = [];
      await leftClient.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [
        customerId,
      ]);
      await leftClient.query(
        "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, $3, now())",
        [projectId, customerId, "kedai"],
      );
      for (let index = 0; index < 5; index += 1) {
        const id = randomUUID();
        mentionIds.push(id);
        await leftClient.query(
          `insert into mentions (
             id, customer_id, project_id, source, external_id, excerpt, url, author,
             posted_at, collected_at, matched_variants, scoring_status
           ) values (
             $1, $2, $3, 'threads', $4, $5, null, null,
             '2026-11-01T00:00:00.000Z', $6, $7, 'pending'
           )`,
          [id, customerId, projectId, String(index), `excerpt-${index}`, `2026-11-01T00:00:0${index}.000Z`, ["kedai"]],
        );
      }

      const left = clientAsQueryable(leftClient);
      const right = clientAsQueryable(rightClient);
      const scoreDeps = (texts: string[]) => ({
        env: { TYPESAFE_API_KEY: "typesafe-test-key" },
        log: () => {},
        sleep: async () => {},
        random: () => 0,
        limit: 5,
        role: "worker" as const,
        post: async (body: unknown) => {
          const text = (body as { state?: { text?: string } }).state?.text ?? "";
          texts.push(text);
          return {
            model: TYPESAFE_MODEL,
            answers: {
              relevant: { type: "noul", noul: 0.9 },
              sentiment: { type: "choice", choice: "positive", confidence: 0.9 },
            },
          };
        },
      });
      const leftTexts: string[] = [];
      const rightTexts: string[] = [];
      const [leftResult, rightResult] = await Promise.all([
        scoreUnscoredMentions(left, scoreDeps(leftTexts)),
        scoreUnscoredMentions(right, scoreDeps(rightTexts)),
      ]);

      const leftIds = leftResult.decisions.map((decision) => decision.mentionId);
      const rightIds = rightResult.decisions.map((decision) => decision.mentionId);
      expect(leftIds.filter((id) => rightIds.includes(id))).toEqual([]);
      expect(new Set([...leftIds, ...rightIds])).toEqual(new Set(mentionIds));
      expect(leftResult.scored + rightResult.scored).toBe(5);
      expect(leftResult.failed + rightResult.failed).toBe(0);
      expect(new Set([...leftTexts, ...rightTexts]).size).toBe(5);

      const statuses = await leftClient.query<{ scoring_status: string }>("select scoring_status from mentions");
      expect(statuses.rows.map((row) => row.scoring_status).sort()).toEqual([
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
        "succeeded",
      ]);
      const jev = await leftClient.query<{ mention_id: string }>("select mention_id from jev_results");
      expect(new Set(jev.rows.map((row) => row.mention_id))).toEqual(new Set(mentionIds));
      expect(jev.rows).toHaveLength(5);
    } finally {
      await leftClient.end();
      await rightClient.end();
    }
  });
});
