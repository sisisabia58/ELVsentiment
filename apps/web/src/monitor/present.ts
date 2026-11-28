import { attentionDecision } from "../domain/attention";
import { displayOf, type OwnerCorrection } from "../domain/display";
import { failedScoring, routeJudgment, type ParsedJudgment, type ScoringPolicy } from "../domain/routing";
import type { ReviewDestination } from "./search/review-result";
import { initialsFrom } from "./format";
import type { SourceId } from "./policy";
import { textMatchOf, type TextMatch } from "./relevance";

export type LegacySentiment = "positive" | "neutral" | "negative";
export type Sentiment = LegacySentiment | "mixed";

export const TRIAGE_STATUS_LABEL = {
  pending: "Menunggu penilaian",
  processing: "Sedang dinilai",
  retrying: "Menunggu percobaan ulang",
  deferred: "Penilaian ditunda",
  failed: "Penilaian gagal",
  completed: "Penilaian selesai",
  unavailable: "Penilaian tidak tersedia",
} as const;

export const TRIAGE_REASON_LABEL = {
  firsthand_complaint: "Keluhan langsung dengan kutipan terverifikasi",
  relevance_unclear: "Kaitan dengan merek perlu diperiksa",
  complaint_unclear: "Arti keluhan atau tindakan yang diperlukan perlu diperiksa",
  non_actionable: "Tidak ada keluhan yang perlu ditangani",
  no_match: "Tidak ditemukan kecocokan dengan kata kunci proyek",
  insufficient_text: "Teks tidak cukup untuk diperiksa",
} as const;

export const ISSUE_CATEGORY_LABEL = {
  payment: "Pembayaran",
  stock: "Stok",
  product_quality: "Kualitas produk",
  order_fulfillment: "Pemenuhan pesanan",
  service: "Layanan",
  pricing: "Harga",
  other: "Lainnya",
} as const;

export type TriageStatus = keyof typeof TRIAGE_STATUS_LABEL;
export type TriageJudgment = {
  destination: "attention" | "ambiguous" | "mention" | "excluded";
  origin: "deterministic" | "opencode";
  relevanceTier: "literal_match" | "all_words_match" | "no_match" | "insufficient_text";
  sentiment: Sentiment | "unclear";
  reason: keyof typeof TRIAGE_REASON_LABEL;
  issueCategory: keyof typeof ISSUE_CATEGORY_LABEL | null;
  verifiedExcerpt: string | null;
};
type Triage = { status: TriageStatus } & Partial<TriageJudgment>;

export type MentionBucket = "included" | "excluded" | "not_sure" | "failed" | "pending" | "policy_unapproved";
export type UncertainField = "relevansi" | "sentimen" | "topik" | "keluhan";

export const MANUAL_ROUTE_LABEL = { attention: "Perlu perhatian", ambiguous: "Belum yakin" } satisfies Record<ReviewDestination, string>;

export type PresentedManualRoute = { destination: ReviewDestination; routedAt: string };

export type StoredMention = {
  manualRoute?: PresentedManualRoute;
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
  sentiment: LegacySentiment | null;
  sentimentConfidence: number | null;
  topicNouls: { id: string; noul: number }[];
  correction: OwnerCorrection | null;
  correctionAt: string | null;
  attentionId: string | null;
  attentionUnread: boolean;
  associationStatuses: string[];
  triage?: { status: TriageStatus; judgment: TriageJudgment | null };
};

export type PresentedMention = {
  manualRoute?: PresentedManualRoute;
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
  requiresAssessmentChange?: boolean;
  needsAttention: boolean;
  attentionUnread: boolean;
  attentionId: string | null;
  sourcePostUnavailable: boolean;
  scoringStatus: StoredMention["scoringStatus"];
  textMatch: TextMatch;
  triage?: Triage;
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

  if (row.triage) {
    const { judgment } = row.triage;
    const status = !judgment && (row.source === "x" || row.sourcePostUnavailable)
      ? "unavailable"
      : row.triage.status;
    const result = status === "completed" ? judgment : null;
    const correction = row.correction;
    const originalRelevance = result?.destination === "excluded"
      ? "irrelevant"
      : result?.destination === "mention" || result?.destination === "attention" || result?.reason === "complaint_unclear"
        ? "relevant"
        : null;
    const originalSentiment = result?.sentiment === "unclear" ? null : result?.sentiment ?? null;
    const manualRoute = correction?.relevance === "irrelevant" ? undefined : row.manualRoute;
    const automaticBucket: MentionBucket = correction
      ? correction.relevance === "relevant" ? "included" : "excluded"
      : result?.destination === "attention" || result?.destination === "mention" ? "included"
        : result?.destination === "ambiguous" ? "not_sure"
          : result?.destination === "excluded" ? "excluded"
            : status === "failed" || status === "completed" || status === "unavailable" ? "failed" : "pending";
    const bucket = manualRoute?.destination === "attention" ? "included"
      : manualRoute?.destination === "ambiguous" ? "not_sure" : automaticBucket;
    const needsAttention = manualRoute ? manualRoute.destination === "attention" : bucket === "included" && (correction
      ? row.attentionId !== null
      : result?.destination === "attention");
    const relevance = correction ? correction.relevance : originalRelevance;
    const textMatch = result?.relevanceTier === "insufficient_text" ? "unknown_text"
      : result?.relevanceTier === "literal_match" ? "literal_match"
        : result ? "no_literal_match" : row.associationStatuses.length ? base.textMatch : "unknown_text";
    return {
      ...base,
      manualRoute,
      textMatch,
      bucket,
      relevance,
      sentiment: relevance === "irrelevant" ? null : correction ? correction.sentiment : originalSentiment,
      topics: correction?.relevance === "relevant" ? correction.topics : [],
      relevanceConfidence: null,
      sentimentConfidence: null,
      originalSentiment,
      originalRelevance,
      requiresAssessmentChange: automaticBucket === "not_sure",
      uncertainFields: bucket === "not_sure" ? [result?.reason === "complaint_unclear" ? "keluhan" : "relevansi"] : [],
      needsAttention,
      attentionUnread: needsAttention && row.readAt === null,
      scoringStatus: automaticBucket === "pending" ? status === "processing" ? "scoring" : "pending" : automaticBucket === "failed" ? "failed" : "succeeded",
      triage: { ...result, status: status === "completed" && !result ? "failed" : status },
    };
  }

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
  keluhan: "Makna keluhan belum pasti",
};

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: "Positif",
  neutral: "Netral",
  negative: "Negatif",
  mixed: "Campuran",
};

export function isOpenUncertain(mention: {
  bucket: string; confirmed: boolean; corrected: boolean; manualRoute?: PresentedManualRoute;
}) {
  return mention.bucket === "not_sure" && (mention.manualRoute?.destination === "ambiguous"
    || (!mention.confirmed && !mention.corrected));
}
