import { randomUUID } from "node:crypto";
import type { Queryable } from "@/db/migrate";
import { withCustomer } from "@/db/migrate";
import { parseKeyword } from "@/domain/keyword-intent";
import { cleanQuery, validateSearchInput, type SearchFilters } from "@/monitor/search/filters";
import type { SearchLimits } from "@/monitor/search/limits";
import { createInstantSearch } from "@/monitor/search/mutations";
import { cariSekarangEnabled, type Env } from "@/monitor/search/feature";
import { isUuid } from "@/monitor/search/load";
import { SEARCH_RELEVANCE_VERSION } from "@/monitor/search/relevance";
import { pantauFilterTriageEnabled } from "@/monitor/search/seed-project";
import { buildOnboardingFields } from "@/monitor/search/present";
import { ALL_SOURCES, type OnboardingDraftFields } from "@/monitor/onboarding-draft";

export type StartSearchResult =
  | { ok: true; searchId: string }
  | { ok: false; error: string };

export type StartSearchInput = {
  query: string;
  filters: SearchFilters;
};

export async function startSearchForCustomer(input: {
  db: Queryable;
  customerId: string;
  query: string;
  filters: SearchFilters;
  env?: Env;
  limits: SearchLimits;
  now: Date;
}): Promise<StartSearchResult> {
  if (!cariSekarangEnabled(input.env ?? process.env)) {
    return { ok: false, error: "disabled" };
  }
  if (typeof input.query !== "string") return { ok: false, error: "invalid_query" };
  const text = cleanQuery(input.query);
  const invalid = validateSearchInput(text, input.filters);
  if (invalid) return { ok: false, error: invalid };
  const keyword = parseKeyword(text);
  const created = await createInstantSearch(
    input.db,
    input.customerId,
    { query: keyword.text, intent: keyword.intent, filters: input.filters },
    input.now,
    input.limits,
  );
  return created.ok ? { ok: true, searchId: created.searchId } : { ok: false, error: created.error };
}

export type AskQuestionResult =
  | { ok: true; questionId: string }
  | { ok: false; error: string };

async function questionEvidenceError(db: Queryable, customerId: string, searchId: string) {
  const owned = await db.query<{ eligible: boolean }>(
    `select s.relevance_version >= $3 and s.status in ('succeeded', 'partial') and exists (
       select 1 from instant_search_results r
       where r.search_id = s.id and r.customer_id = s.customer_id
         and r.relevance in ('literal_match', 'all_words_match')
     ) as eligible
     from instant_searches s where s.id = $1 and s.customer_id = $2`,
    [searchId, customerId, SEARCH_RELEVANCE_VERSION],
  );
  if (!owned.rows[0]) return "not_found";
  return owned.rows[0].eligible ? null : "no_evidence";
}

export async function askQuestionForCustomer(input: {
  db: Queryable;
  customerId: string;
  searchId: string;
  question: unknown;
  env?: Env;
}): Promise<AskQuestionResult> {
  if (!cariSekarangEnabled(input.env ?? process.env)) {
    return { ok: false, error: "disabled" };
  }
  if (!isUuid(input.searchId)) return { ok: false, error: "not_found" };
  if (typeof input.question !== "string") return { ok: false, error: "invalid_question" };
  const question = input.question.trim();
  if (question.length < 3 || question.length > 300) return { ok: false, error: "invalid_question" };
  return withCustomer(input.db, input.customerId, async () => {
    const error = await questionEvidenceError(input.db, input.customerId, input.searchId);
    if (error) return { ok: false, error };
    const questionId = randomUUID();
    await input.db.query(
      `insert into instant_search_questions
         (id, search_id, customer_id, question, status, user_credits)
       values ($1, $2, $3, $4, 'queued', 1)`,
      [questionId, input.searchId, input.customerId, question],
    );
    return { ok: true, questionId };
  });
}

export async function retryQuestionForCustomer(input: {
  db: Queryable;
  customerId: string;
  searchId: string;
  questionId: unknown;
  env?: Env;
}): Promise<AskQuestionResult> {
  if (!cariSekarangEnabled(input.env ?? process.env)) {
    return { ok: false, error: "disabled" };
  }
  if (!isUuid(input.searchId) || typeof input.questionId !== "string" || !isUuid(input.questionId)) {
    return { ok: false, error: "not_found" };
  }
  return withCustomer(input.db, input.customerId, async () => {
    const error = await questionEvidenceError(input.db, input.customerId, input.searchId);
    if (error) return { ok: false, error };
    const updated = await input.db.query<{ id: string }>(
      `update instant_search_questions
          set status = 'queued',
              answer = null,
              citations = '[]'::jsonb,
              safe_detail = null,
              model = null,
              cost_usd = 0,
              answered_at = null
        where id = $1
          and search_id = $2
          and customer_id = $3
          and status = 'failed'
        returning id`,
      [input.questionId, input.searchId, input.customerId],
    );
    if (!updated.rows[0]) return { ok: false, error: "not_found" };
    return { ok: true, questionId: updated.rows[0].id };
  });
}

export type MonitorProjectResult =
  | { ok: true; href: "/onboarding?baru=1"; fields: OnboardingDraftFields; originSearchId?: string; cariAttemptId?: string }
  | { ok: false; error: string };

export async function monitorAsProjectForCustomer(input: {
  db: Queryable;
  customerId: string;
  searchId: string;
  env?: Env;
}): Promise<MonitorProjectResult> {
  if (!cariSekarangEnabled(input.env ?? process.env)) {
    return { ok: false, error: "disabled" };
  }
  if (!isUuid(input.searchId)) return { ok: false, error: "not_found" };
  return withCustomer(input.db, input.customerId, async () => {
    const owned = await input.db.query<{ query_text: string }>(
      "select query_text from instant_searches where id = $1 and customer_id = $2",
      [input.searchId, input.customerId],
    );
    const query = owned.rows[0]?.query_text;
    if (!query) return { ok: false, error: "not_found" };
    const sourceRows = await input.db.query<{ platform: string }>(
      `select platform from instant_search_sources
        where search_id = $1 and customer_id = $2 and state = 'answered'
        order by platform`,
      [input.searchId, input.customerId],
    );
    const fields = buildOnboardingFields(
      { query, platforms: sourceRows.rows.map((row) => row.platform) },
      [...ALL_SOURCES],
    );
    const ready = { ok: true as const, href: "/onboarding?baru=1" as const, fields: { projectId: null, step: 1, ...fields } };
    if (!pantauFilterTriageEnabled(input.env)) return ready;
    const attempt = await input.db.query<{ id: string }>(
      `insert into cari_onboarding_attempts (id, customer_id, search_id)
       select $1, customer_id, id from instant_searches
       where customer_id = $2 and id = $3 and status in ('succeeded', 'partial')
         and finished_at is not null and retention_expires_at > now() and relevance_version >= $4
       returning id`,
      [randomUUID(), input.customerId, input.searchId, SEARCH_RELEVANCE_VERSION],
    );
    return attempt.rows[0]
      ? { ...ready, originSearchId: input.searchId, cariAttemptId: attempt.rows[0].id }
      : ready;
  });
}
