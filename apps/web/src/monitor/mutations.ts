import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import type { OwnerCorrection } from "../domain/display";
import { presentMention, type Sentiment } from "./present";
import { readMonitorPolicy, reviewTopicChoices } from "./policy";
import { readStoredMentions } from "./mention-store";

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
  if (input.relevance !== "relevant" && input.relevance !== "irrelevant") return { ok: false, reason: "invalid" };
  if (input.relevance === "relevant" && !["positive", "neutral", "negative", "mixed"].includes(input.sentiment ?? "")) {
    return { ok: false, reason: "invalid" };
  }
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
    const [row] = await readStoredMentions(db, customerId, { mentionId });
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const shown = presentMention(row, policy.scoring);
    if (next.sentiment === "mixed" && (!row.triage || shown.sentiment !== "mixed")) {
      return { ok: false as const, reason: "invalid" as const };
    }
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
    const eligible = correction.relevance === "relevant" && (
      correction.sentiment === "negative" || (correction.sentiment === "mixed" && shown.needsAttention)
    );
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
  return withCustomer(db, customerId, async () => {
    const [row] = await readStoredMentions(db, customerId, { mentionId });
    return row ? presentMention(row, policy.scoring).needsAttention : false;
  });
}
