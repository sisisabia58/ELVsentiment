import type { Queryable } from "../../db/migrate";
import { withCustomer } from "../../db/migrate";
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
              status, summary_status, overall_stance, error_code,
              comment_status, comment_detail,
              created_at, started_at, finished_at
       from instant_searches
       where id = $1 and customer_id = $2`,
      [searchId, customerId],
    );
    const row = searchRows.rows[0];
    if (!row) return null;

    const sourceRows = await db.query<{
      platform: string;
      state: string;
      result_count: number | string;
      latency_ms: number | null;
      safe_detail: string;
      updated_at: string | Date;
    }>(
      `select platform, state, result_count, latency_ms, safe_detail, updated_at
       from instant_search_sources
       where search_id = $1 and customer_id = $2`,
      [searchId, customerId],
    );
    const order = new Map(PLATFORM_ORDER.map((platform, index) => [platform, index]));
    const sources: SnapshotSource[] = sourceRows.rows
      .map((source) => ({
        platform: source.platform,
        state: source.state,
        resultCount: int(source.result_count),
        latencyMs: source.latency_ms,
        safeDetail: source.safe_detail,
        updatedAt: iso(source.updated_at) ?? new Date(0).toISOString(),
      }))
      .sort((a, b) => (order.get(a.platform) ?? 99) - (order.get(b.platform) ?? 99));

    // Every stored row is loaded. Header, history, and the result tabs all
    // count this table, so a display LIMIT would make those numbers disagree.
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
    const results: SnapshotResult[] = resultRows.rows.map((result) => ({
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
      relevance: result.relevance,
      rank: result.rank,
      collectedAt: iso(result.collected_at) ?? new Date(0).toISOString(),
    }));

    const resultCountRows = await db.query<{ n: number | string }>(
      `select count(*)::int as n from instant_search_results
       where search_id = $1 and customer_id = $2`,
      [searchId, customerId],
    );
    const storedResultCount = int(resultCountRows.rows[0]?.n);

    const commentRows = await db.query<{
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
       where search_id = $1 and customer_id = $2
       order by result_id, likes desc nulls last, published_at asc nulls last, collected_at`,
      [searchId, customerId],
    );
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

    const aiRows = await db.query<{
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
    );
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

    const questionRows = await db.query<{
      id: string;
      question: string;
      status: string;
      answer: string | null;
      citations: unknown;
      created_at: string | Date;
      answered_at: string | Date | null;
    }>(
      `select id, question, status, answer, citations, created_at, answered_at
       from instant_search_questions
       where search_id = $1 and customer_id = $2
       order by created_at, id`,
      [searchId, customerId],
    );
    const questions: SnapshotQuestion[] = questionRows.rows.map((question) => ({
      id: question.id,
      question: question.question,
      status: question.status,
      answer: question.answer,
      citations: citationIds(question.citations),
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
        summaryStatus: row.summary_status,
        overallStance: row.overall_stance,
        errorCode: row.error_code,
        commentStatus: row.comment_status,
        commentDetail: row.comment_detail,
        createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
      },
      sources,
      totals: {
        sources: sources.length,
        done: sources.filter((source) => source.state === "answered").length,
        results: storedResultCount,
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
      overall_stance: string | null;
      status: string;
      created_at: string | Date;
      result_count: number | string;
      source_count: number | string;
    }>(
      `select s.id, s.query_text, s.overall_stance, s.status, s.created_at,
              (select count(*) from instant_search_results r
                 where r.search_id = s.id and r.customer_id = s.customer_id)::int as result_count,
              (select count(*) from instant_search_sources src
                 where src.search_id = s.id and src.customer_id = s.customer_id)::int as source_count
       from instant_searches s
       where s.customer_id = $1
       order by s.created_at desc, s.id desc
       limit $2`,
      [customerId, bounded],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      query: row.query_text,
      resultCount: int(row.result_count),
      sourceCount: int(row.source_count),
      stance: row.overall_stance,
      status: row.status,
      createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    }));
  });
}
