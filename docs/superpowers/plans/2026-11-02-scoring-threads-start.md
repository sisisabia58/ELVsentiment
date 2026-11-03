# Scoring job and Threads-only start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score collected mentions through the existing Jev client and scoring persistence, allow Threads collection once the credential policy is approved, and propose conservative settings that stay inert until one final approval commit.

**Architecture:** Scoring stays in the web TypeScript package because `apps/web/src/jev/http.ts` and `apps/web/src/scoring/jobs.ts` already own the Jev call and the `jev_results` write. A batch claim uses `FOR UPDATE SKIP LOCKED` and the `jev_results` primary key so a mention is never sent to Jev twice. The Python worker keeps collecting. Its gate stops blocking Threads on the X budget, and still refuses X until `x-budget.json` is approved and `X_BEARER_TOKEN` is set. Threshold numbers and topic labels land before the flags that turn them on.

**Tech Stack:** Next.js web app (Vitest, PGlite, Postgres 16), Python worker (pytest), existing migrations `001`–`007`.

## Global Constraints

- Start from main `460f0b731c0b179e9c2ddd35ec69abf9c0926fb6`. Do not touch other branches or pull requests.
- Migrations `apps/web/src/db/sql/001_init.sql` through `007_monitor_ui.sql` stay byte-identical. A new migration is `008_scoring_worker.sql` only, additive and safe. Do not edit `001`–`007`.
- No new environment variables. Use existing `TYPESAFE_API_KEY`, the existing constant `TYPESAFE_URL` (`https://api.typesafe.ai/v1/systemone`), model `jev-1.14.0`, and `THREADS_ACCESS_TOKEN`. `X_BEARER_TOKEN` and `WORKER_DATABASE_URL` already exist; do not add others.
- No secrets, no `.env` file, no deploys, no Railway changes, no edits to `deploy/`.
- No real Typesafe, Jev, OpenRouter, X, or Threads network calls. Tests mock `fetch` or inject a transport. No production database writes.
- OpenRouter fallback stays OFF. `scoreWithFallback` is called with `fallbackEnabled` false. Do not call `fallbackTransport`.
- Never log or echo `TYPESAFE_API_KEY` or any other secret. Redact `Authorization` / `Bearer` values in error text before logging.
- If `TYPESAFE_API_KEY` is missing or blank, log exactly `scoring skipped: TYPESAFE_API_KEY is not set`, score nothing, and do not throw.
- Retry only HTTP 429, HTTP 5xx, and timeouts, with exponential backoff and jitter. Do not retry other 4xx responses.
- A mention is never scored twice. Claim `pending` → `scoring` with `FOR UPDATE SKIP LOCKED` (or the existing conditional update) and insert `jev_results` with `on conflict (mention_id) do nothing`.
- Web writes go through `withCustomer` (`app_user`). Worker-role writes use `worker_role` and must not `SET ROLE app_user`.
- Apply `routeJudgment` thresholds: relevance at or below `relevanceExcludeMax` is irrelevant (kept, not deleted); relevance below `relevanceIncludeMin` stays uncertain; sentiment confidence below `sentimentConfidenceMin` is the Belum yakin bucket (`not_sure` / `sentimentUncertain`); topics are kept only at or above `topicNoulMin`; otherwise the fallback id `lainnya`.
- These proposed numbers are fixed: `relevanceExcludeMax` 0.35, `relevanceIncludeMin` 0.75, `sentimentConfidenceMin` 0.70, `topicNoulMin` 0.65, `attentionNegativeConfidenceMin` 0.85. The fourth threshold is `attentionNegativeConfidenceMin` (Perlu perhatian). Relevance is the exclude/include pair because `requireApprovedNumbers` requires both, with exclude strictly below include.
- Topic labels are the eight ids in Task 2, plus fallback `lainnya` (not sent to Jev as a question). `config/topic-labels.json` stays `"approved": false` until the final commit.
- `high_impact` stays false. `jev_fallback_rule` stays false. `config/x-budget.json` stays `{ "approved": false }`.
- Every approval-flag change from false to true, including `credential_policy`, is only in the final commit titled exactly `Approve proposed scoring/Threads settings (review before merge)`. Earlier commits must leave `config/launch-approvals.json`, `config/credential-policy.json` `"approved"`, `config/x-budget.json`, and `topic-labels.json` `"approved"` as they are today.
- `credential_policy` mode stays `shared_operator`.
- The UI keeps showing X as `Tidak tersedia` when `X_BEARER_TOKEN` is unset. Do not require the X budget file inside `sourceCredentials`, because `runNowAction` tests set only the token.
- Test-driven development: write the failing test, watch it fail, then implement. Follow `~/.cursor/plugins/cache/cursor-public/684/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/test-driven-development/SKILL.md`.
- Do not start the scorer from Next.js boot, `instrumentation`, or the Python worker loop. The worker image has no Node. The entry is a function plus a CLI that does not run during `next build` or vitest.

---

## Task 1: Retry Jev calls without enabling fallback

**Files:**
- Modify: `apps/web/src/jev/http.ts`
- Modify: `apps/web/src/jev/http.test.ts`
- Create: `apps/web/src/jev/retry.ts`
- Create: `apps/web/src/jev/retry.test.ts`
- Modify: `apps/web/src/jev/client.test.ts` (one lock that fallback stays off)

**Interfaces:**
- Consumes: `postSystemOne(url, body, apiKey, timeoutMs?)` and `scoreWithFallback(..., fallbackEnabled)`.
- Produces:
  - `postSystemOne` rejects `{ timeout: true }` when the abort signal fires, and still rejects `{ network: true }` for a `TypeError`.
  - `isRetryable(error: { status?: number; network?: boolean; timeout?: boolean }): boolean` is true only for `timeout`, status 429, or status 500–599.
  - `backoffDelayMs(attempt: number, random: () => number): number` where `attempt` is 0 for the first retry. Base is 200ms, doubling each attempt, capped at 5000ms. Jitter is `random()` in `[0, 1)` times half of that capped base, added to the base. `random` 0 returns the bare base.
  - `redactAuthorization(message: string, apiKey?: string): string` replaces `Authorization` / `Bearer <token>` case-insensitively and replaces every exact `apiKey` occurrence with `[redacted]`.
  - `postWithRetry(post, body, apiKey, options)` calls `post` up to 4 times. It sleeps only between retryable failures. The `log` option receives redacted text only. Non-retryable errors throw the redacted error and do not sleep.

- [ ] **Step 1: Write failing HTTP timeout and retry tests**

Cover:
- `postSystemOne` maps an aborted fetch to `{ timeout: true }` and still maps `TypeError` to `{ network: true }`.
- 429, 503, and `{ timeout: true }` each succeed on the second call; sleep is called once; the delay equals `backoffDelayMs(0, () => 0)` which is 200.
- 400, 401, 403, and 404 each call `post` once and do not sleep.
- Four retryable failures stop at 4 calls.
- A thrown `Error` whose message is `Authorization: Bearer super-secret-jev` is logged without `super-secret-jev` and without `Bearer super-secret-jev`.
- `scoreWithFallback(body, { primary, fallback }, false)` on a rejected `{ status: 429 }` does not call `fallback`.

- [ ] **Step 2: Run the new tests and confirm they fail because the modules or timeout branch do not exist**

Run: `npm test --prefix apps/web -- src/jev/retry.test.ts src/jev/http.test.ts src/jev/client.test.ts`

- [ ] **Step 3: Implement the minimum to pass**

Keep `primaryTransport` and `fallbackTransport` exports. Default `timeoutMs` is 20000. Clear the timer. Do not log inside `postSystemOne`.

- [ ] **Step 4: Re-run those tests until they pass**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/jev/http.ts apps/web/src/jev/http.test.ts apps/web/src/jev/retry.ts apps/web/src/jev/retry.test.ts apps/web/src/jev/client.test.ts
git commit -m "$(cat <<'EOF'
feat: retry Jev timeouts and rate limits without OpenRouter

EOF
)"
```

---

## Task 2: Proposed thresholds, topic labels, and the settings note

**Files:**
- Modify: `apps/web/src/monitor/policy.ts`
- Create: `apps/web/src/monitor/policy.test.ts`
- Modify: `config/topic-labels.json` (`approved` stays false)
- Create: `docs/settings-proposal.md`
- Create: `apps/web/src/domain/proposed-routing.test.ts` if the policy test file should not import the router; either file is fine, not both with duplicated cases

**Interfaces:**
- Consumes: `routeJudgment`, `readMonitorPolicy`.
- Produces: `readMonitorPolicy()` returns the five fixed numbers even while `scoring.approved` is false. `topicLabels` remains `{ id, label }[]`. Add `topicQuestions: { id: string; instructions: string }[]` that omits the fallback id. `fallbackTopicId` is `lainnya` when the file says so.

Do not change `config/launch-approvals.json`, `config/credential-policy.json`, or `config/x-budget.json` in this task.

`config/topic-labels.json` becomes exactly this shape (`approved` false):

```json
{
  "approved": false,
  "fallbackId": "lainnya",
  "labels": [
    { "id": "harga", "label": "Harga", "instructions": "The post is about price, cost, or whether the product is worth the money." },
    { "id": "kualitas", "label": "Kualitas produk", "instructions": "The post is about product quality, taste, durability, or whether the product works as expected." },
    { "id": "layanan", "label": "Layanan pelanggan", "instructions": "The post is about customer service, staff, or how the business responded." },
    { "id": "pengiriman", "label": "Pengiriman", "instructions": "The post is about delivery, shipping time, or a courier." },
    { "id": "promo", "label": "Promo", "instructions": "The post is about a discount, voucher, or promotion." },
    { "id": "stok", "label": "Ketersediaan stok", "instructions": "The post is about whether the product is in stock or sold out." },
    { "id": "kemasan", "label": "Kemasan", "instructions": "The post is about packaging or the condition of the parcel." },
    { "id": "pengalaman", "label": "Pengalaman pembelian", "instructions": "The post is about the buying experience, checkout, or ordering." }
  ]
}
```

`docs/settings-proposal.md` is plain language. For every setting include the name, the value, and what it means. Cover the five thresholds, each topic label, the `lainnya` fallback, and the flags that this commit does **not** turn on: `scoring_policy`, `topic_labels`, `topic_counting`, `credential_policy` approved, `high_impact` false, `jev_fallback_rule` false, `x-budget` approved false. Say the product ignores the numbers until those flags are true, and that a later commit turns on only the flags named for approval.

- [ ] **Step 1: Write failing tests**

Using the real `config/` directory (do not point `CONFIG_DIR` at a fixture for these assertions):
- `readMonitorPolicy().scoring.approved` is false.
- The five numbers match the global constraints.
- `topicCountingApproved` is false and `highImpact` is false.
- Eight labels, ids listed above, `fallbackTopicId` is `lainnya`, file `approved` is false.
- `topicQuestions` has the eight ids and does not include `lainnya`.

With a policy object that has `approved: true` and those numbers:
- relevance noul 0.35 → bucket `excluded`, relevance `irrelevant`.
- relevance noul 0.50 → bucket `not_sure`.
- relevance 0.90 and sentiment confidence 0.69 → `sentimentUncertain` true and bucket `not_sure` (this is the Belum yakin bucket).
- relevance 0.90, sentiment confidence 0.90, topic noul 0.64 → topics `["lainnya"]`, `topicSource` `"fallback"`.
- the same with topic noul 0.65 → topics are that id only, `topicSource` `"thresholds"`.
- `attentionNegativeConfidenceMin` is 0.85. A negative included mention with confidence 0.84 is not attention-eligible; 0.85 is eligible. Use `attentionDecision`.

Also assert `readMonitorPolicy()` with the repo files still returns `approved: false`, so this commit is inert.

- [ ] **Step 2: Run `npm test --prefix apps/web -- src/monitor/policy.test.ts src/domain/proposed-routing.test.ts` and confirm failure**

- [ ] **Step 3: Implement**

Put the numbers in `policy.ts` as named constants used by `readMonitorPolicy`. Keep `approved` equal to `scoring_policy && topic_labels && topics.approved`. Ignore unknown label fields other than `id`, `label`, and `instructions`. Skip a label that has no id.

- [ ] **Step 4: Re-run the tests until they pass. Run `npm test --prefix apps/web -- src/domain/routing.test.ts src/monitor/monitor.test.ts` too.**

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/monitor/policy.ts apps/web/src/monitor/policy.test.ts apps/web/src/domain/proposed-routing.test.ts config/topic-labels.json docs/settings-proposal.md
git commit -m "$(cat <<'EOF'
feat: propose inert scoring thresholds and topic labels

EOF
)"
```

If `proposed-routing.test.ts` was not created, do not add it.

---

## Task 3: Score pending mentions once

**Files:**
- Create: `apps/web/src/db/sql/008_scoring_worker.sql`
- Modify: `apps/web/src/scoring/jobs.ts`
- Create: `apps/web/src/scoring/run.ts`
- Create: `apps/web/src/scoring/run.test.ts`
- Create: `apps/web/src/scoring/cli.ts`
- Create: `apps/web/src/db/scoring-postgres16.integration.test.ts` only if `POSTGRES_TEST_URL` can exercise two connections; the file must `describe.skipIf` when the variable is unset, same as `postgres16.integration.test.ts`

**Interfaces:**
- Consumes: `postWithRetry`, `parseSystemOne`, `scoreWithFallback`, `buildSystemOneBody`, `TYPESAFE_MODEL`, `primaryTransport` shape, `readMonitorPolicy`, `routeJudgment`, `recordSuccess`, `recordFailure`, `withCustomer`.
- Produces:
  - `claimPendingBatch(db, limit, customerId?: string): Promise<ClaimedMention[]>` where `ClaimedMention` is `{ id, customerId, projectId, excerpt, brandName }`.
  - `scoreUnscoredMentions(db, deps): Promise<{ scored: number; failed: number; skipped: "missing_api_key" | null; decisions: { mentionId: string; bucket: string; relevance: string; topics: string[]; sentimentUncertain: boolean }[] }>`
  - `deps` includes `env`, `log`, `sleep`, `random`, `post`, `limit` (default 5), and `role: "web" | "worker"`. Web role requires `customerId` and uses `withCustomer`. Worker role runs `set local role worker_role` and does not call `withCustomer`.

`008_scoring_worker.sql` grants and policies, and nothing else:

```sql
-- Scoring pass for worker_role. app_user tenant policies are unchanged.
grant select on projects to worker_role;
grant select, insert on jev_results to worker_role;

create policy projects_worker on projects
  for select to worker_role
  using (true);

create policy mentions_worker_read on mentions
  for select to worker_role
  using (true);

create policy mentions_worker_update on mentions
  for update to worker_role
  using (true)
  with check (true);

create policy jev_results_worker_read on jev_results
  for select to worker_role
  using (true);

create policy jev_results_worker_insert on jev_results
  for insert to worker_role
  with check (true);
```

Claim SQL (add `and m.customer_id = $2` only when a customer id is passed):

```sql
update mentions m
set scoring_status = 'scoring'
from (
  select id
  from mentions
  where scoring_status = 'pending'
  order by collected_at asc, id asc
  limit $1
  for update skip locked
) picked
where m.id = picked.id
returning m.id, m.customer_id, m.project_id, m.excerpt
```

Load `brand_name` from `projects` in the same transaction. Commit the claim before any Jev call so the row lock is not held during HTTP.

Save path:
- Build one System One body with `TYPESAFE_MODEL`, the brand name, the excerpt, and `readMonitorPolicy().topicQuestions`.
- Call `scoreWithFallback` with `fallbackEnabled: false`. The primary transport is `postWithRetry` around `deps.post`. The fallback transport throws `fallback_disabled` if called.
- `insert into jev_results ... on conflict (mention_id) do nothing`.
- Then `update mentions set scoring_status = 'succeeded'`.
- Web role performs that insert and update through the existing `recordSuccess` (`withCustomer`). Worker role performs the same insert and update as `worker_role` inside `scoring/jobs.ts`, setting `app.customer_id` with `set_config(..., true)` but not `SET ROLE app_user`.
- A non-retryable Jev error or an invalid payload calls `recordFailure` for web, or the same status update as `worker_role` for worker. No `jev_results` row.
- One failed mention does not stop the rest of the batch.
- Missing or blank `TYPESAFE_API_KEY`: do not claim, do not call `post`, log exactly `scoring skipped: TYPESAFE_API_KEY is not set`, return `skipped: "missing_api_key"`.
- After a successful parse, include the `routeJudgment` decision in `decisions`. Still store the raw judgment when the route is `excluded`.

`cli.ts` reads `WORKER_DATABASE_URL` and `TYPESAFE_API_KEY` and calls `scoreUnscoredMentions` as `worker`. It runs only when executed as the program entry (`import.meta.url` compared with the argv path). Importing it from a test must not connect. If `WORKER_DATABASE_URL` is missing, log `scoring skipped: WORKER_DATABASE_URL is not set` and exit 0. That string is a log line, not a new variable. Do not add an npm script that `next build` would invoke.

- [ ] **Step 1: Write failing tests in `run.test.ts`**

Use PGlite and `applyMigration`, which will load `008` once the file exists. Drive `role: "worker"` as the PGlite superuser so `set local role worker_role` works.
- Two pending mentions are claimed and scored once. A second pass claims nothing and does not call `post`.
- Six pending mentions with `limit: 5` score five; the sixth stays `pending`.
- `post` called once for a duplicate external id that was ingested twice (one mention row).
- Missing key does not change `scoring_status` and the log is the exact sentence. The key value is not in the log.
- A 400 calls `post` once, sets `failed`, writes no `jev_results` row, and the next mention in the batch still scores.
- A 429 then a 200 calls `post` twice and does not call the fallback.
- Relevance 0.35 with the repo policy forced `approved: true` through a test double of `readMonitorPolicy` is stored and the decision relevance is `irrelevant`. Do not delete the mention.
- Sentiment confidence 0.69 on a relevant mention yields `sentimentUncertain: true` and bucket `not_sure`.
- Topic noul 0.64 yields topics `["lainnya"]`. Topic noul 0.65 yields the real topic id. The request body has no `topic_lainnya` question.
- `post` is never called with an `authorization` header containing the key in a way that is then logged. Spy on `log`.
- Web role scores only the given `customerId`. A second customer's pending mention stays `pending`. This path must use `withCustomer` (assert `scoring_status` updates are visible under that customer and not under the other).

For the approved-policy cases, pass the policy in `deps` if `readMonitorPolicy()` is still unapproved in the repo. The default deps read `readMonitorPolicy()`. The test that needs live thresholds passes an override. Do not flip approval flags.

- [ ] **Step 2: Run `npm test --prefix apps/web -- src/scoring/run.test.ts` and confirm failure**

- [ ] **Step 3: Implement migration, claim, save, and `scoreUnscoredMentions`**

- [ ] **Step 4: Add the Postgres 16 concurrency test**

When `POSTGRES_TEST_URL` is set, two connections acting as `worker_role` claim the same five pending rows. The two returned id sets are disjoint and their union is all five. No id is scored twice. Skip the file's suite when the variable is unset.

- [ ] **Step 5: Re-run `src/scoring/run.test.ts` and `src/scoring/jobs.test.ts`**

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/db/sql/008_scoring_worker.sql apps/web/src/scoring apps/web/src/db/scoring-postgres16.integration.test.ts
git commit -m "$(cat <<'EOF'
feat: score each pending mention once through Jev

EOF
)"
```

---

## Task 4: Allow Threads without an approved X budget

**Files:**
- Modify: `apps/worker/sentiment_monitor/collect_once.py`
- Modify: `apps/worker/sentiment_monitor/scheduler.py`
- Create: `apps/worker/tests/test_collection_gate.py`
- Modify: `apps/worker/tests/test_scheduler.py` (autouse token fixture only if existing `serve` tests need it)
- Create: `apps/web/src/monitor/source-availability.test.ts`

**Interfaces:**
- Consumes: `gate(root) -> int`, `serve(...)`.
- Produces: `sources_allowed(root, env) -> set[str]`.

`gate` returns 2 unless `credential-policy.json` has `approved` true and `mode` exactly `shared_operator`. It does not read `x-budget.json`.

`sources_allowed` returns an empty set when `gate` is 2. Otherwise it adds `threads` when `THREADS_ACCESS_TOKEN` is non-blank, and adds `x` only when `x-budget.json` `approved` is true and `X_BEARER_TOKEN` is non-blank.

`serve` intersects each job's sources with `sources_allowed(root, os.environ)`. If the intersection is empty, defer with `sources_unavailable`. Credential rejection still happens first through `decide_job` and `credential_unapproved`.

Threads reserve:
- Both X and Threads selected: keep today's `admit_collection` path.
- Threads only: call `admit_threads_query` before `fetch_threads`. A block defers the job with `threads_budget` and does not call `fetch_threads`.
- X only: call `admit_x_read`, not `admit_collection`, so a Threads query is not reserved.

Existing `serve` tests that approve both files and expect fetches must see tokens. Add an autouse fixture in `test_scheduler.py` that sets `X_BEARER_TOKEN` and `THREADS_ACCESS_TOKEN` to non-secret test values. Tests that delete those variables still win.

- [ ] **Step 1: Write `test_collection_gate.py` with one parametrized case per row**

| credential approved | mode | x budget approved | X token | Threads token | gate | allowed |
| --- | --- | --- | --- | --- | --- | --- |
| false | shared_operator | false | no | no | 2 | empty |
| false | shared_operator | true | yes | yes | 2 | empty |
| false | shared_operator | false | yes | yes | 2 | empty |
| true | per_customer | true | yes | yes | 2 | empty |
| true | shared_operator | false | no | yes | 0 | threads |
| true | shared_operator | false | yes | yes | 0 | threads |
| true | shared_operator | false | no | no | 0 | empty |
| true | shared_operator | false | yes | no | 0 | empty |
| true | shared_operator | true | no | yes | 0 | threads |
| true | shared_operator | true | yes | no | 0 | x |
| true | shared_operator | true | yes | yes | 0 | x and threads |
| true | shared_operator | true | no | no | 0 | empty |
| true | shared_operator | true | blank | blank | 0 | empty |

Blank means the variable is present and whitespace. `yes` means a non-blank value. `no` means unset.

Also one `serve` test: credential approved, x budget unapproved, only `THREADS_ACCESS_TOKEN` set, project sources `["x", "threads"]`. Threads fetch is called, X fetch is not, and the threads count SQL runs before the fetch.

- [ ] **Step 2: Run `pytest apps/worker/tests/test_collection_gate.py` from `apps/worker` with `.venv` and confirm failure**

- [ ] **Step 3: Implement `gate`, `sources_allowed`, and the `serve` filter**

- [ ] **Step 4: Web regression**

`source-availability.test.ts`: with `X_BEARER_TOKEN` unset and `THREADS_ACCESS_TOKEN` set, `sourceCredentials` reports `x: false` and `threads: true`. `sourceStatusLines` for an unconfigured X row is `["Status X: Tidak tersedia"]`. Do not read `x-budget.json` from `sourceCredentials`.

- [ ] **Step 5: Re-run `pytest` for `test_collection_gate.py`, `test_scheduler.py`, `test_x_cost.py`, and `test_config_dir.py`. Re-run the new vitest file.**

- [ ] **Step 6: Commit**

```bash
git add apps/worker/sentiment_monitor/collect_once.py apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_collection_gate.py apps/worker/tests/test_scheduler.py apps/web/src/monitor/source-availability.test.ts
git commit -m "$(cat <<'EOF'
feat: collect Threads without an approved X budget

EOF
)"
```

---

## Task 5: Approve the proposed settings in one commit

**Files:**
- Modify: `config/launch-approvals.json` (`scoring_policy`, `topic_labels`, `topic_counting`, `credential_policy` become true; every other field stays)
- Modify: `config/credential-policy.json` (`approved` becomes true, `mode` stays `shared_operator`)
- Modify: `config/topic-labels.json` (`approved` becomes true; labels and `fallbackId` stay)
- Create: `apps/web/src/monitor/approved-settings.test.ts`
- Modify: `apps/web/src/monitor/policy.test.ts` only for assertions that the repo flags are still false. Move the "flags are false" assertion out, or point it at a fixture. The live-file assertion moves to `approved-settings.test.ts`.

Do not change thresholds, label text, `x-budget.json`, `high_impact`, or `jev_fallback_rule`.

`approved-settings.test.ts` reads the real config files and expects:
- launch flags `scoring_policy`, `topic_labels`, `topic_counting`, `credential_policy` are true
- `high_impact` is false, `jev_fallback_rule` is false, `reduced_source_launch` is null
- `credential-policy.json` is `{ "approved": true, "mode": "shared_operator" }`
- `x-budget.json` is `{ "approved": false }`
- `topic-labels.json` `approved` is true and `fallbackId` is `lainnya`
- `readMonitorPolicy().scoring.approved` is true and the five numbers are unchanged
- `topicCountingApproved` is true and `highImpact` is false

This commit's subject is exactly `Approve proposed scoring/Threads settings (review before merge)`.

- [ ] **Step 1: Write `approved-settings.test.ts` and adjust the old "flags are false" assertion so the suite has one failing test**

- [ ] **Step 2: Run `npm test --prefix apps/web -- src/monitor/approved-settings.test.ts src/monitor/policy.test.ts` and confirm only the new approval expectations fail**

- [ ] **Step 3: Flip only the flags listed above**

- [ ] **Step 4: Re-run those tests**

- [ ] **Step 5: Commit only those files**

```bash
git add config/launch-approvals.json config/credential-policy.json config/topic-labels.json apps/web/src/monitor/approved-settings.test.ts apps/web/src/monitor/policy.test.ts
git commit -m "$(cat <<'EOF'
Approve proposed scoring/Threads settings (review before merge)

EOF
)"
```

---

## Self-review

- Scoring, the Threads gate, and the approval commit are three deliverables. Tasks 1–2 are dependencies of scoring and the doc. No task is a placeholder.
- The final commit is the only place flags change, so checking out the parent of that commit leaves collection and classification inert.
- Type names match existing `ScoringPolicy`, `routeJudgment`, and `withCustomer`.
- `008` is the only schema change. Deploy order is: existing `001`–`007` stay applied; run the web migrator so it applies `008_scoring_worker.sql` once; then deploy web and worker code. The scorer CLI is not started by either process.
