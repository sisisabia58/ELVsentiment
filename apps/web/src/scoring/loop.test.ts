import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, type Queryable } from "../db/migrate";
import { TYPESAFE_MODEL } from "../jev/client";
import { ingestMention } from "../ingest/mentions";
import { createProject } from "../projects/handlers";
import { interruptibleSleep, noteStopSignal, runScoreLoop, scoreIntervalMs, type CliConnection } from "./cli";

const KEY = "sk-live-do-not-log";

function systemOne() {
  return {
    model: TYPESAFE_MODEL,
    answers: {
      relevant: { type: "noul", noul: 0.9 },
      sentiment: { type: "choice", choice: "positive", confidence: 0.9 },
    },
  };
}

async function freshDb(): Promise<Queryable> {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  return db;
}

function connectTo(db: Queryable): (url: string) => Promise<CliConnection> {
  return async () => ({
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    async end() {},
  });
}

async function seedPending(db: Queryable, count: number) {
  const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
  const project = await createProject(db, owner.customerId, "kedai");
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const mention = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "threads",
      externalId: String(index + 1),
      variant: "kedai",
      excerpt: `mention ${index + 1}`,
      url: `https://www.threads.com/@ani/post/${index + 1}`,
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    ids.push(mention.id);
    await db.query("update mentions set collected_at = $1 where id = $2", [
      new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
      mention.id,
    ]);
  }
  return ids;
}

async function statuses(db: Queryable) {
  const rows = await db.query<{ scoring_status: string; count: number }>(
    "select scoring_status, count(*)::int as count from mentions group by scoring_status order by scoring_status",
  );
  return rows.rows;
}

describe("scoreIntervalMs", () => {
  it("defaults to 20 seconds and falls back when the value is unsafe", () => {
    expect(scoreIntervalMs({})).toBe(20_000);
    expect(scoreIntervalMs({ SCORE_INTERVAL_SECONDS: "30" })).toBe(30_000);
    expect(scoreIntervalMs({ SCORE_INTERVAL_SECONDS: "0" })).toBe(20_000);
    expect(scoreIntervalMs({ SCORE_INTERVAL_SECONDS: "nope" })).toBe(20_000);
    expect(scoreIntervalMs({ SCORE_INTERVAL_SECONDS: "   " })).toBe(20_000);
  });
});

describe("runScoreLoop", () => {
  it("skips once and does not connect when the database url or key is missing", async () => {
    const logs: string[] = [];
    const connect = vi.fn();
    const log = (message: string) => logs.push(message);

    const missingUrl = await runScoreLoop({
      env: { TYPESAFE_API_KEY: KEY },
      log,
      connect,
    });
    const missingKey = await runScoreLoop({
      env: { WORKER_DATABASE_URL: "postgresql://worker@/sentiment" },
      log,
      connect,
    });

    expect(missingUrl).toBe(0);
    expect(missingKey).toBe(0);
    expect(logs).toEqual([
      "scoring skipped: WORKER_DATABASE_URL is not set",
      "scoring skipped: TYPESAFE_API_KEY is not set",
    ]);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(connect).not.toHaveBeenCalled();
  });

  it("drains pending mentions with a mocked Jev call, then sleeps", async () => {
    const db = await freshDb();
    await seedPending(db, 2);
    const post = vi.fn(async () => systemOne());
    const sleeps: number[] = [];
    const controller = new AbortController();
    const logs: string[] = [];

    const code = await runScoreLoop({
      env: {
        WORKER_DATABASE_URL: "postgresql://worker@/sentiment",
        TYPESAFE_API_KEY: KEY,
        SCORE_INTERVAL_SECONDS: "15",
      },
      log: (message) => logs.push(message),
      connect: connectTo(db),
      post,
      limit: 1,
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        controller.abort();
      },
    });

    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([15_000]);
    expect(await statuses(db)).toEqual([{ scoring_status: "succeeded", count: 2 }]);
    const stored = await db.query<{ provider: string; model: string }>("select provider, model from jev_results");
    expect(stored.rows).toEqual([
      { provider: "typesafe", model: TYPESAFE_MODEL },
      { provider: "typesafe", model: TYPESAFE_MODEL },
    ]);
    expect(logs.join("\n")).not.toContain(KEY);
    expect(logs.join("\n")).not.toContain("openrouter");
  });

  it("finishes the in-flight batch on stop and does not claim the rest", async () => {
    const db = await freshDb();
    const ids = await seedPending(db, 2);
    const controller = new AbortController();
    const post = vi.fn(async () => {
      controller.abort();
      return systemOne();
    });
    const sleep = vi.fn(async () => {
      throw new Error("sleep after stop");
    });

    const code = await runScoreLoop({
      env: { WORKER_DATABASE_URL: "postgresql://worker@/sentiment", TYPESAFE_API_KEY: KEY },
      log: () => {},
      connect: connectTo(db),
      post,
      limit: 1,
      signal: controller.signal,
      sleep,
    });

    expect(code).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    const rows = await db.query<{ id: string; scoring_status: string }>(
      "select id, scoring_status from mentions order by collected_at",
    );
    expect(rows.rows).toEqual([
      { id: ids[0], scoring_status: "succeeded" },
      { id: ids[1], scoring_status: "pending" },
    ]);
  });

  it("closes the connection and sleeps the score interval when a batch throws", async () => {
    const secretUrl = "postgresql://worker:secret-do-not-log@127.0.0.1:1/sentiment";
    const sleeps: number[] = [];
    const logs: string[] = [];
    let ended = 0;
    let attempts = 0;
    const controller = new AbortController();

    const code = await runScoreLoop({
      env: {
        WORKER_DATABASE_URL: secretUrl,
        TYPESAFE_API_KEY: KEY,
        SCORE_INTERVAL_SECONDS: "15",
      },
      log: (message) => logs.push(message),
      connect: async () => {
        attempts += 1;
        return {
          async query() {
            throw new Error(`database unavailable ${secretUrl} key ${KEY}`);
          },
          async exec() {
            throw new Error(`database unavailable ${secretUrl} key ${KEY}`);
          },
          async end() {
            ended += 1;
          },
        };
      },
      signal: controller.signal,
      sleep: async (ms) => {
        sleeps.push(ms);
        controller.abort();
      },
    });

    expect(code).toBe(0);
    expect(attempts).toBe(1);
    expect(ended).toBe(1);
    expect(sleeps).toEqual([15_000]);
    expect(logs).toEqual(["scoring batch failed: database unavailable [redacted] key [redacted]"]);
    expect(logs.join("\n")).not.toContain("secret-do-not-log");
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("returns 0 without sleeping when a batch throws after stop", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      throw new Error("sleep after stop");
    });

    const code = await runScoreLoop({
      env: { WORKER_DATABASE_URL: "postgresql://worker@/sentiment", TYPESAFE_API_KEY: KEY },
      log: () => {},
      connect: async () => {
        controller.abort();
        throw new Error("database unavailable");
      },
      signal: controller.signal,
      sleep,
    });

    expect(code).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("interruptibleSleep", () => {
  it("returns before the full delay when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = interruptibleSleep(30_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("noteStopSignal", () => {
  it("aborts on the first signal and exits only on the second", () => {
    const exits: number[] = [];
    let aborted = 0;
    const state = {
      stops: 0,
      abort: () => {
        aborted += 1;
      },
      exit: (code: number) => exits.push(code),
    };
    noteStopSignal(state);
    expect(aborted).toBe(1);
    expect(exits).toEqual([]);
    noteStopSignal(state);
    expect(aborted).toBe(2);
    expect(exits).toEqual([1]);
    expect(state.stops).toBe(2);
  });
});
