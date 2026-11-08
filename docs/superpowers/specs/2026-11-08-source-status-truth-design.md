# Truthful Source Status and Explicit Provider Error Handling

**Date:** 2026-11-08
**Status:** Proposed — user review gate
**Scope:** design only; no application code, migration, or test changes in this session

## 1. Intent and Why

The product currently tells the owner that a configured source is unavailable before the
worker has ever tried it, and it can mark a source "ready" without evidence. It also
cannot reliably tell a provider failure apart from a genuinely empty search, and it
records only one fetched count without saying how many posts were returned, parsed,
deduplicated, or actually saved.

The result is misleading status copy and weak incident evidence. This design makes
source status truthful (configured-but-untested, working, failed), makes ScrapeCreators
failures explicit and safe to log, and gives the worker permission to write
`source_status` without weakening tenant isolation. Collection and scoring remain
separate: collection alone does not produce sentiment.

## 2. Current State (Evidence)

### 2.1 Database

- `apps/web/src/db/sql/001_init.sql:96` defines `source_status` with primary key
  `(customer_id, project_id, source)`.
- `apps/web/src/db/sql/001_init.sql:100` constrains `state` to
  `ready | unavailable | authorization_failed | rate_limited`.
- `apps/web/src/db/sql/001_init.sql:134` grants all DML on every table to `app_user`.
  `worker_role` gets no `source_status` grant in `001`, `002`, `007`, or `008`.
- `apps/web/src/db/sql/001_init.sql:146-152` enables and forces RLS on
  `source_status` with the tenant policy
  `customer_id = current_setting('app.customer_id', true)::uuid`.
- `apps/web/src/db/sql/009_scrapecreators_sources.sql:5-7` expands the source check to
  `x | threads | instagram | tiktok`. Migration `009` is the highest-numbered file, so
  the next migration is `010`.
- `apps/web/src/db/production-migrate.mjs` applies `.sql` files in byte order and
  rejects a changed checksum for an already-applied file. Existing migrations must stay
  byte-identical.

### 2.2 Web status derivation and copy

- `apps/web/src/monitor/load.ts:306` currently does
  `!configured ? "unavailable" : (row?.state ?? "unavailable")`. A configured source
  with no status row is therefore shown as unavailable.
- `apps/web/src/monitor/load.ts:120-125` `selectedSourcesReady` already treats a source
  as runnable when it is configured, regardless of a recorded failure. The server-side
  manual-run gate in `apps/web/src/projects/schedules.ts` also checks credentials, not
  status rows.
- `apps/web/src/monitor/load.ts:404` sets dashboard `partial` to `state !== "ready"`;
  once an "untested" state exists this would incorrectly mark a never-tested project as
  partial.
- Source copy is spread across `sourceStatusLines` in
  `apps/web/src/monitor/source-status.ts`, `sourceHealthCopy` in
  `apps/web/src/monitor/load.ts`, the collection cards in
  `apps/web/src/components/monitor/collection-view.tsx`, and the label maps in
  `apps/web/src/components/source-status-list.tsx` and
  `apps/web/src/projects/dashboard-status.ts`.

### 2.3 Worker collection and status

- `apps/worker/sentiment_monitor/scheduler.py:243` defines `record_source_failure`, but
  `serve` never calls it. A provider failure currently marks only the job failed.
- `apps/worker/sentiment_monitor/scheduler.py:540-549` catches every exception, derives
  a job detail with `_failure_detail`, and calls `_fail`. This path cannot distinguish a
  provider failure from a database/storage failure.
- `apps/worker/sentiment_monitor/scheduler.py:479-521` stores mentions/cursor in one
  `_call`, but there is no success status write in the current branch.
- `apps/worker/sentiment_monitor/pg_store.py:61-118` writes mentions and the cursor in
  one transaction. `record_source_success` refuses to run outside that transaction.
- `apps/worker/sentiment_monitor/sources/scrapecreators.py:13-34` parses JSON and returns
  any dict. It does not validate `success: false`, malformed JSON, non-dict envelopes,
  or missing recognized post lists. Non-2xx responses surface as raw `HTTPError`.
- `apps/worker/sentiment_monitor/sources/threads.py:84-94`,
  `instagram.py:94-130`, and `tiktok.py:51-91` use `payload.get(...) or []`, which
  conflates "key missing" with "list present but empty". They also deduplicate without
  reporting how many entries were removed.
- `apps/worker/sentiment_monitor/collect_once.py:24-36` decides which sources are
  allowed from credentials; it does not test them.

### 2.4 Reference commit

Commit `8d21398` on branch `fix/source-status-ready` changed the web default from
`unavailable` to `ready` and added a worker `record_source_success` write. It is useful
as a warning, not a template:

- It marks a configured but never-tested source ready, which is not truthful.
- It writes `source_status` as `worker_role` without any grant or policy, so the write
  would fail in production.
- It does not distinguish provider failures from storage failures.

## 3. Goals, Non-Goals, and Anti-Goals

### Goals

1. Show three truthful outcomes for a configured source: **untested** (no row yet),
   **working** (last success), and **failed** (auth/rate/unavailable).
2. Never show a configured source as unavailable merely because it has no status row.
3. Never mark an untested source ready.
4. Treat explicit ScrapeCreators failures (`success: false`, non-2xx, malformed JSON,
   malformed envelope, missing post list) as failures with safe detail codes.
5. Distinguish a successful empty result from a failure.
6. Record returned, parsed, deduplicated, and saved counts separately.
7. Log safe telemetry correlated by job id, project id, and source; never log keywords,
   post content, or secrets.
8. Let `worker_role` write `source_status` via a narrowly scoped migration.
9. Preserve the provider root cause even when status bookkeeping fails, and keep
   mentions plus cursor atomic.

### Non-Goals

- Quotas, credit limits, or new rate-cap logic.
- Changing default sources or onboarding selection.
- Scoring behavior or making collection populate sentiment.
- Enabling X or changing X collection.
- Persisting a new source-status history table.
- Refactoring unrelated monitor or dashboard code.

### Anti-Goals (failure even if technically working)

- A configured source shown as "Tidak tersedia" before its first test.
- A source marked "Siap" without a recorded successful collection.
- A provider failure that looks like zero mentions.
- A status write failure that changes the job's provider error into a database error.
- A migration that lets `app_user` see another tenant's status rows.

## 4. Constraints

- Migrations `001` through `009` remain byte-identical. All schema/permission changes
  go in `010_source_status_worker.sql`.
- `source_status` keeps its four-state database check in this design; "untested" is a
  derived UI state, not a new enum value.
- The worker must remain able to process all tenants; app-user tenant policies must not
  change.
- No network or provider calls in tests. No `.env` reads and no secrets in fixtures,
  logs, or assertions.
- Real database tests use `POSTGRES_TEST_URL` and explicit non-superuser logins; they
  do not depend on `DATABASE_URL` or `WORKER_DATABASE_URL`.
- The spec only describes changes; implementation follows after approval.

## 5. Approaches Considered

### A. Source status representation

1. **Add `untested` to the database enum and write a row at configuration time.**
   Most explicit, but requires changing the check constraint, backfilling every
   project/source, and teaching the worker to write an "untested" row. It also makes a
   row exist before any real test, which is easy to misinterpret.
2. **Derive `untested` in the web layer for configured sources with no row.** No enum
   change, no backfill, no new write, and old rows keep working. Chosen.
3. **Keep the current default and only change copy.** This does not distinguish
   untested from failed and leaves incorrect status data. Rejected.

**Chosen: option 2.** It is backward compatible: existing `ready`/failure rows are
unchanged, and "no row" becomes an honest "not yet tested" instead of a false
"unavailable". A future migration can still promote `untested` into the database if
history becomes necessary.

### B. Provider error handling

1. **Validate in the scheduler and use the provider's message as the detail.** Simple,
   but a provider message can contain a keyword, post text, or request detail. Rejected.
2. **Validate in the shared ScrapeCreators helper, raise a typed error with a safe
   code, and let each source validate its own list shape.** Chosen.
3. **Return an `ok` flag from every source and keep exceptions for transport errors.**
   Workable, but it creates two error paths and makes the scheduler inspect result
   dictionaries. Rejected for consistency with the existing exception-based flow.

**Chosen: option 2.** The fetch boundary owns provider validation and produces a safe
detail/state; the scheduler owns status bookkeeping and cannot leak provider text.

### C. Worker status write permissions

1. **Grant all on `source_status` and add a `for all` worker policy.** Works, but grants
   more than the worker needs (including delete).
2. **Grant only `select, insert, update` and add separate select/insert/update worker
   policies.** Chosen. No delete, no change to `app_user` policies.
3. **Tenant-scope the worker policy and set `app.customer_id` on every status write.**
   Slightly stricter, but inconsistent with the existing trusted-worker model for
   `jobs`, `source_cursors`, and `mentions`, and adds a failure mode where a missing
   setting hides status writes. Rejected.

**Chosen: option 2.** `worker_role` is already a trusted cross-tenant role in this
schema. The change adds access only to `source_status` and only the DML needed for
upserts. `app_user` exposure is untouched.

### D. Status write failure isolation

1. **Write status on the same connection/transaction as mentions and cursor.** A status
   failure would roll back collected data and could replace the provider error. Rejected.
2. **Write status in a separate `_call` after the mention transaction commits.**
   Preserves mention+cursor atomicity and lets the provider detail survive status
   bookkeeping failures. Chosen.

## 6. Design

### 6.1 Truthful status model and UI mapping

Keep the database `state` check unchanged. Derive a UI-only `untested` state in
`loadWorkspace`:

| Configured? | `source_status` row | UI state | Meaning |
|---|---|---|---|
| No | any/none | `unavailable` | No credential; the operator cannot collect. |
| Yes | none | `untested` | Configured, never attempted; not a failure. |
| Yes | `ready` | `ready` | Last known successful collection. |
| Yes | `authorization_failed` | `authorization_failed` | Provider rejected access. |
| Yes | `rate_limited` | `rate_limited` | Provider/credit limit. |
| Yes | `unavailable` | `unavailable` | Other recorded provider failure. |

Implementation shape:

- Extend `SourceHealth["state"]` with `"untested"` and add a pure resolver such as
  `resolveSourceState(configured, rowState)` so it can be unit tested.
- `lastSuccessAt` continues to come from `source_status.last_success_at`.
- `detail` stays empty for `untested`.

Indonesian copy:

- `untested`: `Status <Nama>: Belum diuji`
- `untested` card: `Sumber <Nama> sudah dikonfigurasi dan belum diuji. Pengumpulan berikutnya akan menguji aksesnya.`
- `ready`: `Siap` (unchanged)
- failure states keep their existing copy, but only when the state is actually recorded
  or the source is unconfigured. A configured source is never collapsed to
  "Tidak tersedia" merely because it has no row.

Update these surfaces so the mapping is consistent:

- `apps/web/src/monitor/load.ts` (`SourceHealth`, `SOURCE_COPY`, `sourceHealthCopy`,
  `loadWorkspace`, `dashboardFor`)
- `apps/web/src/monitor/source-status.ts` (`sourceStatusLines`)
- `apps/web/src/components/monitor/collection-view.tsx` (card copy/last success)
- `apps/web/src/components/source-status-list.tsx` (state labels)
- `apps/web/src/projects/dashboard-status.ts` (only if a state label map is used)
- Fixtures/tests that build `SourceHealth` values

`selectedSourcesReady` keeps its current operational meaning: "at least one selected
source is configured", because that is what the manual-run server gate checks. It must
not require `ready`, otherwise an untested or temporarily failing source would disable a
run that the server would accept. Its name may remain for compatibility.

`dashboardFor.partial` should become true only for a recorded failure state
(`unavailable`, `authorization_failed`, `rate_limited`) or an unconfigured source, not
for `ready` or `untested`. This avoids calling a never-tested project partial.

### 6.2 Explicit ScrapeCreators envelope validation

Add a small typed exception in `apps/worker/sentiment_monitor/sources/scrapecreators.py`:

```python
class ScrapeCreatorsError(Exception):
    code: str                 # safe snake_case code, never provider text
    http_status: int | None   # authoritative HTTP status when known
    credits_charged: int | None
```

Safe codes:

| Condition | Code | State |
|---|---|---|
| HTTP non-2xx | `http_<status>` | 401/403 auth; 402/429 rate; else unavailable |
| Body is not valid JSON | `malformed_json` | unavailable |
| Body is not a JSON object | `malformed_envelope` | unavailable |
| Object contains `success: false` | `success_false` | unavailable |
| Expected post key is absent | `missing_posts` | unavailable |
| Expected key is present but not a list | `malformed_posts` | unavailable |
| Non-empty list with no usable objects | `malformed_posts` | unavailable |

Rules:

- The shared helper checks JSON validity, dictionary shape, and explicit
  `success is false`. It does not require `success: true`; absence is tolerated because
  existing Instagram/TikTok fixtures omit it.
- HTTP errors from the ScrapeCreators helper become `ScrapeCreatorsError("http_<code>",
  http_status=<code>)`. X keeps its existing `HTTPError` path.
- Each source validates its own list keys. The first present key wins:
  - Threads: `posts`, `items`, `data`
  - Instagram reels: `reels`, `items`, `data`
  - Instagram hashtag: `posts`, `items`, `medias`, `data`
  - TikTok (both endpoints): `search_item_list`, `aweme_list`, `items`, `data`
- A present-but-empty list is a **successful empty**, not a failure. A missing key is a
  failure.
- Provider messages/reasons are never copied into `detail`, logs, or job status. Only
  the safe code is used.

Extend `_failure_detail` in `scheduler.py`:

- `ScrapeCreatorsError`: return `<source>_<code>` (for example
  `threads_success_false`, `instagram_malformed_json`,
  `tiktok_missing_posts`, `instagram_http_402`).
- Existing `HTTPError` handling remains for X and direct tests:
  `x_http_<code>` / `<source>_http_<code>`.
- Unknown errors remain `collection_failed`.

Replace the fragile substring classification in `record_source_failure` with an explicit
state argument or a deterministic map from the safe detail/status. Substring checks such
as `"402" in detail` must not be applied to arbitrary provider text.

Threads keeps its existing `empty_unconfirmed` outcome when the recognized list is empty
because an empty result can also mean a masked/sensitive query. It is still a provider
success and should update `last_success_at`; Instagram and TikTok empty results are
`success`.

### 6.3 Counts and telemetry

Define counts at the source boundary and carry them through the fetch result:

| Count | Definition |
|---|---|
| `returned` | Sum of raw entries in every recognized provider list, before filtering or normalization. For multi-call sources, sum across calls. |
| `parsed` | Number of normalized mention objects produced from raw entries, before deduplication. |
| `deduplicated` | Number of entries removed by `dedupe_mentions` (`parsed - unique`). |
| `saved` | Number of rows actually inserted by the mention write; rows skipped by `on conflict do nothing` are not saved. |

Implementation shape:

- Each source returns `mentions`, `outcome`, and a `counts` object
  (`returned`, `parsed`, `deduplicated`).
- `_unpack_fetched` preserves counts and defaults them sensibly for legacy/fake results
  (for example `returned = parsed = len(raw_mentions)`, `deduplicated = 0`).
- `PostgresStore.write_mentions_and_cursor` returns `saved` by counting rows returned
  from `insert ... on conflict do nothing returning id`. The cursor/mention transaction
  still commits atomically. If a driver returns no rows, saved is `0`, never guessed
  from `parsed`.
- `store_source` returns the saved count to `serve`.

Structured log line, emitted per source attempt:

```text
source_collection job_id=<id> project_id=<id> source=<source> outcome=<success|failed|storage_failed>
returned=<n> parsed=<n> deduplicated=<n> saved=<n>
http_status=<n|-> credits_charged=<n|-> detail=<safe_code>
```

Rules:

- Use the existing `format_log` redaction path.
- Never include the keyword/variant, post excerpt, URL, author, request URL, headers, or
  API key.
- `detail` is always a safe code, never a provider message.
- Emit a separate safe log line when status bookkeeping fails:
  `source_status_write_failed job_id=... project_id=... source=... error=<class/safe text>`.
- Correlate by `job_id`, `project_id`, and `source`. Do not add customer data to the log
  fields beyond what the job already carries.

### 6.4 Worker status writes, failure isolation, and atomicity

Introduce a fetch/storage boundary so provider failures are distinguishable from
database failures:

1. **Fetch guard.** Wrap each provider call in a helper that catches fetch exceptions
   and raises a `SourceFetchError` carrying the safe `detail`, derived `state`,
   `http_status`, and `credits_charged`. JSON/envelope errors are already typed; X
   errors are mapped by the existing `_failure_detail`. This guard runs only around
   fetching, not around database writes.
2. **Provider failure path.** In `serve`'s catch, if the error is a `SourceFetchError`:
   - compute/retain the provider detail before any bookkeeping;
   - attempt `record_source_failure(conn, customer_id, project_id, source, detail,
     state)` in its own `_call`;
   - catch and log any status-write error separately;
   - then call `_fail(job_id, detail)` with the provider detail.
   A storage/database error is not a source failure: log it, fail the job with a
   storage-safe detail, and do not write `source_status`.
3. **Success path.** After `store_source` commits mentions and cursor, attempt
   `record_source_success` in its own `_call`. This writes:
   - `state = 'ready'`
   - `detail = 'ok'`
   - `last_success_at = now()`
   - `updated_at = now()`
   If the status write fails, log `source_status_write_failed` and continue; the job
   still succeeds and the mentions/cursor remain committed. A later run can refresh the
   status.
4. **Failure write shape.** `record_source_failure` upserts `state`, `detail`, and
   `updated_at`; it must not clear or overwrite `last_success_at`. This preserves the
   last working timestamp while showing the current failure.
5. **Atomicity.** Mentions and cursor stay in the existing single transaction. Status
   bookkeeping never joins that transaction and never causes a rollback of collected
   data.
6. **No false success.** A source is marked ready only after a provider success and a
   successful mention/cursor commit. If storage fails, the previous status remains.

The per-source status key has no variant dimension. Because the current loop aborts the
job on the first source exception, the last write for that source reflects the event
that ended processing. No per-variant aggregation is introduced in this scope.

### 6.5 Migration `010_source_status_worker.sql`

Verified next number: `009` is the highest existing migration.

```sql
-- Allow worker_role to upsert source health. app_user policies are unchanged.
-- No delete grant is added.
grant select, insert, update on source_status to worker_role;

create policy source_status_worker_select on source_status
  for select to worker_role using (true);

create policy source_status_worker_insert on source_status
  for insert to worker_role with check (true);

create policy source_status_worker_update on source_status
  for update to worker_role using (true) with check (true);
```

Rationale:

- An upsert (`insert ... on conflict do update`) needs insert, update, and select
  privileges, plus a policy that admits the row. Separate policies avoid accidentally
  allowing delete if a future grant is added.
- `worker_role` is already a trusted cross-tenant role for jobs, cursors, and mentions.
  This policy exposes only `source_status` to it and does not change `app_user` RLS.
- The migration is additive and does not modify existing rows or constraints.
- `010` must be added after `009`; do not edit `001`–`009`.

### 6.6 Testing plan

#### Web unit tests (no network, PGlite or pure functions)

- `resolveSourceState`: unconfigured → unavailable; configured + no row → untested;
  configured + each recorded state → same state.
- `loadWorkspace`: configured X with no row is untested, not unavailable; a recorded
  Threads failure stays failed with detail; last success survives a failure.
- Copy: untested string appears for a configured, never-tested source; "Tidak tersedia"
  does not appear for it.
- `sourceStatusLines` and `source-status-list` label mapping, including untested.
- `selectedSourcesReady`: untested counts as runnable; all-unconfigured does not.
- `dashboardFor.partial`: false for ready/untested, true for recorded failure.
- Existing tenant isolation tests continue to pass; no app_user policy change.

#### Worker unit tests (mocked, no network)

- Envelope validation with `io.StringIO` openers:
  - explicit `success: false` → `success_false`;
  - invalid JSON → `malformed_json`;
  - non-object JSON → `malformed_envelope`;
  - missing recognized post key → `missing_posts`;
  - present empty list → success with zero counts;
  - non-list/malformed list → `malformed_posts`;
  - non-2xx → `http_<status>` with the right state.
- Per-source list-key tables for Threads, Instagram reels/hashtag, and TikTok.
- Counts: returned, parsed, deduplicated, and saved are distinct; multi-endpoint
  aggregation works; saved is not inferred from parsed.
- `_failure_detail` returns `<source>_<safe_code>` and never includes provider text,
  URL, keyword, or secret.
- `record_source_failure` upsert preserves `last_success_at` and uses explicit state.
- `record_source_success` upsert writes ready, detail `ok`, and timestamps.
- `serve` with scripted connections:
  - provider success writes ready;
  - provider failure writes the failure and fails the job with the same detail;
  - status write failure does not change the job's provider detail and does not roll
    back mentions/cursor;
  - storage failure does not write a source failure;
  - successful empty marks a source ready (Threads keeps `empty_unconfirmed` outcome).
- Log assertions: fields include job/project/source and counts; keyword, post text,
  secrets, and provider messages are absent.

#### Real disposable Postgres 16 regression tests (non-superuser)

Extend the existing real-Postgres suite (for example
`apps/web/src/db/postgres16.integration.test.ts`, which already uses
`POSTGRES_TEST_URL` and role logins) or add an equivalent worker pytest suite. Use a
disposable database and disposable `app_user`/`worker_role` logins with
`NOSUPERUSER NOBYPASSRLS LOGIN`; skip when `POSTGRES_TEST_URL` is absent.

Assertions:

- Apply all migrations including `010`; `schema_migrations` contains `010` with the
  expected checksum.
- `has_table_privilege('worker_role', 'public.source_status', ...)` is true for
  select/insert/update and false for delete. `app_user` grants are unchanged.
- The worker policies exist for select/insert/update; no worker delete policy.
- Connect as `worker_role`, insert and update `source_status` for two different
  customers (upsert), and read both. Delete is rejected with insufficient privilege.
- Connect as `app_user` with `app.customer_id` set to customer A: only customer A's
  rows are visible, and customer B's rows are not. Verify the role is non-superuser and
  does not bypass RLS.
- Confirm the migration does not widen any table besides `source_status`.

#### Explicitly not tested here

- Scoring/sentiment behavior. Collection-alone is not expected to populate sentiment.
- Provider live calls, credit charging, or quota behavior.

## 7. Decisions Resolved From the Code

1. **No database enum change.** "Untested" is derived as configured + no `source_status`
   row. This is backward compatible and avoids backfills.
2. **Migration number is `010`.** `009` is the latest; prior files remain immutable.
3. **Worker gets select/insert/update only.** No delete. Separate policies are narrower
   than a `for all` policy.
4. **Worker status writes are separate from the mention/cursor transaction.** Provider
   detail survives bookkeeping failure; mentions/cursor stay atomic.
5. **Provider failures and storage failures are different.** Only fetch-boundary errors
   update `source_status`; database errors do not.
6. **Failure updates keep `last_success_at`.** A failure shows current state without
   erasing the last working timestamp.
7. **A source is marked ready only after a successful provider response and a successful
   mention/cursor commit.** An empty successful response is still ready; Threads keeps
   its `empty_unconfirmed` outcome.
8. **Safe codes only.** Provider text, keywords, post content, URLs, and secrets never
   enter `source_status.detail` or logs.
9. **Counts are log-only in this scope.** `collection_runs` is not modified; the four
   counts are emitted in structured logs.
10. **`selectedSourcesReady` keeps credential-based semantics.** Untested sources remain
    runnable; status failure does not disable the manual run.
11. **`dashboardFor.partial` means recorded failure, not untested.**

## 8. What Is Left to the Builder

- Implement the pure state resolver and update every `SourceHealth` consumer listed in
  §6.1, including label maps and fixtures.
- Implement `ScrapeCreatorsError`, envelope/list validation, and the safe detail mapping.
- Extend source return values with counts and make the mention write return `saved`.
- Wire provider failure/success status writes into `serve` with isolated error handling.
- Add `010_source_status_worker.sql` exactly as scoped and make no edits to `001`–`009`.
- Add the unit and real-Postgres tests described in §6.6.
- Run the existing lint/typecheck/test commands from the repo after implementation.

## 9. Open Material Choices

1. **Exact `credits_charged` field name/shape in ScrapeCreators responses.** This design
   reads a numeric top-level `credits_charged` when present and otherwise logs `-`.
   If the provider uses a different field (for example nested credits or a different
   spelling), telemetry will omit it until a captured fixture or provider documentation
   confirms the name. No provider call is made in this session.
2. **Whether counts should eventually be persisted for audit.** This design logs
   returned/parsed/deduplicated/saved but does not add columns to `collection_runs`.
   Persisting them would require a separate schema decision and retention policy.

## 10. Acceptance Criteria

- A configured source with no row renders "Belum diuji", never "Tidak tersedia", and is
  not marked ready.
- A source with a success row and `last_success_at` renders working; a recorded failure
  renders the correct failure copy and preserves the prior last-success timestamp.
- `success:false`, non-2xx, malformed JSON, malformed envelope, missing post lists, and
  malformed post lists fail the job with safe detail codes; a present empty list is a
  success.
- Logs contain job id, project id, source, four distinct counts, HTTP status when known,
  and credits when safely available; they contain no keyword, post content, or secret.
- `worker_role` can upsert/read `source_status`; cannot delete it; `app_user` tenant
  isolation is unchanged.
- A status-write failure is logged without changing the provider root cause or rolling
  back mentions/cursor.
- All unit tests and the real disposable non-superuser Postgres 16 regression tests pass.
