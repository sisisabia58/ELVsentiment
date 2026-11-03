import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable } from "../db/migrate";
import { overviewScore } from "../domain/aggregates";
import { failedScoring, routeJudgment, type ScoringPolicy } from "../domain/routing";
import { createProject } from "../projects/handlers";
import { displayOf } from "../domain/display";
import { ingestMention } from "../ingest/mentions";
import { attentionDecision } from "../domain/attention";
import { recordFailure, recordSuccess, releaseToPending, releaseWorkerToPending, saveCorrection } from "./jobs";

const policy: ScoringPolicy = {
  approved: true,
  relevanceExcludeMax: 0.2,
  relevanceIncludeMin: 0.8,
  sentimentConfidenceMin: 0.75,
  topicNoulMin: 0.7,
  attentionNegativeConfidenceMin: 0.8,
  fallbackTopicId: null,
};

describe("scoring persistence", () => {
  it("dedupes variants, keeps the raw judgment, and applies a correction only to the display", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const first = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "x",
      externalId: "100",
      variant: "geprek gembus",
      excerpt: "geprek gembus enak",
      url: "https://x.com/ani/status/100",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    const second = await ingestMention(db, { ...{
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "x" as const,
      externalId: "100",
      variant: "ayam pak gembus",
      excerpt: "geprek gembus enak",
      url: "https://x.com/ani/status/100",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    } });
    expect(second.result).toBe("deduped");
    expect(second.id).toBe(first.id);
    const judgment = { relevanceNoul: 0.05, sentiment: "negative" as const, sentimentConfidence: 0.99, topicNouls: [] };
    await recordSuccess(db, owner.customerId, first.id, {
      provider: "typesafe",
      model: "jev-1.14.0",
      raw: judgment,
      judgment,
    });
    const excluded = displayOf(routeJudgment(judgment, policy), null);
    expect(excluded.bucket).toBe("excluded");
    expect(overviewScore({ positive: 0, negative: 0, neutral: 0 })).toEqual({ kind: "empty" });
    await saveCorrection(db, owner.customerId, first.id, {
      action: "correct",
      relevance: "relevant",
      sentiment: "positive",
      topics: [],
    });
    const shown = displayOf(routeJudgment(judgment, policy), {
      action: "correct",
      relevance: "relevant",
      sentiment: "positive",
      topics: [],
    });
    expect(shown.source).toBe("owner_correct");
    expect(overviewScore({ positive: 1, negative: 0, neutral: 0 }).kind).toBe("score");
    const raw = await db.query<{ relevance_noul: number }>("select relevance_noul from jev_results where mention_id = $1", [first.id]);
    expect(raw.rows[0].relevance_noul).toBe(0.05);
    expect(displayOf(failedScoring(), null)).toMatchObject({ bucket: "failed", sentiment: null, source: "failed" });
    expect(attentionDecision({ mentionId: first.id, route: routeJudgment(judgment, policy), sentimentConfidence: 0.99 }, policy).eligible).toBe(false);
  });

  it("marks a failed claim target as failed without a sentiment", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "dua@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "kedai");
    const mention = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "threads",
      externalId: "55",
      variant: "kedai",
      excerpt: "teks",
      url: "https://www.threads.com/@ani/post/55",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    await recordFailure(db, owner.customerId, mention.id);
    const row = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [mention.id]);
    expect(row.rows[0].scoring_status).toBe("failed");
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
  });

  it("returns a scoring mention to pending without a jev row", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "retry@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "kedai");
    const mention = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "threads",
      externalId: "56",
      variant: "kedai",
      excerpt: "coba lagi nanti",
      url: "https://www.threads.com/@ani/post/56",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    await db.query("update mentions set scoring_status = 'scoring' where id = $1", [mention.id]);

    await releaseToPending(db, owner.customerId, mention.id);

    const row = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(row.rows[0]?.scoring_status).toBe("pending");
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
  });

  it("returns a scoring mention to pending as the worker role without a jev row", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "worker-retry@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "kedai");
    const mention = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "threads",
      externalId: "57",
      variant: "kedai",
      excerpt: "coba lagi nanti",
      url: "https://www.threads.com/@ani/post/57",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    await db.query("update mentions set scoring_status = 'scoring' where id = $1", [mention.id]);

    await releaseWorkerToPending(db, owner.customerId, mention.id);

    const row = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [
      mention.id,
    ]);
    expect(row.rows[0]?.scoring_status).toBe("pending");
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
  });
});
