import { attentionDecision } from "../domain/attention";
import { displayOf, type OwnerCorrection } from "../domain/display";
import { failedScoring, routeJudgment, type ParsedJudgment, type ScoringPolicy } from "../domain/routing";
import { initialsFrom } from "./format";
import type { SourceId } from "./policy";
import { textMatchOf, type TextMatch } from "./relevance";

export type Sentiment = "positive" | "neutral" | "negative";
export type MentionBucket = "included" | "excluded" | "not_sure" | "failed" | "pending" | "policy_unapproved";
export type UncertainField = "relevansi" | "sentimen" | "topik";

export type StoredMention = {
  id: string;
  source: SourceId;
  excerpt: string;
  url: string | null;
  author: string | null;
  postedAt: string | null;
  collectedAt: string;
  scoringStatus: "pending" | "scoring" | "succeeded" | "failed";
  sourcePostUnavailable: boolean;
  readAt: string | null;
  relevanceNoul: number | null;
  sentiment: Sentiment | null;
  sentimentConfidence: number | null;
  topicNouls: { id: string; noul: number }[];
  correction: OwnerCorrection | null;
  correctionAt: string | null;
  attentionId: string | null;
  attentionUnread: boolean;
  associationStatuses: string[];
};

export type PresentedMention = {
  id: string;
  source: SourceId;
  excerpt: string;
  url: string | null;
  authorLabel: string;
  handle: string;
  initials: string;
  postedAt: string | null;
  collectedAt: string;
  occurredAt: string | null;
  read: boolean;
  bucket: MentionBucket;
  sentiment: Sentiment | null;
  relevance: "relevant" | "irrelevant" | null;
  topics: string[];
  relevanceConfidence: number | null;
  sentimentConfidence: number | null;
  corrected: boolean;
  confirmed: boolean;
  correctionAt: string | null;
  originalSentiment: Sentiment | null;
  originalRelevance: "relevant" | "irrelevant" | null;
  uncertainFields: UncertainField[];
  needsAttention: boolean;
  attentionUnread: boolean;
  attentionId: string | null;
  sourcePostUnavailable: boolean;
  scoringStatus: StoredMention["scoringStatus"];
  textMatch: TextMatch;
};

function asJudgment(row: StoredMention): ParsedJudgment | null {
  if (
    row.relevanceNoul === null ||
    row.sentiment === null ||
    row.sentimentConfidence === null ||
    !Array.isArray(row.topicNouls)
  ) {
    return null;
  }
  return {
    relevanceNoul: row.relevanceNoul,
    sentiment: row.sentiment,
    sentimentConfidence: row.sentimentConfidence,
    topicNouls: row.topicNouls,
  };
}

export function presentMention(row: StoredMention, policy: ScoringPolicy): PresentedMention {
  const author = row.author?.trim() ?? "";
  const handle = author.length === 0 ? "" : author.startsWith("@") ? author : `@${author}`;
  const base = {
    id: row.id,
    source: row.source,
    excerpt: row.excerpt,
    url: row.url,
    authorLabel: author.length === 0 ? "Nama pengguna tidak tersedia" : author.replace(/^@/, ""),
    handle: handle.length === 0 ? "Nama pengguna tidak tersedia" : handle,
    initials: initialsFrom(author.length === 0 ? "?" : author),
    postedAt: row.postedAt,
    collectedAt: row.collectedAt,
    occurredAt: row.postedAt,
    read: row.readAt !== null,
    relevanceConfidence: row.relevanceNoul,
    sentimentConfidence: row.sentimentConfidence,
    corrected: row.correction?.action === "correct",
    confirmed: row.correction?.action === "confirm",
    correctionAt: row.correctionAt,
    attentionId: row.attentionId,
    sourcePostUnavailable: row.sourcePostUnavailable,
    scoringStatus: row.scoringStatus,
    textMatch: textMatchOf(row.associationStatuses),
  };

  if (row.scoringStatus === "pending" || row.scoringStatus === "scoring") {
    return {
      ...base,
      bucket: "pending",
      sentiment: null,
      relevance: null,
      topics: [],
      originalSentiment: null,
      originalRelevance: null,
      uncertainFields: [],
      needsAttention: false,
      attentionUnread: false,
    };
  }

  if (row.scoringStatus === "failed" && !row.correction) {
    const failed = displayOf(failedScoring(), null);
    return {
      ...base,
      bucket: "failed",
      sentiment: failed.sentiment,
      relevance: failed.relevance,
      topics: [],
      originalSentiment: null,
      originalRelevance: null,
      uncertainFields: [],
      needsAttention: false,
      attentionUnread: false,
    };
  }

  const judgment = asJudgment(row);
  const route = judgment ? routeJudgment(judgment, policy) : failedScoring();
  const display = displayOf(route, row.correction);
  const bucket: MentionBucket =
    display.bucket === "included" ||
    display.bucket === "excluded" ||
    display.bucket === "not_sure" ||
    display.bucket === "failed" ||
    display.bucket === "policy_unapproved"
      ? display.bucket
      : "failed";
  const uncertainFields: UncertainField[] = [];
  if (!row.correction && route.bucket === "not_sure") {
    if (route.relevance === "uncertain") uncertainFields.push("relevansi");
    if (route.sentimentUncertain) uncertainFields.push("sentimen");
    if (route.topicsUncertain) uncertainFields.push("topik");
    if (uncertainFields.length === 0) uncertainFields.push("relevansi");
  }
  const autoAttention =
    !row.correction &&
    judgment !== null &&
    route.bucket !== "failed" &&
    attentionDecision(
      { mentionId: row.id, route, sentimentConfidence: row.sentimentConfidence },
      policy,
    ).eligible;
  const ownerNegative = row.correction?.relevance === "relevant" && row.correction.sentiment === "negative";
  const needsAttention = bucket === "included" && (ownerNegative || autoAttention);
  return {
    ...base,
    bucket,
    sentiment: display.sentiment,
    relevance: display.relevance,
    topics: display.topics,
    originalSentiment: row.sentiment,
    originalRelevance:
      route.bucket === "failed"
        ? null
        : route.relevance === "relevant" || route.relevance === "irrelevant"
          ? route.relevance
          : null,
    uncertainFields,
    needsAttention,
    attentionUnread: needsAttention && (row.attentionId === null || row.attentionUnread) && row.readAt === null,
  };
}

export const UNCERTAIN_LABEL: Record<UncertainField, string> = {
  relevansi: "Relevansi belum pasti",
  sentimen: "Sentimen belum pasti",
  topik: "Topik belum pasti",
};

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: "Positif",
  neutral: "Netral",
  negative: "Negatif",
};
