import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import type { OwnerCorrection } from "../domain/display";
import { presentMention, type Sentiment } from "./present";
import { readMonitorPolicy, reviewTopicChoices, type SourceId } from "./policy";

export async function setMentionRead(
  db: Queryable,
  customerId: string,
  mentionId: string,
  read: boolean,
): Promise<{ ok: true } | { ok: false }> {
  return withCustomer(db, customerId, async () => {
    const updated = await db.query<{ id: string }>(
      `update mentions set read_at = case when $3 then now() else null end
       where id = $1 and customer_id = $2
       returning id`,
      [mentionId, customerId, read],
    );
    if (updated.rows.length !== 1) return { ok: false as const };
    await db.query(
      `update attention_items
       set unread = $3, seen_at = case when $3 then null else now() end
       where mention_id = $1 and customer_id = $2`,
      [mentionId, customerId, !read],
    );
    return { ok: true as const };
  });
}

export async function saveMentionReview(
  db: Queryable,
  customerId: string,
  mentionId: string,
  input: { relevance: "relevant" | "irrelevant"; sentiment: Sentiment | null; topics: string[] },
): Promise<{ ok: true; action: "confirm" | "correct" } | { ok: false; reason: "not_found" | "invalid" }> {
  if (input.relevance === "relevant" && !input.sentiment) return { ok: false, reason: "invalid" };
  const policy = readMonitorPolicy();
  const allowed = new Set(reviewTopicChoices(policy).map((topic) => topic.id));
  const topics = input.relevance === "relevant" ? input.topics : [];
  if (topics.some((topic) => !allowed.has(topic))) return { ok: false, reason: "invalid" };
  const next = {
    relevance: input.relevance,
    sentiment: input.relevance === "relevant" ? input.sentiment : null,
    topics,
  };
  return withCustomer(db, customerId, async () => {
    const rows = await db.query<{
      id: string;
      source: SourceId;
      excerpt: string;
      url: string | null;
      author: string | null;
      posted_at: string | Date | null;
      collected_at: string | Date;
      scoring_status: "pending" | "scoring" | "succeeded" | "failed";
      source_post_unavailable: boolean;
      read_at: string | Date | null;
      relevance_noul: number | null;
      sentiment: Sentiment | null;
      sentiment_confidence: number | null;
      topic_nouls: unknown;
      action: "confirm" | "correct" | null;
      relevance: "relevant" | "irrelevant" | null;
      correction_sentiment: Sentiment | null;
      topics: string[] | null;
      created_at: string | Date | null;
      attention_id: string | null;
      unread: boolean | null;
    }>(
      `select m.id, m.source, m.excerpt, m.url, m.author, m.posted_at, m.collected_at, m.scoring_status,
              m.source_post_unavailable, m.read_at, j.relevance_noul, j.sentiment, j.sentiment_confidence, j.topic_nouls,
              c.action, c.relevance, c.sentiment as correction_sentiment, c.topics, c.created_at,
              a.id as attention_id, a.unread
       from mentions m
       left join jev_results j on j.mention_id = m.id
       left join owner_corrections c on c.mention_id = m.id
       left join attention_items a on a.mention_id = m.id
       where m.id = $1`,
      [mentionId],
    );
    const row = rows.rows[0];
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const shown = presentMention(
      {
        id: row.id,
        source: row.source,
        excerpt: row.excerpt,
        url: row.url,
        author: row.author,
        postedAt: row.posted_at instanceof Date ? row.posted_at.toISOString() : row.posted_at,
        collectedAt: row.collected_at instanceof Date ? row.collected_at.toISOString() : String(row.collected_at),
        scoringStatus: row.scoring_status,
        sourcePostUnavailable: row.source_post_unavailable,
        readAt: row.read_at instanceof Date ? row.read_at.toISOString() : row.read_at,
        relevanceNoul: row.relevance_noul,
        sentiment: row.sentiment,
        sentimentConfidence: row.sentiment_confidence,
        topicNouls: Array.isArray(row.topic_nouls) ? (row.topic_nouls as { id: string; noul: number }[]) : [],
        correction:
          row.action && row.relevance
            ? { action: row.action, relevance: row.relevance, sentiment: row.correction_sentiment, topics: row.topics ?? [] }
            : null,
        correctionAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        attentionId: row.attention_id,
        attentionUnread: row.unread === true,
      },
      policy.scoring,
    );
    const changed = reviewWouldChange(
      {
        relevance: shown.relevance === "relevant" || shown.relevance === "irrelevant" ? shown.relevance : null,
        sentiment: shown.sentiment,
        topics: shown.topics,
      },
      next,
    );
    const correction: OwnerCorrection = { action: changed ? "correct" : "confirm", ...next };
    await db.query(
      `insert into owner_corrections (mention_id, customer_id, action, relevance, sentiment, topics, created_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (mention_id) do update
         set action = excluded.action, relevance = excluded.relevance, sentiment = excluded.sentiment,
             topics = excluded.topics, created_at = now()`,
      [mentionId, customerId, correction.action, correction.relevance, correction.sentiment, correction.topics],
    );
    const eligible = correction.relevance === "relevant" && correction.sentiment === "negative";
    if (!eligible) {
      await db.query("delete from attention_items where mention_id = $1 and customer_id = $2", [mentionId, customerId]);
    } else {
      await db.query(
        `insert into attention_items (id, customer_id, mention_id, reason, unread, seen_at, created_at)
         values ($1, $2, $3, 'negative', true, null, now())
         on conflict (mention_id) do nothing`,
        [randomUUID(), customerId, mentionId],
      );
    }
    return { ok: true as const, action: correction.action };
  });
}

export function reviewWouldChange(
  current: { relevance: "relevant" | "irrelevant" | null; sentiment: Sentiment | null; topics: string[] },
  next: { relevance: "relevant" | "irrelevant"; sentiment: Sentiment | null; topics: string[] },
): boolean {
  const topics = [...current.topics].sort().join("\0");
  const nextTopics = [...next.topics].sort().join("\0");
  return current.relevance !== next.relevance || current.sentiment !== next.sentiment || topics !== nextTopics;
}

export async function attentionStillEligible(db: Queryable, customerId: string, mentionId: string): Promise<boolean> {
  const policy = readMonitorPolicy();
  const rows = await withCustomer(db, customerId, () =>
    db.query<{
      id: string;
      source: SourceId;
      excerpt: string;
      url: string | null;
      author: string | null;
      posted_at: string | Date | null;
      collected_at: string | Date;
      scoring_status: "pending" | "scoring" | "succeeded" | "failed";
      source_post_unavailable: boolean;
      read_at: string | Date | null;
      relevance_noul: number | null;
      sentiment: Sentiment | null;
      sentiment_confidence: number | null;
      topic_nouls: unknown;
      action: "confirm" | "correct" | null;
      relevance: "relevant" | "irrelevant" | null;
      correction_sentiment: Sentiment | null;
      topics: string[] | null;
      created_at: string | Date | null;
      attention_id: string | null;
      unread: boolean | null;
    }>(
      `select m.id, m.source, m.excerpt, m.url, m.author, m.posted_at, m.collected_at, m.scoring_status,
              m.source_post_unavailable, m.read_at, j.relevance_noul, j.sentiment, j.sentiment_confidence, j.topic_nouls,
              c.action, c.relevance, c.sentiment as correction_sentiment, c.topics, c.created_at,
              a.id as attention_id, a.unread
       from mentions m
       left join jev_results j on j.mention_id = m.id
       left join owner_corrections c on c.mention_id = m.id
       left join attention_items a on a.mention_id = m.id
       where m.id = $1`,
      [mentionId],
    ),
  );
  const row = rows.rows[0];
  if (!row) return false;
  const shown = presentMention(
    {
      id: row.id,
      source: row.source,
      excerpt: row.excerpt,
      url: row.url,
      author: row.author,
      postedAt: row.posted_at instanceof Date ? row.posted_at.toISOString() : row.posted_at,
      collectedAt: row.collected_at instanceof Date ? row.collected_at.toISOString() : String(row.collected_at),
      scoringStatus: row.scoring_status,
      sourcePostUnavailable: row.source_post_unavailable,
      readAt: row.read_at instanceof Date ? row.read_at.toISOString() : row.read_at,
      relevanceNoul: row.relevance_noul,
      sentiment: row.sentiment,
      sentimentConfidence: row.sentiment_confidence,
      topicNouls: Array.isArray(row.topic_nouls) ? (row.topic_nouls as { id: string; noul: number }[]) : [],
      correction:
        row.action && row.relevance
          ? { action: row.action, relevance: row.relevance, sentiment: row.correction_sentiment, topics: row.topics ?? [] }
          : null,
      correctionAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      attentionId: row.attention_id,
      attentionUnread: row.unread === true,
    },
    policy.scoring,
  );
  return shown.needsAttention;
}
