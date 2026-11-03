import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import type { ParsedJudgment } from "../domain/routing";
import type { OwnerCorrection } from "../domain/display";

export type ClaimedMention = {
  id: string;
  customerId: string;
  projectId: string;
  excerpt: string;
  brandName: string;
  attempts: number;
};

type ClaimRow = {
  id: string;
  customer_id: string;
  project_id: string;
  excerpt: string;
  scoring_attempts: number;
};

type StoredJudgment = {
  provider: "typesafe" | "openrouter";
  model: string;
  raw: unknown;
  judgment: ParsedJudgment;
};

// One claim may spend four 20s Jev timeouts plus backoff. The lease stays
// longer than that window so a live request is not scored by a second worker.
export const SCORING_MAX_ATTEMPTS = 3;
export const SCORING_LEASE_SECONDS = 180;

const CLAIM_TOKEN_SQL = "(extract(epoch from scoring_claimed_at) * 1000000)::bigint::text";

const CLAIM_SQL = `
update mentions m
set scoring_status = 'scoring',
    scoring_claimed_at = clock_timestamp(),
    scoring_attempts = m.scoring_attempts + 1
from (
  select id
  from mentions
  where scoring_status = 'pending'
    and scoring_attempts < $2
  order by collected_at asc, id asc
  limit $1
  for update skip locked
) picked
where m.id = picked.id
returning m.id, m.customer_id, m.project_id, m.excerpt, m.scoring_attempts
`;

const CLAIM_SQL_FOR_CUSTOMER = `
update mentions m
set scoring_status = 'scoring',
    scoring_claimed_at = clock_timestamp(),
    scoring_attempts = m.scoring_attempts + 1
from (
  select id
  from mentions
  where scoring_status = 'pending'
    and scoring_attempts < $2
    and customer_id = $3
  order by collected_at asc, id asc
  limit $1
  for update skip locked
) picked
where m.id = picked.id
  and m.customer_id = $3
returning m.id, m.customer_id, m.project_id, m.excerpt, m.scoring_attempts
`;

const RECLAIM_SQL = `
update mentions m
set scoring_status = case when m.scoring_attempts >= $1::int then 'failed' else 'pending' end,
    scoring_claimed_at = null
from (
  select id
  from mentions
  where scoring_status = 'scoring'
    and (
      scoring_claimed_at is null
      or scoring_claimed_at < clock_timestamp() - make_interval(secs => $2::double precision)
    )
  for update skip locked
) stale
where m.id = stale.id
`;

const RECLAIM_SQL_FOR_CUSTOMER = `
update mentions m
set scoring_status = case when m.scoring_attempts >= $1::int then 'failed' else 'pending' end,
    scoring_claimed_at = null
from (
  select id
  from mentions
  where scoring_status = 'scoring'
    and customer_id = $3
    and (
      scoring_claimed_at is null
      or scoring_claimed_at < clock_timestamp() - make_interval(secs => $2::double precision)
    )
  for update skip locked
) stale
where m.id = stale.id
  and m.customer_id = $3
`;

const TOUCH_SQL = `
update mentions
set scoring_claimed_at = clock_timestamp()
where id = $1 and customer_id = $2 and scoring_status = 'scoring' and scoring_attempts = $3
returning ${CLAIM_TOKEN_SQL} as claim_token
`;

// worker_role writes set the tenant GUC only. They must not become app_user.
async function asWorker<T>(db: Queryable, fn: () => Promise<T>, customerId?: string): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec("set local role worker_role");
    if (customerId) await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    const value = await fn();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function claimRows(db: Queryable, limit: number, customerId?: string): Promise<ClaimedMention[]> {
  const claimed = await db.query<ClaimRow>(
    customerId ? CLAIM_SQL_FOR_CUSTOMER : CLAIM_SQL,
    customerId ? [limit, SCORING_MAX_ATTEMPTS, customerId] : [limit, SCORING_MAX_ATTEMPTS],
  );
  if (claimed.rows.length === 0) return [];
  const projectIds = [...new Set(claimed.rows.map((row) => row.project_id))];
  const placeholders = projectIds.map((_, index) => `$${index + 1}`).join(", ");
  const brands = await db.query<{ id: string; brand_name: string }>(
    `select id, brand_name from projects where id in (${placeholders})`,
    projectIds,
  );
  const brandById = new Map(brands.rows.map((row) => [row.id, row.brand_name]));
  return claimed.rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    projectId: row.project_id,
    excerpt: row.excerpt,
    brandName: brandById.get(row.project_id) ?? "",
    attempts: Number(row.scoring_attempts),
  }));
}

export async function claimPendingBatch(db: Queryable, limit: number, customerId?: string): Promise<ClaimedMention[]> {
  if (customerId) return withCustomer(db, customerId, () => claimRows(db, limit, customerId));
  return asWorker(db, () => claimRows(db, limit));
}

export async function reclaimStaleClaims(db: Queryable, customerId?: string): Promise<void> {
  const sql = customerId ? RECLAIM_SQL_FOR_CUSTOMER : RECLAIM_SQL;
  const params = customerId
    ? [SCORING_MAX_ATTEMPTS, SCORING_LEASE_SECONDS, customerId]
    : [SCORING_MAX_ATTEMPTS, SCORING_LEASE_SECONDS];
  if (customerId) {
    await withCustomer(db, customerId, () => db.query(sql, params));
    return;
  }
  await asWorker(db, () => db.query(sql, params));
}

export async function touchScoringClaim(
  db: Queryable,
  customerId: string,
  mentionId: string,
  attempts: number,
  scopedToCustomer: boolean,
): Promise<string | null> {
  const run = async () => {
    const touched = await db.query<{ claim_token: string | number }>(TOUCH_SQL, [mentionId, customerId, attempts]);
    const token = touched.rows[0]?.claim_token;
    return token == null ? null : String(token);
  };
  if (scopedToCustomer) return withCustomer(db, customerId, run);
  return asWorker(db, run, customerId);
}

export async function claimMention(db: Queryable, customerId: string, mentionId: string): Promise<boolean> {
  const claimed = await withCustomer(db, customerId, () =>
    db.query<{ id: string }>(
      "update mentions set scoring_status = 'scoring' where id = $1 and customer_id = $2 and scoring_status = 'pending' returning id",
      [mentionId, customerId],
    ),
  );
  return claimed.rows.length === 1;
}

async function storeJudgment(
  db: Queryable,
  customerId: string,
  mentionId: string,
  input: StoredJudgment,
  claimToken?: string,
): Promise<boolean> {
  if (claimToken) {
    const owned = await db.query<{ id: string }>(
      `select id from mentions
       where id = $1 and customer_id = $2 and scoring_status = 'scoring'
         and ${CLAIM_TOKEN_SQL} = $3
       for update`,
      [mentionId, customerId, claimToken],
    );
    if (owned.rows.length !== 1) return false;
  }
  await db.query(
    `insert into jev_results (mention_id, customer_id, provider, model, raw_response, relevance_noul, sentiment, sentiment_confidence, topic_nouls, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     on conflict (mention_id) do nothing`,
    [
      mentionId,
      customerId,
      input.provider,
      input.model,
      JSON.stringify(input.raw),
      input.judgment.relevanceNoul,
      input.judgment.sentiment,
      input.judgment.sentimentConfidence,
      JSON.stringify(input.judgment.topicNouls),
    ],
  );
  await db.query(
    claimToken
      ? "update mentions set scoring_status = 'succeeded', scoring_claimed_at = null where id = $1 and customer_id = $2 and scoring_status = 'scoring'"
      : "update mentions set scoring_status = 'succeeded' where id = $1 and customer_id = $2",
    [mentionId, customerId],
  );
  return true;
}

export async function recordSuccess(
  db: Queryable,
  customerId: string,
  mentionId: string,
  input: StoredJudgment,
  claimToken?: string,
): Promise<boolean> {
  let saved = false;
  await withCustomer(db, customerId, async () => {
    saved = await storeJudgment(db, customerId, mentionId, input, claimToken);
  });
  return saved;
}

export async function recordWorkerSuccess(
  db: Queryable,
  customerId: string,
  mentionId: string,
  input: StoredJudgment,
  claimToken?: string,
): Promise<boolean> {
  let saved = false;
  await asWorker(
    db,
    async () => {
      saved = await storeJudgment(db, customerId, mentionId, input, claimToken);
    },
    customerId,
  );
  return saved;
}

async function setScoringStatus(
  db: Queryable,
  customerId: string,
  mentionId: string,
  status: "failed" | "pending",
  claimToken?: string,
): Promise<void> {
  if (claimToken) {
    await db.query(
      `update mentions set scoring_status = $3, scoring_claimed_at = null
       where id = $1 and customer_id = $2 and scoring_status = 'scoring'
         and ${CLAIM_TOKEN_SQL} = $4`,
      [mentionId, customerId, status, claimToken],
    );
    return;
  }
  await db.query("update mentions set scoring_status = $3 where id = $1 and customer_id = $2", [
    mentionId,
    customerId,
    status,
  ]);
}

export async function settleOwnedAttempt(
  db: Queryable,
  customerId: string,
  mentionId: string,
  retryable: boolean,
  claimToken: string,
  scopedToCustomer: boolean,
): Promise<"pending" | "failed" | "lost"> {
  const run = async () => {
    const owned = await db.query<{ scoring_attempts: number }>(
      `select scoring_attempts from mentions
       where id = $1 and customer_id = $2 and scoring_status = 'scoring'
         and ${CLAIM_TOKEN_SQL} = $3
       for update`,
      [mentionId, customerId, claimToken],
    );
    if (owned.rows.length !== 1) return "lost" as const;
    const attempts = Number(owned.rows[0].scoring_attempts);
    const status = retryable && attempts < SCORING_MAX_ATTEMPTS ? "pending" : "failed";
    await setScoringStatus(db, customerId, mentionId, status, claimToken);
    return status;
  };
  if (scopedToCustomer) return withCustomer(db, customerId, run);
  return asWorker(db, run, customerId);
}

export async function recordFailure(db: Queryable, customerId: string, mentionId: string): Promise<void> {
  await withCustomer(db, customerId, () => setScoringStatus(db, customerId, mentionId, "failed"));
}

export async function recordWorkerFailure(db: Queryable, customerId: string, mentionId: string): Promise<void> {
  await asWorker(db, () => setScoringStatus(db, customerId, mentionId, "failed"), customerId);
}

export async function releaseToPending(db: Queryable, customerId: string, mentionId: string): Promise<void> {
  await withCustomer(db, customerId, () => setScoringStatus(db, customerId, mentionId, "pending"));
}

export async function releaseWorkerToPending(db: Queryable, customerId: string, mentionId: string): Promise<void> {
  await asWorker(db, () => setScoringStatus(db, customerId, mentionId, "pending"), customerId);
}

export async function saveCorrection(
  db: Queryable,
  customerId: string,
  mentionId: string,
  correction: OwnerCorrection,
): Promise<void> {
  if (correction.relevance === "irrelevant" && (correction.sentiment !== null || correction.topics.length > 0)) {
    throw new Error("irrelevant_correction");
  }
  await withCustomer(db, customerId, () =>
    db.query(
      `insert into owner_corrections (mention_id, customer_id, action, relevance, sentiment, topics, created_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (mention_id) do update set action = excluded.action, relevance = excluded.relevance, sentiment = excluded.sentiment, topics = excluded.topics, created_at = now()`,
      [mentionId, customerId, correction.action, correction.relevance, correction.sentiment, correction.topics],
    ),
  );
}
