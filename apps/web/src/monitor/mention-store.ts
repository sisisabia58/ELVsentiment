import type { Queryable } from "../db/migrate";
import type { OwnerCorrection } from "../domain/display";
import type { SourceId } from "./policy";
import type { LegacySentiment, Sentiment, StoredMention, TriageJudgment, TriageStatus } from "./present";

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asTopics(value: unknown): { id: string; noul: number }[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { id?: unknown; noul?: unknown };
    if (typeof record.id !== "string" || typeof record.noul !== "number") return [];
    return [{ id: record.id, noul: record.noul }];
  });
}

function asTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

type MentionSql = {
  id: string;
  source: SourceId;
  excerpt: string;
  url: string | null;
  author: string | null;
  posted_at: string | Date | null;
  collected_at: string | Date;
  scoring_status: StoredMention["scoringStatus"];
  source_post_unavailable: boolean;
  read_at: string | Date | null;
  relevance_noul: number | null;
  sentiment: LegacySentiment | null;
  sentiment_confidence: number | null;
  topic_nouls: unknown;
  action: "confirm" | "correct" | null;
  correction_relevance: "relevant" | "irrelevant" | null;
  correction_sentiment: Sentiment | null;
  correction_topics: unknown;
  correction_at: string | Date | null;
  attention_id: string | null;
  attention_unread: boolean | null;
  association_statuses: unknown;
  pantau_filter_triage: boolean;
  triage_status: TriageStatus | null;
  destination: TriageJudgment["destination"] | null;
  origin: TriageJudgment["origin"] | null;
  relevance_tier: TriageJudgment["relevanceTier"] | null;
  triage_sentiment: TriageJudgment["sentiment"] | null;
  reason: TriageJudgment["reason"] | null;
  issue_category: TriageJudgment["issueCategory"];
  verified_excerpt: string | null;
};

function toStored(row: MentionSql): StoredMention {
  const correction: OwnerCorrection | null =
    row.action && row.correction_relevance
      ? {
          action: row.action,
          relevance: row.correction_relevance,
          sentiment: row.correction_sentiment,
          topics: asTextArray(row.correction_topics),
        }
      : null;
  const judgment = row.destination && row.origin && row.relevance_tier && row.triage_sentiment && row.reason
    ? {
        destination: row.destination,
        origin: row.origin,
        relevanceTier: row.relevance_tier,
        sentiment: row.triage_sentiment,
        reason: row.reason,
        issueCategory: row.issue_category,
        verifiedExcerpt: row.verified_excerpt,
      }
    : null;
  return {
    id: row.id,
    source: row.source,
    excerpt: row.excerpt,
    url: row.url,
    author: row.author,
    postedAt: iso(row.posted_at),
    collectedAt: iso(row.collected_at) ?? new Date(0).toISOString(),
    scoringStatus: row.scoring_status,
    sourcePostUnavailable: row.source_post_unavailable,
    readAt: iso(row.read_at),
    relevanceNoul: row.relevance_noul,
    sentiment: row.sentiment,
    sentimentConfidence: row.sentiment_confidence,
    topicNouls: asTopics(row.topic_nouls),
    correction,
    correctionAt: iso(row.correction_at),
    attentionId: row.attention_id,
    attentionUnread: row.attention_unread === true,
    associationStatuses: asTextArray(row.association_statuses),
    triage: row.pantau_filter_triage ? { status: row.triage_status ?? "pending", judgment } : undefined,
  };
}

export async function readStoredMentions(
  db: Queryable,
  customerId: string,
  scope: { projectId: string } | { mentionId: string },
): Promise<StoredMention[]> {
  const rows = await db.query<MentionSql>(
    `select m.id, m.source, m.excerpt, m.url, m.author, m.posted_at, m.collected_at, m.scoring_status,
            m.source_post_unavailable, m.read_at,
            j.relevance_noul, j.sentiment, j.sentiment_confidence, j.topic_nouls,
            c.action, c.relevance as correction_relevance, c.sentiment as correction_sentiment,
            c.topics as correction_topics, c.created_at as correction_at,
            a.id as attention_id, a.unread as attention_unread,
            assoc.statuses as association_statuses, p.pantau_filter_triage, tj.status as triage_status,
            t.destination, t.origin, t.relevance_tier, t.sentiment as triage_sentiment,
            t.reason, t.issue_category, t.verified_excerpt
     from mentions m
     join projects p on p.id = m.project_id and p.customer_id = m.customer_id
     left join pantau_triage_jobs tj
       on tj.mention_id = m.id and tj.customer_id = m.customer_id and tj.project_id = m.project_id
       and p.pantau_filter_triage
     left join pantau_triage_judgments t
       on t.mention_id = m.id and t.customer_id = m.customer_id and t.project_id = m.project_id
       and tj.status = 'completed'
     left join jev_results j on j.mention_id = m.id and j.customer_id = m.customer_id
     left join owner_corrections c on c.mention_id = m.id and c.customer_id = m.customer_id
     left join attention_items a on a.mention_id = m.id and a.customer_id = m.customer_id
     left join lateral (
       select array_agg(distinct a.status) as statuses
       from mention_keyword_associations a
       where a.mention_id = m.id and a.customer_id = m.customer_id
         and a.project_id = m.project_id and a.source = m.source
     ) assoc on true
     where m.customer_id = $1 and ${"projectId" in scope ? "m.project_id" : "m.id"} = $2
     order by coalesce(m.posted_at, m.collected_at) desc, m.id`,
    [customerId, "projectId" in scope ? scope.projectId : scope.mentionId],
  );
  return rows.rows.map(toStored);
}
