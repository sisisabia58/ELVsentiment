import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer, type Queryable } from "../db/migrate";
import { TYPESAFE_MODEL } from "../jev/client";
import { readMonitorPolicy } from "../monitor/policy";
import * as monitorPolicy from "../monitor/policy";
import { createProject } from "../projects/handlers";
import { ingestMention } from "../ingest/mentions";
import { main } from "./cli";
import { scoreUnscoredMentions } from "./run";

type PostedBody = {
  model: string;
  state: { brand: string; text: string };
  questions: Record<string, unknown>;
};

type ScoreCall = Parameters<typeof scoreUnscoredMentions>[1];

const TOPIC_QUESTION_IDS = [
  "topic_harga",
  "topic_kemasan",
  "topic_kualitas",
  "topic_layanan",
  "topic_pengalaman",
  "topic_pengiriman",
  "topic_promo",
  "topic_stok",
];

function approvedPolicy() {
  const current = readMonitorPolicy();
  return { ...current, scoring: { ...current.scoring, approved: true } };
}

function systemOne(input: {
  relevance?: number;
  sentiment?: "positive" | "neutral" | "negative";
  confidence?: number;
  topics?: { id: string; noul: number }[];
} = {}) {
  const answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number }> = {
    relevant: { type: "noul", noul: input.relevance ?? 0.9 },
    sentiment: {
      type: "choice",
      choice: input.sentiment ?? "positive",
      confidence: input.confidence ?? 0.9,
    },
  };
  for (const topic of input.topics ?? []) {
    answers[`topic_${topic.id}`] = { type: "noul", noul: topic.noul };
  }
  return { model: TYPESAFE_MODEL, answers };
}

function deps(post: ScoreCall["post"], overrides: Partial<ScoreCall> = {}): ScoreCall {
  return {
    env: { TYPESAFE_API_KEY: "typesafe-test-key" },
    log: () => {},
    sleep: async () => {},
    random: () => 0,
    post,
    role: "worker",
    limit: 5,
    ...overrides,
  };
}

function traceSql(db: Queryable): { db: Queryable; sqls: string[] } {
  const sqls: string[] = [];
  return {
    sqls,
    db: {
      async query<T>(sql: string, params?: unknown[]) {
        sqls.push(sql);
        return db.query<T>(sql, params);
      },
      async exec(sql: string) {
        sqls.push(sql);
        return db.exec(sql);
      },
    },
  };
}

function setsRole(sqls: string[], role: string): boolean {
  return sqls.some((sql) => new RegExp(`set\\s+local\\s+role\\s+${role}\\b`, "i").test(sql));
}

async function freshDb(): Promise<Queryable> {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  return db;
}

async function seedOwner(db: Queryable, email: string, brand = "kedai") {
  const owner = await registerOwner(db, { email, password: "sandi-panjang" });
  const project = await createProject(db, owner.customerId, brand);
  return { owner, project };
}

async function seedMention(
  db: Queryable,
  customerId: string,
  projectId: string,
  input: { externalId: string; excerpt: string; collectedAt: string; variant?: string },
) {
  const mention = await ingestMention(db, {
    customerId,
    projectId,
    source: "threads",
    externalId: input.externalId,
    variant: input.variant ?? "kedai",
    excerpt: input.excerpt,
    url: `https://www.threads.com/@ani/post/${input.externalId}`,
    author: "ani",
    postedAt: "2026-11-01T00:00:00.000Z",
  });
  await db.query("update mentions set collected_at = $1 where id = $2", [input.collectedAt, mention.id]);
  return mention;
}

describe("scoreUnscoredMentions", () => {
  it("claims and scores each pending mention once, then claims nothing on the next pass", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "owner@example.com", "ayam geprek");
    const first = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "pertama",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const second = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "2",
      excerpt: "kedua",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    const traced = traceSql(db);
    let posts = 0;
    const post = vi.fn(async (body: unknown) => {
      if (posts === 0) {
        const rows = await db.query<{ id: string; scoring_status: string; in_tx: boolean }>(
          `select id, scoring_status, pg_current_xact_id_if_assigned() is not null as in_tx
           from mentions where id in ($1, $2)`,
          [first.id, second.id],
        );
        expect(rows.rows).toHaveLength(2);
        for (const row of rows.rows) {
          expect(row.scoring_status).toBe("scoring");
          expect(row.in_tx).toBe(false);
        }
        const posted = body as PostedBody;
        expect(posted.model).toBe(TYPESAFE_MODEL);
        expect(posted.state.brand).toBe("ayam geprek");
      }
      posts += 1;
      return systemOne();
    });

    const result = await scoreUnscoredMentions(traced.db, deps(post));

    expect(result.scored).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBeNull();
    expect(result.decisions.map((decision) => decision.mentionId).sort()).toEqual([first.id, second.id].sort());
    expect(post).toHaveBeenCalledTimes(2);
    expect(setsRole(traced.sqls, "worker_role")).toBe(true);
    expect(setsRole(traced.sqls, "app_user")).toBe(false);
    expect(traced.sqls.some((sql) => sql.includes("set_config('app.customer_id'"))).toBe(true);

    const again = await scoreUnscoredMentions(traced.db, deps(post));
    expect(again).toMatchObject({ scored: 0, failed: 0, skipped: null, decisions: [] });
    expect(post).toHaveBeenCalledTimes(2);
    const jev = await db.query("select mention_id from jev_results");
    expect(jev.rows).toHaveLength(2);
  });

  it("scores five of six pending mentions when the limit is 5 and leaves the latest pending", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "limit@example.com");
    const mentions = [];
    for (let index = 0; index < 6; index += 1) {
      mentions.push(
        await seedMention(db, owner.customerId, project.projectId, {
          externalId: String(index),
          excerpt: `teks-${index}`,
          collectedAt: `2026-11-01T00:0${index}:00.000Z`,
        }),
      );
    }
    let checked = false;
    const post = vi.fn(async () => {
      if (!checked) {
        checked = true;
        const rows = await db.query<{ scoring_status: string; in_tx: boolean }>(
          "select scoring_status, pg_current_xact_id_if_assigned() is not null as in_tx from mentions",
        );
        expect(rows.rows.filter((row) => row.scoring_status === "scoring")).toHaveLength(5);
        expect(rows.rows.filter((row) => row.scoring_status === "pending")).toHaveLength(1);
        expect(rows.rows[0]?.in_tx).toBe(false);
      }
      return systemOne();
    });

    const result = await scoreUnscoredMentions(db, deps(post, { limit: 5 }));

    expect(result.scored).toBe(5);
    expect(result.failed).toBe(0);
    expect(post).toHaveBeenCalledTimes(5);
    const pending = await db.query<{ id: string }>("select id from mentions where scoring_status = 'pending'");
    expect(pending.rows.map((row) => row.id)).toEqual([mentions[5].id]);
  });

  it("calls post once when the same external id was ingested twice", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "dedupe@example.com");
    const first = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "100",
      excerpt: "geprek gembus enak",
      collectedAt: "2026-11-01T00:00:00.000Z",
      variant: "geprek gembus",
    });
    const second = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "threads",
      externalId: "100",
      variant: "ayam pak gembus",
      excerpt: "geprek gembus enak",
      url: "https://www.threads.com/@ani/post/100",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(second).toEqual({ id: first.id, result: "deduped" });
    const post = vi.fn(async () => systemOne());

    await scoreUnscoredMentions(db, deps(post));

    expect(post).toHaveBeenCalledTimes(1);
    const mentions = await db.query("select id from mentions");
    expect(mentions.rows).toHaveLength(1);
  });

  it("does not claim or call post when TYPESAFE_API_KEY is missing or blank, and does not log a key", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "nokey@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "9",
      excerpt: "tetap pending",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const logs: string[] = [];
    const post = vi.fn();
    const secret = "sk-live-secret";

    const missing = await scoreUnscoredMentions(
      db,
      deps(post, { env: { SECRET_KEY: secret }, log: (message) => logs.push(message) }),
    );
    const blank = await scoreUnscoredMentions(
      db,
      deps(post, { env: { TYPESAFE_API_KEY: " \n\t ", SECRET_KEY: secret }, log: (message) => logs.push(message) }),
    );

    expect(missing).toEqual({ scored: 0, failed: 0, skipped: "missing_api_key", decisions: [] });
    expect(blank).toEqual({ scored: 0, failed: 0, skipped: "missing_api_key", decisions: [] });
    expect(logs).toEqual([
      "scoring skipped: TYPESAFE_API_KEY is not set",
      "scoring skipped: TYPESAFE_API_KEY is not set",
    ]);
    expect(logs.join("\n")).not.toContain(secret);
    expect(post).not.toHaveBeenCalled();
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("pending");
  });

  it("marks a 400 as failed without a jev row and still scores the next mention", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "bad@example.com");
    const bad = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "gagal",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const good = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "2",
      excerpt: "baik",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    const calls = new Map<string, number>();
    const post = vi.fn(async (body: unknown) => {
      const text = (body as PostedBody).state.text;
      calls.set(text, (calls.get(text) ?? 0) + 1);
      if (text === "gagal") throw { status: 400 };
      return systemOne();
    });

    const result = await scoreUnscoredMentions(db, deps(post));

    expect(calls.get("gagal")).toBe(1);
    expect(calls.get("baik")).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.scored).toBe(1);
    expect(result.decisions.map((decision) => decision.mentionId)).toEqual([good.id]);
    const statuses = await db.query<{ id: string; scoring_status: string }>("select id, scoring_status from mentions");
    expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.scoring_status]))).toEqual({
      [bad.id]: "failed",
      [good.id]: "succeeded",
    });
    const jev = await db.query<{ mention_id: string }>("select mention_id from jev_results");
    expect(jev.rows.map((row) => row.mention_id)).toEqual([good.id]);
  });

  it("scores the next mention when marking the first one failed throws", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "failwrite@example.com");
    const bad = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "gagal",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const good = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "2",
      excerpt: "baik",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    const apiKey = "sk-live-fail-write";
    const logs: string[] = [];
    const post = vi.fn(async (body: unknown) => {
      const text = (body as PostedBody).state.text;
      if (text === "gagal") throw { status: 400, message: `authorization: Bearer ${apiKey}` };
      return systemOne();
    });
    const guarded: Queryable = {
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.includes("scoring_status = $3") && params?.[0] === bad.id && params?.[2] === "failed") {
          throw new Error(`authorization: Bearer ${apiKey}`);
        }
        return db.query<T>(sql, params);
      },
      async exec(sql: string) {
        return db.exec(sql);
      },
    };

    const result = await scoreUnscoredMentions(
      guarded,
      deps(post, { env: { TYPESAFE_API_KEY: apiKey }, log: (message) => logs.push(message) }),
    );

    expect(result).toMatchObject({ scored: 1, failed: 0, skipped: null });
    expect(result.decisions.map((decision) => decision.mentionId)).toEqual([good.id]);
    expect(post).toHaveBeenCalledTimes(2);
    const statuses = await db.query<{ id: string; scoring_status: string }>("select id, scoring_status from mentions");
    expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.scoring_status]))).toEqual({
      [bad.id]: "scoring",
      [good.id]: "succeeded",
    });
    const jev = await db.query<{ mention_id: string }>("select mention_id from jev_results");
    expect(jev.rows.map((row) => row.mention_id)).toEqual([good.id]);
    const logged = logs.join("\n");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain(apiKey);
    expect(logged.toLowerCase()).not.toContain(`bearer ${apiKey}`);
  });

  it("returns a mention to pending after four 503 responses and does not log the api key", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "exhausted@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "server sibuk",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const apiKey = "sk-live-503-secret";
    const logs: string[] = [];
    const post = vi.fn(async (_body: unknown, key: string) => {
      throw { status: 503, message: `authorization: Bearer ${key}` };
    });

    const result = await scoreUnscoredMentions(
      db,
      deps(post, { env: { TYPESAFE_API_KEY: apiKey }, log: (message) => logs.push(message) }),
    );

    expect(post).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ scored: 0, failed: 0, skipped: null, decisions: [] });
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("pending");
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
    const logged = logs.join("\n");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain(apiKey);
    expect(logged.toLowerCase()).not.toContain(`bearer ${apiKey}`);
  });

  it("retries a 429 on the primary transport and does not call the fallback", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "retry@example.com");
    await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "coba lagi",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const post = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw { status: 429 };
      return systemOne();
    });

    const result = await scoreUnscoredMentions(db, deps(post, { sleep }));

    expect(post).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scored: 1, failed: 0, skipped: null });
    const stored = await db.query<{ provider: string }>("select provider from jev_results");
    expect(stored.rows).toEqual([{ provider: "typesafe" }]);
  });

  it("stores relevance 0.35 and reports it irrelevant without deleting the mention", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "exclude@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "bukan merek ini",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const post = vi.fn(async () => systemOne({ relevance: 0.35, sentiment: "negative", confidence: 0.99 }));

    const result = await scoreUnscoredMentions(db, deps(post, { policy: approvedPolicy() }));

    expect(result.decisions).toEqual([
      {
        mentionId: mention.id,
        bucket: "excluded",
        relevance: "irrelevant",
        topics: [],
        sentimentUncertain: false,
      },
    ]);
    const jev = await db.query<{ relevance_noul: number; sentiment: string }>(
      "select relevance_noul, sentiment from jev_results where mention_id = $1",
      [mention.id],
    );
    expect(jev.rows).toEqual([{ relevance_noul: 0.35, sentiment: "negative" }]);
    const still = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(still.rows).toEqual([{ scoring_status: "succeeded" }]);
  });

  it("marks sentiment confidence 0.69 on a relevant mention as not sure", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "sentiment@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "rasanya aneh",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const post = vi.fn(async () =>
      systemOne({
        relevance: 0.9,
        sentiment: "negative",
        confidence: 0.69,
        topics: [{ id: "harga", noul: 0.9 }],
      }),
    );

    const result = await scoreUnscoredMentions(db, deps(post, { policy: approvedPolicy() }));

    expect(result.decisions).toEqual([
      {
        mentionId: mention.id,
        bucket: "not_sure",
        relevance: "relevant",
        topics: [],
        sentimentUncertain: true,
      },
    ]);
  });

  it("routes topic noul 0.64 to lainnya and 0.65 to the topic, and does not ask topic_lainnya", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "topic@example.com", "kedai");
    const low = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "noul rendah",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const high = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "2",
      excerpt: "noul cukup",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    const post = vi.fn(async (body: unknown) => {
      const posted = body as PostedBody;
      expect(posted.model).toBe(TYPESAFE_MODEL);
      expect(posted.state.brand).toBe("kedai");
      expect(posted.questions.topic_lainnya).toBeUndefined();
      expect(Object.keys(posted.questions).filter((key) => key.startsWith("topic_")).sort()).toEqual(
        TOPIC_QUESTION_IDS,
      );
      const noul = posted.state.text === "noul rendah" ? 0.64 : 0.65;
      return systemOne({
        relevance: 0.9,
        sentiment: "positive",
        confidence: 0.9,
        topics: [{ id: "harga", noul }],
      });
    });

    const result = await scoreUnscoredMentions(db, deps(post, { policy: approvedPolicy() }));

    const byMention = Object.fromEntries(result.decisions.map((decision) => [decision.mentionId, decision]));
    expect(byMention[low.id]).toEqual({
      mentionId: low.id,
      bucket: "included",
      relevance: "relevant",
      topics: ["lainnya"],
      sentimentUncertain: false,
    });
    expect(byMention[high.id]).toEqual({
      mentionId: high.id,
      bucket: "included",
      relevance: "relevant",
      topics: ["harga"],
      sentimentUncertain: false,
    });
  });

  it("does not log an authorization header or the api key when post fails", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "secret@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "rahasia",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const apiKey = "sk-live-do-not-log";
    const logs: string[] = [];
    const post = vi.fn(async (body: unknown, key: string) => {
      expect(JSON.stringify(body).toLowerCase()).not.toContain("authorization");
      expect(JSON.stringify(body)).not.toContain(apiKey);
      throw new Error(`request failed authorization: Bearer ${key}`);
    });

    const result = await scoreUnscoredMentions(
      db,
      deps(post, { env: { TYPESAFE_API_KEY: apiKey }, log: (message) => logs.push(message) }),
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain(apiKey);
    expect(logs.join("\n").toLowerCase()).not.toContain(`bearer ${apiKey}`);
    expect(result).toMatchObject({ scored: 0, failed: 1, skipped: null, decisions: [] });
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("failed");
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
  });

  it("scores only the given customer on the web role and hides that row from the other customer", async () => {
    const db = await freshDb();
    const first = await seedOwner(db, "satu@example.com", "kedai satu");
    const second = await seedOwner(db, "dua@example.com", "kedai dua");
    const own = await seedMention(db, first.owner.customerId, first.project.projectId, {
      externalId: "1",
      excerpt: "milik satu",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const other = await seedMention(db, second.owner.customerId, second.project.projectId, {
      externalId: "2",
      excerpt: "milik dua",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    const traced = traceSql(db);
    const post = vi.fn(async (body: unknown) => {
      expect((body as PostedBody).state.text).toBe("milik satu");
      expect((body as PostedBody).state.brand).toBe("kedai satu");
      return systemOne();
    });

    const result = await scoreUnscoredMentions(
      traced.db,
      deps(post, { role: "web", customerId: first.owner.customerId }),
    );

    expect(result.scored).toBe(1);
    expect(result.decisions.map((decision) => decision.mentionId)).toEqual([own.id]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(setsRole(traced.sqls, "app_user")).toBe(true);
    expect(setsRole(traced.sqls, "worker_role")).toBe(false);
    expect(traced.sqls.some((sql) => sql.includes("set_config('app.customer_id'"))).toBe(true);

    const visible = await withCustomer(db, first.owner.customerId, () =>
      db.query<{ id: string; scoring_status: string }>("select id, scoring_status from mentions"),
    );
    expect(visible.rows).toEqual([{ id: own.id, scoring_status: "succeeded" }]);
    const hidden = await withCustomer(db, second.owner.customerId, () =>
      db.query<{ id: string; scoring_status: string }>("select id, scoring_status from mentions"),
    );
    expect(hidden.rows).toEqual([{ id: other.id, scoring_status: "pending" }]);
  });

  it("requires a customer id before the web role claims anything", async () => {
    const db = await freshDb();
    const post = vi.fn();
    await expect(scoreUnscoredMentions(db, deps(post, { role: "web" }))).rejects.toThrow("customer_required");
    expect(post).not.toHaveBeenCalled();
  });

  it("does not claim when reading the monitor policy throws", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "policy@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "belum diklaim",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const post = vi.fn();
    const spy = vi.spyOn(monitorPolicy, "readMonitorPolicy").mockImplementation(() => {
      throw new Error("policy_unreadable");
    });
    try {
      await expect(scoreUnscoredMentions(db, deps(post))).rejects.toThrow("policy_unreadable");
      expect(post).not.toHaveBeenCalled();
      const status = await db.query<{ scoring_status: string }>(
        "select scoring_status from mentions where id = $1",
        [mention.id],
      );
      expect(status.rows[0]?.scoring_status).toBe("pending");
    } finally {
      spy.mockRestore();
    }
  });

  it("scores a mention left in scoring after the lease expires", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "stale@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "tertinggal",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    await db.query(
      `update mentions
       set scoring_status = 'scoring',
           scoring_attempts = 1,
           scoring_claimed_at = clock_timestamp() - make_interval(secs => 240)
       where id = $1`,
      [mention.id],
    );
    const post = vi.fn(async () => systemOne());

    const result = await scoreUnscoredMentions(db, deps(post));

    expect(post).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scored: 1, failed: 0, skipped: null });
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("succeeded");
  });

  it("scores a scoring mention that has no claim timestamp", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "untimed@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "tanpa waktu",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    await db.query("update mentions set scoring_status = 'scoring', scoring_attempts = 0 where id = $1", [mention.id]);
    const post = vi.fn(async () => systemOne());

    const result = await scoreUnscoredMentions(db, deps(post));

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.scored).toBe(1);
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("succeeded");
  });

  it("does not score a mention whose scoring claim is still inside the lease", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "live@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "masih berjalan",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    await db.query(
      `update mentions
       set scoring_status = 'scoring',
           scoring_attempts = 1,
           scoring_claimed_at = clock_timestamp() - interval '30 seconds'
       where id = $1`,
      [mention.id],
    );
    const post = vi.fn(async () => systemOne());

    const result = await scoreUnscoredMentions(db, deps(post));

    expect(post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scored: 0, failed: 0, skipped: null, decisions: [] });
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("scoring");
  });

  it("marks a stale claim failed without calling Jev once three attempts are used", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "capped@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "habis jatah",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    await db.query(
      `update mentions
       set scoring_status = 'scoring',
           scoring_attempts = 3,
           scoring_claimed_at = clock_timestamp() - make_interval(secs => 240)
       where id = $1`,
      [mention.id],
    );
    const post = vi.fn(async () => systemOne());

    const result = await scoreUnscoredMentions(db, deps(post));

    expect(post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scored: 0, failed: 0, skipped: null, decisions: [] });
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("failed");
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
  });

  it("refreshes the claim before each request so an earlier call cannot expire the next mention", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "refresh@example.com");
    const first = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "pertama",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const second = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "2",
      excerpt: "kedua",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    const post = vi.fn(async (body: unknown) => {
      const text = (body as PostedBody).state.text;
      if (text === "pertama") {
        await db.query(
          `update mentions
           set scoring_claimed_at = clock_timestamp() - make_interval(secs => 240)
           where id = $1`,
          [second.id],
        );
      }
      if (text === "kedua") {
        const row = await db.query<{ fresh: boolean }>(
          `select scoring_claimed_at > clock_timestamp() - interval '1 minute' as fresh
           from mentions where id = $1`,
          [second.id],
        );
        expect(row.rows[0]?.fresh).toBe(true);
      }
      return systemOne();
    });

    const result = await scoreUnscoredMentions(db, deps(post));

    expect(result.scored).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
    const statuses = await db.query<{ id: string; scoring_status: string }>("select id, scoring_status from mentions");
    expect(Object.fromEntries(statuses.rows.map((row) => [row.id, row.scoring_status]))).toEqual({
      [first.id]: "succeeded",
      [second.id]: "succeeded",
    });
  });

  it("does not score a mention another worker claimed while this batch was in flight", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "stolen@example.com");
    await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "pertama",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const second = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "2",
      excerpt: "kedua",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    const post = vi.fn(async (body: unknown) => {
      const text = (body as PostedBody).state.text;
      if (text === "pertama") {
        await db.query(
          `update mentions
           set scoring_attempts = scoring_attempts + 1,
               scoring_claimed_at = clock_timestamp()
           where id = $1`,
          [second.id],
        );
      }
      expect(text).not.toBe("kedua");
      return systemOne();
    });

    const result = await scoreUnscoredMentions(db, deps(post));

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.scored).toBe(1);
    expect(result.decisions.map((decision) => decision.mentionId)).not.toContain(second.id);
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      second.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("scoring");
  });

  it("retries a dropped connection on later runs and stops after three claims", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "network@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "putus",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const post = vi.fn(async () => {
      throw { network: true };
    });

    for (let run = 1; run <= 3; run += 1) {
      const result = await scoreUnscoredMentions(db, deps(post));
      const status = await db.query<{ scoring_status: string; scoring_attempts: number }>(
        "select scoring_status, scoring_attempts from mentions where id = $1",
        [mention.id],
      );
      expect(post).toHaveBeenCalledTimes(run);
      expect(status.rows[0]?.scoring_attempts).toBe(run);
      if (run < 3) {
        expect(result).toMatchObject({ scored: 0, failed: 0, skipped: null, decisions: [] });
        expect(status.rows[0]?.scoring_status).toBe("pending");
      } else {
        expect(result).toMatchObject({ scored: 0, failed: 1, skipped: null, decisions: [] });
        expect(status.rows[0]?.scoring_status).toBe("failed");
      }
    }

    const again = await scoreUnscoredMentions(db, deps(post));
    expect(again).toMatchObject({ scored: 0, failed: 0, skipped: null, decisions: [] });
    expect(post).toHaveBeenCalledTimes(3);
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
  });

  it("does not score a 400 again on the next run", async () => {
    const db = await freshDb();
    const { owner, project } = await seedOwner(db, "terminal@example.com");
    const mention = await seedMention(db, owner.customerId, project.projectId, {
      externalId: "1",
      excerpt: "tolak",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const post = vi.fn(async () => {
      throw { status: 400 };
    });

    const first = await scoreUnscoredMentions(db, deps(post));
    const second = await scoreUnscoredMentions(db, deps(post));

    expect(first).toMatchObject({ scored: 0, failed: 1, skipped: null });
    expect(second).toMatchObject({ scored: 0, failed: 0, skipped: null, decisions: [] });
    expect(post).toHaveBeenCalledTimes(1);
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("failed");
  });

  it("does not reclaim another customer's stale scoring row on the web role", async () => {
    const db = await freshDb();
    const first = await seedOwner(db, "web-a@example.com", "kedai a");
    const second = await seedOwner(db, "web-b@example.com", "kedai b");
    const stale = await seedMention(db, first.owner.customerId, first.project.projectId, {
      externalId: "1",
      excerpt: "milik a",
      collectedAt: "2026-11-01T00:00:00.000Z",
    });
    const own = await seedMention(db, second.owner.customerId, second.project.projectId, {
      externalId: "2",
      excerpt: "milik b",
      collectedAt: "2026-11-01T00:01:00.000Z",
    });
    await db.query(
      `update mentions
       set scoring_status = 'scoring',
           scoring_attempts = 1,
           scoring_claimed_at = clock_timestamp() - make_interval(secs => 240)
       where id = $1`,
      [stale.id],
    );
    const post = vi.fn(async (body: unknown) => {
      expect((body as PostedBody).state.text).toBe("milik b");
      return systemOne();
    });

    const result = await scoreUnscoredMentions(db, deps(post, { role: "web", customerId: second.owner.customerId }));

    expect(result.scored).toBe(1);
    expect(result.decisions.map((decision) => decision.mentionId)).toEqual([own.id]);
    expect(post).toHaveBeenCalledTimes(1);
    const status = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      stale.id,
    ]);
    expect(status.rows[0]?.scoring_status).toBe("scoring");
  });
});

describe("scoring cli", () => {
  it("does not connect when imported, and exits 0 when WORKER_DATABASE_URL is missing", async () => {
    const logs: string[] = [];
    const connect = vi.fn();
    const code = await main({
      env: { TYPESAFE_API_KEY: "sk-live-do-not-log" },
      log: (message) => logs.push(message),
      connect,
    });
    expect(code).toBe(0);
    expect(logs).toEqual(["scoring skipped: WORKER_DATABASE_URL is not set"]);
    expect(logs.join("\n")).not.toContain("sk-live-do-not-log");
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not connect when TYPESAFE_API_KEY is missing", async () => {
    const logs: string[] = [];
    const connect = vi.fn(async () => ({
      async query() {
        return { rows: [] };
      },
      async exec() {},
      async end() {},
    }));
    const code = await main({
      env: { WORKER_DATABASE_URL: "postgresql://worker@/sentiment" },
      log: (message) => logs.push(message),
      connect,
    });
    expect(code).toBe(0);
    expect(logs).toEqual(["scoring skipped: TYPESAFE_API_KEY is not set"]);
    expect(connect).not.toHaveBeenCalled();

    logs.length = 0;
    const blank = await main({
      env: { WORKER_DATABASE_URL: "postgresql://worker@/sentiment", TYPESAFE_API_KEY: "   " },
      log: (message) => logs.push(message),
      connect,
    });
    expect(blank).toBe(0);
    expect(logs).toEqual(["scoring skipped: TYPESAFE_API_KEY is not set"]);
    expect(connect).not.toHaveBeenCalled();
  });
});
