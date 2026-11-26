import { randomUUID } from "node:crypto";
import type { Queryable } from "@/db/migrate";
import type { Keyword } from "@/domain/keyword-intent";
import type { SnapshotResult } from "./load";
import { SEARCH_RELEVANCE_VERSION } from "./relevance";
import { isUuid } from "./search-id";
import { IMPORTABLE_SEARCH, seedEvidenceForPost, type SeedPost } from "./seed-project";

export type ReviewKey = { searchId: string; resultId: string; projectId: string };
export type ReviewDestination = "attention" | "ambiguous";

type ReviewFailure = { ok: false; error: "not_found" | "ineligible" };

type ReviewPost = SeedPost & {
  id: string;
  author_name: string | null;
  author_handle: string | null;
  thumbnail_url: string | null;
  views: number | null;
  likes: number | null;
  replies: number | null;
  shares: number | null;
  language: string;
  rank: number | null;
  collected_at: string | Date;
  enabled_sources: string[] | null;
  variants: Keyword[];
  mention_id: string | null;
  saved_state: string;
};

const REVIEW_POST = `with eligible_search as (
  select id, customer_id from instant_searches
  where id = $3 and customer_id = $1 and ${IMPORTABLE_SEARCH} and relevance_version >= $5
), review_post as (
  select r.id, r.platform, r.external_id, r.text, r.title, r.url, r.author_name, r.author_handle,
    coalesce(nullif(r.author_handle, ''), r.author_name) as author,
    r.published_at, r.thumbnail_url, r.views, r.likes, r.replies, r.shares,
    r.language, r.relevance, r.rank, r.collected_at, r.web_index,
    coalesce(src.state = 'answered', false) as answered, ps.enabled_sources,
    (select coalesce(jsonb_agg(jsonb_build_object('text', v.text, 'intent', v.intent) order by v.text), '[]')
     from keyword_variants v where v.project_id = p.id and v.customer_id = p.customer_id and v.active) as variants
  from eligible_search s
  join instant_search_results r on r.search_id = s.id and r.customer_id = s.customer_id
  join projects p on p.id = $2 and p.customer_id = s.customer_id
  left join project_settings ps on ps.project_id = p.id and ps.customer_id = p.customer_id and p.pantau_filter_triage
  left join instant_search_sources src on src.search_id = s.id and src.customer_id = s.customer_id
    and src.platform = r.platform
  where r.id = $4
)`;

function reviewParams(customerId: string, key: ReviewKey) {
  return [customerId, key.projectId, key.searchId, key.resultId, SEARCH_RELEVANCE_VERSION];
}

async function readReviewPost(db: Queryable, customerId: string, key: ReviewKey) {
  if (![key.searchId, key.resultId, key.projectId].every(isUuid)) return null;
  const found = await db.query<ReviewPost>(
    `${REVIEW_POST}
     select r.*, to_jsonb(r)::text as saved_state, m.id as mention_id
     from review_post r
     left join mentions m on m.customer_id = $1 and m.project_id = $2
       and m.source = r.platform and m.external_id = r.external_id`,
    reviewParams(customerId, key),
  );
  return found.rows[0] ?? null;
}

async function readReviewAdmission(db: Queryable, customerId: string, key: ReviewKey) {
  const post = await readReviewPost(db, customerId, key);
  if (!post) return { ok: false, error: "not_found" } satisfies ReviewFailure;
  const evidence = seedEvidenceForPost(post, new Set(post.enabled_sources ?? []), post.variants);
  if (!evidence) return { ok: false, error: "ineligible" } satisfies ReviewFailure;
  return { ok: true as const, post, evidence };
}

function snapshotEvidence(post: ReviewPost): SnapshotResult {
  return {
    id: post.id, platform: post.platform, externalId: post.external_id, text: post.text, title: post.title,
    url: post.url, authorName: post.author_name, authorHandle: post.author_handle,
    publishedAt: post.published_at == null ? null : new Date(post.published_at).toISOString(),
    thumbnailUrl: post.thumbnail_url, views: post.views, likes: post.likes, replies: post.replies,
    shares: post.shares, language: post.language, relevance: post.relevance, rank: post.rank,
    collectedAt: new Date(post.collected_at).toISOString(),
  };
}

// These helpers use the caller's active customer transaction.
export async function resolveReviewResult(
  db: Queryable, customerId: string, key: ReviewKey,
): Promise<{ ok: true; evidence: SnapshotResult; mentionId: string | null } | ReviewFailure> {
  const review = await readReviewAdmission(db, customerId, key);
  if (!review.ok) return review;
  return { ok: true, evidence: snapshotEvidence(review.post), mentionId: review.post.mention_id };
}

export async function admitReviewResult(
  db: Queryable, customerId: string, key: ReviewKey,
): Promise<{ ok: true; mentionId: string } | ReviewFailure> {
  const review = await readReviewAdmission(db, customerId, key);
  if (!review.ok) return review;
  if (review.post.mention_id) return { ok: true, mentionId: review.post.mention_id };

  // Recheck the result, search, and project in the write statement. Use the
  // server's current row and the variant matches and tags computed for that row.
  const inserted = await db.query<{ id: string }>(
    `${REVIEW_POST}
     insert into mentions (
       id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at,
       collected_at, matched_variants, scoring_status, pantau_origin_search_id, pantau_title, pantau_hashtags
     )
     select $6, $1, $2, r.platform, r.external_id, r.text, r.url, r.author, r.published_at,
       now(), $7::text[], 'pending', $3, r.title, $8::text[]
     from review_post r where to_jsonb(r) = $9::jsonb
     on conflict (customer_id, project_id, source, external_id) do nothing returning id`,
    [...reviewParams(customerId, key), randomUUID(), review.evidence.matched_variants,
      review.evidence.hashtags, review.post.saved_state],
  );
  if (inserted.rows[0]) return { ok: true, mentionId: inserted.rows[0].id };

  // After a concurrent conflicting insert commits, a new statement can see its row.
  const current = await readReviewAdmission(db, customerId, key);
  if (!current.ok) return current;
  return current.post.mention_id
    ? { ok: true, mentionId: current.post.mention_id }
    : { ok: false, error: "ineligible" };
}
