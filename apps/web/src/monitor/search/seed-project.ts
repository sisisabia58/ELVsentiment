import { randomUUID } from "node:crypto";
import type { Queryable } from "@/db/migrate";
import type { Keyword } from "@/domain/keyword-intent";
import type { Env } from "./feature";
import { isUuid } from "./load";
import { savedEvidenceRelevance, SEARCH_RELEVANCE_VERSION } from "./relevance";

export const PANTAU_TRIAGE_SOURCES = ["threads", "instagram", "tiktok"];

export function pantauFilterTriageEnabled(env: Env = process.env): boolean {
  return /^(1|true)$/i.test(env.PANTAU_FILTER_TRIAGE_ENABLED?.trim() ?? "");
}

export async function readImportableSearch(db: Queryable, customerId: string, searchId: string) {
  if (!isUuid(searchId)) return null;
  const found = await db.query<{ query_text: string; keyword_intent: string; relevance_version: number }>(
    `select query_text, keyword_intent, relevance_version from instant_searches
     where id = $1 and customer_id = $2 and status in ('succeeded', 'partial')
       and finished_at is not null and retention_expires_at > now()`,
    [searchId, customerId],
  );
  return found.rows[0] ?? null;
}

type SeedPost = {
  platform: string;
  external_id: string;
  text: string;
  title: string | null;
  url: string | null;
  author: string | null;
  published_at: Date | string | null;
  relevance: string;
  web_index: boolean;
  answered: boolean;
};

const MAX_SEED_POSTS = 20;

// The caller supplies the active customer transaction, after saving project settings.
export async function seedProjectFromSearch({ db, customerId, projectId, searchId }: {
  db: Queryable; customerId: string; projectId: string; searchId: string;
}): Promise<{ added: number; alreadyPresent: number; skipped: number }> {
  const counts = { added: 0, alreadyPresent: 0, skipped: 0 };
  const search = await readImportableSearch(db, customerId, searchId);
  if (!search || !isUuid(projectId)) return counts;

  const settings = await db.query<{ enabled_sources: string[] }>(
    `select ps.enabled_sources from projects p
     join project_settings ps on ps.project_id = p.id and ps.customer_id = p.customer_id
     where p.id = $1 and p.customer_id = $2 and p.pantau_filter_triage`,
    [projectId, customerId],
  );
  if (!settings.rows[0]) return counts;
  const sources = new Set(settings.rows[0].enabled_sources.filter((source) => PANTAU_TRIAGE_SOURCES.includes(source)));
  const variants = await db.query<Keyword>(
    `select text, intent from keyword_variants
     where project_id = $1 and customer_id = $2 and active order by text`,
    [projectId, customerId],
  );
  const posts = await db.query<SeedPost>(
    `select r.platform, r.external_id, r.text, r.title, r.url,
       coalesce(nullif(r.author_handle, ''), r.author_name) as author,
       r.published_at, r.relevance, r.web_index, coalesce(s.state = 'answered', false) as answered
     from instant_search_results r
     left join instant_search_sources s on s.search_id = r.search_id and s.customer_id = r.customer_id
       and s.platform = r.platform
     where r.search_id = $1 and r.customer_id = $2
     order by (r.published_at is null), r.rank nulls last,
       r.published_at desc nulls last, r.collected_at desc, r.platform, r.external_id, r.id`,
    [searchId, customerId],
  );

  const selected = [];
  for (const post of posts.rows) {
    if (selected.length >= MAX_SEED_POSTS) break;
    if (!sources.has(post.platform) || !post.answered || post.web_index
        || !post.external_id.trim() || post.external_id.startsWith("url:")) continue;
    const wasVisible = search.relevance_version >= SEARCH_RELEVANCE_VERSION
      ? post.relevance === "literal_match" || post.relevance === "all_words_match"
      : savedEvidenceRelevance(post, search.query_text, search.keyword_intent) !== null;
    if (!wasVisible) continue;
    const matched = variants.rows.filter(({ text, intent }) => savedEvidenceRelevance(post, text, intent));
    if (matched.length === 0) continue;
    // Cari snapshots store inline hashtags with the caption and title.
    const hashtags = [...new Set([post.text, post.title ?? ""].flatMap((value) =>
      Array.from(value.normalize("NFKC").matchAll(/#([\p{L}\p{N}_]+)/gu), (tag) => tag[1])))];
    selected.push({
      id: randomUUID(), platform: post.platform, external_id: post.external_id, text: post.text,
      url: post.url, author: post.author, published_at: post.published_at, title: post.title,
      matched_variants: matched.map(({ text }) => text), hashtags,
    });
  }
  if (selected.length === 0) return { ...counts, skipped: posts.rows.length };

  // Check snapshot retention in the same statement as the insert. A purge
  // after the initial read must not abort creation of the monitoring project.
  const inserted = await db.query<{ eligible: boolean; added: number }>(
    `with eligible_search as (
       select id from instant_searches where id = $3 and customer_id = $1
         and status in ('succeeded', 'partial') and finished_at is not null and retention_expires_at > now()
     ), inserted as (
       insert into mentions (
         id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at,
         collected_at, matched_variants, scoring_status, pantau_origin_search_id, pantau_title, pantau_hashtags
       )
       select r.id, $1, $2, r.platform, r.external_id, r.text, r.url, r.author, r.published_at,
         now(), r.matched_variants, 'pending', s.id, r.title, r.hashtags
       from eligible_search s
       cross join jsonb_to_recordset($4::jsonb) as r (
         id uuid, platform text, external_id text, text text, url text, author text, published_at timestamptz,
         matched_variants text[], title text, hashtags text[]
       )
       on conflict (customer_id, project_id, source, external_id) do nothing returning id
     )
     select exists (select 1 from eligible_search) as eligible, (select count(*)::int from inserted) as added`,
    [customerId, projectId, searchId, JSON.stringify(selected)],
  );
  const result = inserted.rows[0];
  if (!result?.eligible) return { ...counts, skipped: posts.rows.length };
  return {
    added: result.added,
    alreadyPresent: selected.length - result.added,
    skipped: posts.rows.length - selected.length,
  };
}
