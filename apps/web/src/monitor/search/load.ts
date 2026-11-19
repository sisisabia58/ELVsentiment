import type { Queryable } from "../../db/migrate";
import { withCustomer } from "../../db/migrate";
import { savedEvidenceRelevance, SEARCH_RELEVANCE_VERSION } from "./relevance";

const PLATFORM_ORDER = [
  "threads",
  "tiktok",
  "youtube",
  "instagram",
  "facebook",
  "x",
  "reddit",
  "linkedin",
  "web",
];

export type SearchFiltersRow = {
  dateWindow: "all" | "24h" | "7d" | "30d" | "12m";
  sort: "relevance" | "newest" | "popular";
  language: "all" | "id" | "en";
};

export type SnapshotSearch = {
  id: string;
  query: string;
  intent: string;
  filters: SearchFiltersRow;
  status: string;
  legacyEvidence?: boolean;
  summaryStatus: string;
  overallStance: string | null;
  errorCode: string | null;
  commentStatus?: string;
  commentDetail?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type SnapshotSource = {
  platform: string;
  state: string;
  resultCount: number;
  latencyMs: number | null;
  safeDetail: string;
  updatedAt: string;
};

export type SnapshotResult = {
  id: string;
  platform: string;
  externalId: string;
  authorName: string | null;
  authorHandle: string | null;
  url: string | null;
  text: string;
  title: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  views: number | null;
  likes: number | null;
  replies: number | null;
  shares: number | null;
  language: string;
  relevance: string;
  rank: number | null;
  collectedAt: string;
};

export type SnapshotComment = {
  id: string;
  resultId: string;
  platform: string;
  externalId: string;
  authorName: string | null;
  authorHandle: string | null;
  text: string;
  publishedAt: string | null;
  likes: number | null;
  replies: number | null;
};

export type SnapshotAi = {
  overallSummary: string;
  overallStance: string;
  platformSummaries: unknown;
  quotes: unknown;
  themes: unknown;
  model: string;
};

export type SnapshotQuestion = {
  id: string;
  question: string;
  status: string;
  answer: string | null;
  citations: string[];
  safeDetail: string | null;
  createdAt: string;
  answeredAt: string | null;
};

export type SearchSnapshot = {
  search: SnapshotSearch;
  sources: SnapshotSource[];
  totals: { sources: number; done: number; results: number };
  results: SnapshotResult[];
  comments: SnapshotComment[];
  ai: SnapshotAi | null;
  questions: SnapshotQuestion[];
};

export type SearchHistoryRow = {
  id: string;
  query: string;
  resultCount: number;
  sourceCount: number;
  stance: string | null;
  status: string;
  createdAt: string;
};

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function citationIds(value: unknown): string[] {
  const parsed = json(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value ?? [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function int(value: number | string | null | undefined): number {
  return Number(value ?? 0) || 0;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export async function loadSearchSnapshot(
  db: Queryable,
  customerId: string,
  searchId: string,
): Promise<SearchSnapshot | null> {
  // Postgres rejects a non-UUID literal before RLS can answer "not found".
  if (!isUuid(searchId)) return null;
  return withCustomer(db, customerId, async () => {
    const searchRows = await db.query<{
      id: string;
      query_text: string;
      keyword_intent: string;
      date_window: SearchFiltersRow["dateWindow"];
      sort_mode: SearchFiltersRow["sort"];
      language_filter: SearchFiltersRow["language"];
      status: string;
      relevance_version: number;
      summary_status: string;
      overall_stance: string | null;
      error_code: string | null;
      comment_status: string;
      comment_detail: string | null;
      created_at: string | Date;
      started_at: string | Date | null;
      finished_at: string | Date | null;
    }>(
      `select id, query_text, keyword_intent, date_window, sort_mode, language_filter,
              status, relevance_version, summary_status, overall_stance, error_code,
              comment_status, comment_detail,
              created_at, started_at, finished_at
       from instant_searches
       where id = $1 and customer_id = $2`,
      [searchId, customerId],
    );
    const row = searchRows.rows[0];
    if (!row) return null;
    const currentRelevance = row.relevance_version >= SEARCH_RELEVANCE_VERSION;
    const legacyEvidence = !currentRelevance && row.status !== "queued" && row.status !== "running";

    const sourceRows = await db.query<{
      platform: string;
      state: string;
      latency_ms: number | null;
      safe_detail: string;
      updated_at: string | Date;
    }>(
      `select platform, state, latency_ms, safe_detail, updated_at
       from instant_search_sources
       where search_id = $1 and customer_id = $2`,
      [searchId, customerId],
    );
    const resultRows = await db.query<{
      id: string;
      platform: string;
      external_id: string;
      author_name: string | null;
      author_handle: string | null;
      url: string | null;
      text: string;
      title: string | null;
      published_at: string | Date | null;
      thumbnail_url: string | null;
      views: number | null;
      likes: number | null;
      replies: number | null;
      shares: number | null;
      language: string;
      relevance: string;
      rank: number | null;
      collected_at: string | Date;
    }>(
      `select id, platform, external_id, author_name, author_handle, url, text, title,
              published_at, thumbnail_url, views, likes, replies, shares, language,
              relevance, rank, collected_at
       from instant_search_results
       where search_id = $1 and customer_id = $2
       order by (published_at is null) asc, rank asc nulls last,
                published_at desc nulls last, collected_at desc`,
      [searchId, customerId],
    );
    const counts = new Map<string, number>();
    const results: SnapshotResult[] = [];
    for (const result of resultRows.rows) {
      const relevance = currentRelevance
        ? result.relevance
        : savedEvidenceRelevance(result, row.query_text, row.keyword_intent);
      if (relevance !== "literal_match" && relevance !== "all_words_match") continue;
      counts.set(result.platform, (counts.get(result.platform) ?? 0) + 1);
      results.push({
        id: result.id,
        platform: result.platform,
        externalId: result.external_id,
        authorName: result.author_name,
        authorHandle: result.author_handle,
        url: result.url,
        text: result.text,
        title: result.title,
        publishedAt: iso(result.published_at),
        thumbnailUrl: result.thumbnail_url,
        views: result.views,
        likes: result.likes,
        replies: result.replies,
        shares: result.shares,
        language: result.language,
        relevance,
        rank: result.rank,
        collectedAt: iso(result.collected_at) ?? new Date(0).toISOString(),
      });
    }
    if (!currentRelevance && row.sort_mode === "relevance") {
      results.sort((a, b) => Number(!a.publishedAt) - Number(!b.publishedAt)
        || (a.publishedAt && b.publishedAt ? Number(a.relevance !== "literal_match") - Number(b.relevance !== "literal_match") : 0));
    }
    const order = new Map(PLATFORM_ORDER.map((platform, index) => [platform, index]));
    const sources: SnapshotSource[] = sourceRows.rows
      .map((source) => ({
        platform: source.platform,
        state: source.state,
        resultCount: counts.get(source.platform) ?? 0,
        latencyMs: source.latency_ms,
        safeDetail: source.safe_detail,
        updatedAt: iso(source.updated_at) ?? new Date(0).toISOString(),
      }))
      .sort((a, b) => (order.get(a.platform) ?? 99) - (order.get(b.platform) ?? 99));
    const resultIds = results.map((result) => result.id);
    const generatedEvidenceEligible = currentRelevance && resultIds.length > 0;

    const commentRows = resultIds.length > 0 ? await db.query<{
      id: string;
      result_id: string;
      platform: string;
      external_id: string;
      author_name: string | null;
      author_handle: string | null;
      text: string;
      published_at: string | Date | null;
      likes: number | null;
      replies: number | null;
    }>(
      `select id, result_id, platform, external_id, author_name, author_handle, text,
              published_at, likes, replies
       from instant_search_comments
       where search_id = $1 and customer_id = $2 and result_id = any($3::uuid[])
       order by result_id, likes desc nulls last, published_at asc nulls last, collected_at`,
      [searchId, customerId, resultIds],
    ) : { rows: [] };
    const comments: SnapshotComment[] = commentRows.rows.map((comment) => ({
      id: comment.id,
      resultId: comment.result_id,
      platform: comment.platform,
      externalId: comment.external_id,
      authorName: comment.author_name,
      authorHandle: comment.author_handle,
      text: comment.text,
      publishedAt: iso(comment.published_at),
      likes: comment.likes,
      replies: comment.replies,
    }));

    const aiRows = generatedEvidenceEligible ? await db.query<{
      overall_summary: string;
      overall_stance: string;
      platform_summaries: unknown;
      quotes: unknown;
      themes: unknown;
      model: string;
    }>(
      `select overall_summary, overall_stance, platform_summaries, quotes, themes, model
       from instant_search_ai
       where search_id = $1 and customer_id = $2`,
      [searchId, customerId],
    ) : { rows: [] };
    const aiRow = aiRows.rows[0];
    const ai: SnapshotAi | null = aiRow
      ? {
          overallSummary: aiRow.overall_summary,
          overallStance: aiRow.overall_stance,
          platformSummaries: json(aiRow.platform_summaries),
          quotes: json(aiRow.quotes),
          themes: json(aiRow.themes),
          model: aiRow.model,
        }
      : null;

    const questionRows = generatedEvidenceEligible ? await db.query<{
      id: string;
      question: string;
      status: string;
      answer: string | null;
      citations: unknown;
      safe_detail: string | null;
      created_at: string | Date;
      answered_at: string | Date | null;
    }>(
      `select id, question, status, answer, citations, safe_detail, created_at, answered_at
       from instant_search_questions
       where search_id = $1 and customer_id = $2
       order by created_at, id`,
      [searchId, customerId],
    ) : { rows: [] };
    const questions: SnapshotQuestion[] = questionRows.rows.map((question) => ({
      id: question.id,
      question: question.question,
      status: question.status,
      answer: question.answer,
      citations: citationIds(question.citations),
      safeDetail: question.safe_detail,
      createdAt: iso(question.created_at) ?? new Date(0).toISOString(),
      answeredAt: iso(question.answered_at),
    }));

    return {
      search: {
        id: row.id,
        query: row.query_text,
        intent: row.keyword_intent,
        filters: {
          dateWindow: row.date_window,
          sort: row.sort_mode,
          language: row.language_filter,
        },
        status: row.status,
        legacyEvidence,
        summaryStatus: legacyEvidence ? "skipped" : row.summary_status,
        overallStance: generatedEvidenceEligible ? row.overall_stance : null,
        errorCode: row.error_code,
        commentStatus: legacyEvidence ? (comments.length > 0 ? "done" : "skipped") : row.comment_status,
        commentDetail: legacyEvidence ? (results.length === 0 ? "no_posts" : null) : row.comment_detail,
        createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
      },
      sources,
      totals: {
        sources: sources.length,
        done: sources.filter((source) => source.state === "answered").length,
        results: results.length,
      },
      results,
      comments,
      ai,
      questions,
    };
  });
}

export async function loadHistory(
  db: Queryable,
  customerId: string,
  limit = 20,
): Promise<SearchHistoryRow[]> {
  const bounded = Math.min(50, Math.max(1, Math.floor(limit) || 20));
  return withCustomer(db, customerId, async () => {
    const rows = await db.query<{
      id: string;
      query_text: string;
      keyword_intent: string;
      relevance_version: number;
      overall_stance: string | null;
      status: string;
      created_at: string | Date;
      result_count: number | string;
      source_count: number | string;
    }>(
      `select s.id, s.query_text, s.keyword_intent, s.relevance_version, s.overall_stance, s.status, s.created_at,
              (select count(*) from instant_search_results r
                 where s.relevance_version >= $3 and r.search_id = s.id and r.customer_id = s.customer_id
                   and r.relevance in ('literal_match', 'all_words_match'))::int as result_count,
              (select count(*) from instant_search_sources src
                 where src.search_id = s.id and src.customer_id = s.customer_id)::int as source_count
       from instant_searches s
       where s.customer_id = $1
       order by s.created_at desc, s.id desc
       limit $2`,
      [customerId, bounded, SEARCH_RELEVANCE_VERSION],
    );
    const legacy = new Map(rows.rows.filter((row) => row.relevance_version < SEARCH_RELEVANCE_VERSION)
      .map((row) => [row.id, row]));
    const eligibleCounts = new Map<string, number>();
    if (legacy.size > 0) {
      const evidence = await db.query<{ search_id: string; text: string; title: string | null }>(
        `select search_id, text, title from instant_search_results
         where customer_id = $1 and search_id = any($2::uuid[])`,
        [customerId, [...legacy.keys()]],
      );
      for (const post of evidence.rows) {
        const saved = legacy.get(post.search_id);
        if (saved && savedEvidenceRelevance(post, saved.query_text, saved.keyword_intent)) {
          eligibleCounts.set(saved.id, (eligibleCounts.get(saved.id) ?? 0) + 1);
        }
      }
    }
    return rows.rows.map((row) => ({
      id: row.id,
      query: row.query_text,
      resultCount: legacy.has(row.id) ? (eligibleCounts.get(row.id) ?? 0) : int(row.result_count),
      sourceCount: int(row.source_count),
      stance: !legacy.has(row.id) && int(row.result_count) > 0 ? row.overall_stance : null,
      status: row.status,
      createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    }));
  });
}
