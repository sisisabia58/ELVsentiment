import { randomUUID } from "node:crypto";
import { saveMentionReview } from "./mutations";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner, saveDisplayName } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import type { ScoringPolicy } from "../domain/routing";
import { createProject } from "../projects/handlers";
import { readLimits, saveSchedule } from "../projects/schedules";
import { buildDashboard } from "./dashboard";
import { cooldownClock, describeChange } from "./format";
import { dashboardFor, jobPresentation, loadWorkspace } from "./load";
import { presentMention, type StoredMention } from "./present";
import { jakartaDate, rangeWindow } from "./range";
import { choiceLabel, nextDailyInstant, toPersist } from "./schedule-choice";

const approved: ScoringPolicy = {
  approved: true,
  relevanceExcludeMax: 0.2,
  relevanceIncludeMin: 0.8,
  sentimentConfidenceMin: 0.75,
  topicNoulMin: 0.7,
  attentionNegativeConfidenceMin: 0.8,
  fallbackTopicId: null,
};

function stored(overrides: Partial<StoredMention> = {}): StoredMention {
  return {
    id: "m1",
    source: "x",
    excerpt: "geprek gembus enak",
    url: "https://x.com/ani/status/1",
    author: "ani",
    postedAt: "2026-11-01T00:00:00.000Z",
    collectedAt: "2026-11-01T00:05:00.000Z",
    scoringStatus: "succeeded",
    sourcePostUnavailable: false,
    readAt: null,
    relevanceNoul: 0.95,
    sentiment: "positive",
    sentimentConfidence: 0.9,
    topicNouls: [{ id: "harga", noul: 0.9 }],
    correction: null,
    correctionAt: null,
    attentionId: null,
    attentionUnread: false,
    ...overrides,
  };
}

describe("monitor formatting and ranges", () => {
  it("uses Jakarta civil days and a 15-minute cooldown clock", () => {
    const now = new Date("2026-11-01T00:00:00.000Z");
    expect(jakartaDate(now)).toBe("2026-11-01");
    const window = rangeWindow("7", now);
    expect(window.days).toHaveLength(7);
    expect(window.days[0]).toBe("2026-10-26");
    expect(window.days[6]).toBe("2026-11-01");
    expect(cooldownClock(new Date(now.getTime() + 14 * 60 * 1000 + 5000).toISOString(), now)).toBe("14:05");
  });

  it("labels a drop in attention as lebih sedikit and keeps it the better direction", () => {
    expect(describeChange(-3, false)).toEqual({ tone: "good", direction: "lebih sedikit" });
    expect(describeChange(2, false)).toEqual({ tone: "bad", direction: "lebih banyak" });
    expect(describeChange(null, false)).toEqual({ tone: "none", direction: null });
  });

  it("stores a daily WIB clock separately from a 24-hour interval", () => {
    const now = new Date("2026-11-01T00:00:00.000Z");
    expect(nextDailyInstant(8 * 60, now).toISOString()).toBe("2026-11-01T01:00:00.000Z");
    expect(nextDailyInstant(6 * 60, now).toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(toPersist({ mode: "daily", minute: 8 * 60 })).toEqual({
      enabled: true,
      intervalHours: 24,
      cadence: "daily",
      dailyMinute: 480,
    });
    expect(choiceLabel({ mode: "off", intervalHours: 6 })).toBe("Nonaktif");
    expect(choiceLabel({ mode: "interval", hours: 12 })).toBe("Setiap 12 jam");
  });
});

describe("presented mentions", () => {
  it("keeps a failed score out of neutral and lets an owner correction win", () => {
    const failed = presentMention(stored({ scoringStatus: "failed", sentiment: "neutral", relevanceNoul: null }), approved);
    expect(failed.bucket).toBe("failed");
    expect(failed.sentiment).toBeNull();
    const corrected = presentMention(
      stored({
        sentiment: "negative",
        correction: { action: "correct", relevance: "relevant", sentiment: "positive", topics: ["harga"] },
        correctionAt: "2026-11-01T02:00:00.000Z",
      }),
      approved,
    );
    expect(corrected.bucket).toBe("included");
    expect(corrected.sentiment).toBe("positive");
    expect(corrected.corrected).toBe(true);
    expect(corrected.needsAttention).toBe(false);
  });

  it("does not invent attention when the policy is unapproved", () => {
    const shown = presentMention(stored({ sentiment: "negative", sentimentConfidence: 0.99 }), {
      ...approved,
      approved: false,
    });
    expect(shown.bucket).toBe("policy_unapproved");
    expect(shown.sentiment).toBeNull();
    expect(shown.needsAttention).toBe(false);
  });

  it("marks an owner-confirmed negative mention as attention even before a policy exists", () => {
    const shown = presentMention(
      stored({
        correction: { action: "confirm", relevance: "relevant", sentiment: "negative", topics: [] },
        correctionAt: "2026-11-01T02:00:00.000Z",
        attentionId: null,
      }),
      { ...approved, approved: false },
    );
    expect(shown.needsAttention).toBe(true);
    expect(shown.attentionUnread).toBe(true);
    expect(shown.sentiment).toBe("negative");
  });
});

describe("dashboard model", () => {
  it("renders an empty score instead of zero when nothing is included", () => {
    const model = buildDashboard({
      mentions: [],
      range: "7",
      source: "all",
      now: new Date("2026-11-01T00:00:00.000Z"),
      attentionUnread: 0,
      uncertainOpen: 0,
      partial: true,
    });
    expect(model.score).toEqual({ kind: "empty" });
    expect(model.comparison.score).toBeNull();
    expect(model.points.every((point) => point.total === null)).toBe(true);
  });
});

describe("workspace loader", () => {
  it("reads this tenant's corrected mention and hides the other tenant", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, {
      email: "rina@pakgembus.id",
      password: "sandi-panjang",
      displayName: "Rina Wulandari",
    });
    const other = await registerOwner(db, { email: "other@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const mentionId = randomUUID();
    await withCustomer(db, owner.customerId, async () => {
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'x', 'ext-1', 'geprek gembus enak', 'https://x.com/ani/status/1', 'ani', '2026-11-01T00:00:00.000Z', '2026-11-01T00:05:00.000Z', array['geprek gembus'], 'succeeded')`,
        [mentionId, owner.customerId, project.projectId],
      );
      await db.query(
        `insert into jev_results (mention_id, customer_id, provider, model, raw_response, relevance_noul, sentiment, sentiment_confidence, topic_nouls, created_at)
         values ($1, $2, 'typesafe', 'jev', '{}', 0.95, 'positive', 0.9, '[]', now())`,
        [mentionId, owner.customerId],
      );
      await db.query(
        `insert into owner_corrections (mention_id, customer_id, action, relevance, sentiment, topics, created_at)
         values ($1, $2, 'confirm', 'relevant', 'positive', array[]::text[], now())`,
        [mentionId, owner.customerId],
      );
    });
    const now = new Date("2026-11-01T03:00:00.000Z");
    const workspace = await loadWorkspace(db, owner.customerId, project.projectId, now, readLimits());
    expect(workspace.displayName).toBe("Rina Wulandari");
    expect(workspace.mentions).toHaveLength(1);
    expect(workspace.mentions[0]?.sentiment).toBe("positive");
    expect(workspace.sources.map((source) => source.state)).toEqual(["unavailable", "unavailable"]);
    const dashboard = dashboardFor(workspace, "7", "all", now);
    expect(dashboard.score.kind).toBe("score");
    if (dashboard.score.kind === "score") expect(Math.round(dashboard.score.value)).toBe(100);
    const hidden = await loadWorkspace(db, other.customerId, project.projectId, now, readLimits());
    expect(hidden.project).toBeNull();
    expect(hidden.projectMissing).toBe(true);
    expect(hidden.mentions).toEqual([]);
    const missing = await loadWorkspace(db, owner.customerId, randomUUID(), now, readLimits());
    expect(missing.project).toBeNull();
    expect(missing.projectMissing).toBe(true);
    expect(missing.projects).toHaveLength(1);
    expect(missing.mentions).toEqual([]);
  });

  it("saves a daily schedule and labels a skipped overlap", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "rina@pakgembus.id", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const saved = await saveSchedule(
      db,
      owner.customerId,
      project.projectId,
      { enabled: true, intervalHours: 24, cadence: "daily", dailyMinute: 8 * 60, now: new Date("2026-11-01T00:00:00.000Z") },
      readLimits(),
    );
    expect(saved).toEqual({ ok: true, nextRunAt: "2026-11-01T01:00:00.000Z" });
    const row = await withCustomer(db, owner.customerId, () =>
      db.query<{ cadence: string; daily_minute: number }>(
        "select cadence, daily_minute from project_schedules where project_id = $1",
        [project.projectId],
      ),
    );
    expect(row.rows[0]).toEqual({ cadence: "daily", daily_minute: 480 });
    expect(jobPresentation("deferred", "skipped_overlap").label).toBe("Dilewati");
    expect(jobPresentation("queued", null).label).toBe("Antri");
  });

  it("does not invent an attention change or a post time", () => {
    const now = new Date("2026-11-01T03:00:00.000Z");
    const mention = presentMention(
      stored({
        sentiment: "negative",
        correction: { action: "confirm", relevance: "relevant", sentiment: "negative", topics: [] },
        attentionId: "a1",
        attentionUnread: true,
      }),
      approved,
    );
    const model = buildDashboard({
      mentions: [mention],
      range: "7",
      source: "all",
      now,
      attentionUnread: 1,
      uncertainOpen: 0,
      partial: false,
    });
    expect(mention.needsAttention).toBe(true);
    expect(model.comparison.attention).toBeNull();
    const undated = presentMention(stored({ postedAt: null, collectedAt: "2026-11-01T02:00:00.000Z" }), approved);
    expect(undated.postedAt).toBeNull();
    expect(undated.occurredAt).toBeNull();
    const hiddenDay = buildDashboard({
      mentions: [undated],
      range: "7",
      source: "all",
      now,
      attentionUnread: 0,
      uncertainOpen: 0,
      partial: false,
    });
    expect(hiddenDay.totals.total).toBe(0);
  });

  it("derives confirm versus correct on the server and rejects an unknown topic", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "review@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const mentionId = randomUUID();
    await withCustomer(db, owner.customerId, async () => {
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'x', 'ext-1', 'geprek', null, 'ani', '2026-11-01T00:00:00.000Z', '2026-11-01T00:05:00.000Z', array['geprek'], 'succeeded')`,
        [mentionId, owner.customerId, project.projectId],
      );
      await db.query(
        `insert into jev_results (mention_id, customer_id, provider, model, raw_response, relevance_noul, sentiment, sentiment_confidence, topic_nouls, created_at)
         values ($1, $2, 'typesafe', 'jev', '{}', 0.95, 'positive', 0.9, '[]', now())`,
        [mentionId, owner.customerId],
      );
    });
    const corrected = await saveMentionReview(db, owner.customerId, mentionId, {
      relevance: "relevant",
      sentiment: "negative",
      topics: [],
    });
    expect(corrected).toEqual({ ok: true, action: "correct" });
    const rows = await withCustomer(db, owner.customerId, () =>
      db.query<{ action: string }>("select action from owner_corrections where mention_id = $1", [mentionId]),
    );
    expect(rows.rows[0]?.action).toBe("correct");
    const attention = await withCustomer(db, owner.customerId, () =>
      db.query("select id from attention_items where mention_id = $1", [mentionId]),
    );
    expect(attention.rows).toHaveLength(1);
    const rejected = await saveMentionReview(db, owner.customerId, mentionId, {
      relevance: "relevant",
      sentiment: "negative",
      topics: ["bukan-topik"],
    });
    expect(rejected).toEqual({ ok: false, reason: "invalid" });
    const still = await withCustomer(db, owner.customerId, () =>
      db.query<{ topics: string[] }>("select topics from owner_corrections where mention_id = $1", [mentionId]),
    );
    expect(still.rows[0]?.topics ?? []).toEqual([]);
  });

  it("saves a correction whose only topic is lainnya and still rejects an unknown id", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "lainnya@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "kedai");
    const mentionId = randomUUID();
    await withCustomer(db, owner.customerId, async () => {
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'threads', 'ext-lainnya', 'tidak masuk topik', null, 'ani', '2026-11-01T00:00:00.000Z', '2026-11-01T00:05:00.000Z', array['kedai'], 'succeeded')`,
        [mentionId, owner.customerId, project.projectId],
      );
      await db.query(
        `insert into jev_results (mention_id, customer_id, provider, model, raw_response, relevance_noul, sentiment, sentiment_confidence, topic_nouls, created_at)
         values ($1, $2, 'typesafe', 'jev', '{}', 0.9, 'neutral', 0.9, '[]', now())`,
        [mentionId, owner.customerId],
      );
    });
    const saved = await saveMentionReview(db, owner.customerId, mentionId, {
      relevance: "relevant",
      sentiment: "neutral",
      topics: ["lainnya"],
    });
    expect(saved.ok).toBe(true);
    const stored = await withCustomer(db, owner.customerId, () =>
      db.query<{ topics: string[] }>("select topics from owner_corrections where mention_id = $1", [mentionId]),
    );
    expect(stored.rows[0]?.topics).toEqual(["lainnya"]);
    const rejected = await saveMentionReview(db, owner.customerId, mentionId, {
      relevance: "relevant",
      sentiment: "neutral",
      topics: ["bukan-topik"],
    });
    expect(rejected).toEqual({ ok: false, reason: "invalid" });
    const still = await withCustomer(db, owner.customerId, () =>
      db.query<{ topics: string[] }>("select topics from owner_corrections where mention_id = $1", [mentionId]),
    );
    expect(still.rows[0]?.topics).toEqual(["lainnya"]);
    const workspace = await loadWorkspace(
      db,
      owner.customerId,
      project.projectId,
      new Date("2026-11-01T03:00:00.000Z"),
      readLimits(),
    );
    expect(workspace.topicLabels).toContainEqual({ id: "lainnya", label: "Lainnya" });
  });

  it("saves the owner name and rejects a blank one", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "nama@example.com", password: "sandi-panjang", displayName: "Lama" });
    const saved = await saveDisplayName(db, owner.customerId, "  Rina Baru  ");
    expect(saved).toEqual({ ok: true });
    const workspace = await loadWorkspace(db, owner.customerId, undefined, new Date("2026-11-01T03:00:00.000Z"), readLimits());
    expect(workspace.displayName).toBe("Rina Baru");
    expect(await saveDisplayName(db, owner.customerId, "   ")).toEqual({ ok: false, error: "Masukkan nama Anda." });
  });
});
