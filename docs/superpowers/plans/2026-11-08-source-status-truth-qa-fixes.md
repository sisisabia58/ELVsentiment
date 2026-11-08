# Source Status Truth QA Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the independent QA P1/P2/P3 findings on top of `a2ae7a1` without widening the approved spec.

**Architecture:** Validate every ScrapeCreators endpoint list independently before aggregation, carry known counts/credits/http status on failure, replace the regex error-label filter with fixed allowlists, and emit a single structured status-write log. Web behavior, migrations, RLS, and provider calls are unchanged.

**Tech Stack:** Python 3.12, pytest, psycopg 3, urllib; TypeScript, Next.js 16, Vitest; PostgreSQL 16.

**Spec:** `docs/superpowers/specs/2026-11-08-source-status-truth-design.md`

**QA evidence:** `.tooling/qa-report-a2ae7a1.txt`, `.tooling/qa-probe.py`

## Global Constraints

- Migrations `001` through `010` stay byte-identical.
- No network/provider calls; no `.env` reads; never set/use `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SCRAPECREATORS_API_KEY`, `THREADS_ACCESS_TOKEN`, `TYPESAFE_API_KEY`, `JEV_API_KEY`, `X_BEARER_TOKEN`, `OPENROUTER_API_KEY`.
- No sudo, no system directories; temporary files only under `.tooling/`; never commit `.tooling`.
- Do not push. Never log keywords, post text, URLs, authors, secrets, or raw provider text.
- Keep legitimate `[]` responses successful and keep documented alternative list keys.
- Known counts/credits are carried on failure; unknown values stay `-`, never `0`.
- `saved` is only committed insertions; a rolled-back storage write logs `saved=0` and `outcome=storage_failed`.
- Status-write failure keeps the provider root cause and mention+cursor atomicity.
- `app_user` RLS, worker delete denial, migration `010` grants, saved/dedup, and mention+cursor rollback must remain passing.

## Review Focus

- Non-empty list of unusable objects (`[{}]`) on one endpoint must fail even when another endpoint has valid posts.
- A present empty list must remain a successful empty result for Threads, Instagram, and TikTok.
- Unknown error detail or class must never reach stdout or structured logs; only fixed allowlisted tokens survive.
- A storage failure after a successful fetch must log the real returned/parsed/deduplicated/credits, `saved=0`, `outcome=storage_failed`.
- A later-endpoint failure must log earlier known counts/credits and the HTTP status once, without double counting credits.
- One status-write failure must produce exactly one `source_status_write_failed` structured line, not a second generic line.

---

### Task 1: Validate each endpoint list independently (P1)

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py:90-137`
- Modify: `apps/worker/sentiment_monitor/sources/tiktok.py:54-104`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py:80-105`
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py:14-46`
- Test: `apps/worker/tests/test_instagram_source.py`
- Test: `apps/worker/tests/test_tiktok_source.py`
- Test: `apps/worker/tests/test_threads_source.py`

**Interfaces:**
- Produces: `ScrapeCreatorsError(code, *, http_status=None, credits_charged=None, counts: dict[str, int] | None = None)`.
- Produces: each source raises `ScrapeCreatorsError("malformed_posts", credits_charged=<known sum>, counts=<known returned/parsed/deduplicated>)` when a non-empty endpoint list normalizes to zero ID-bearing mentions.
- Consumes: existing `select_post_list`, `credits_from`, `dedupe_mentions`.

- [ ] **Step 1: Write failing tests**

Tests already added in the working tree:
`test_instagram_wholly_unusable_reels_list_fails_even_when_hashtag_has_posts`,
`test_instagram_wholly_unusable_hashtag_list_fails_even_when_reels_has_posts`,
`test_tiktok_wholly_unusable_keyword_list_fails_even_when_top_has_posts`,
`test_tiktok_wholly_unusable_top_list_fails_even_when_keyword_has_posts`,
`test_threads_unusable_list_failure_carries_known_credits`.

- [ ] **Step 2: Verify RED**

Run: `env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py apps/worker/tests/test_threads_source.py`
Expected: 6 failures; unusable masked lists accepted or credits `None`.

- [ ] **Step 3: Implement per-endpoint validation**

For each endpoint: keep its own raw list, normalized items, known credits, and counts. After normalizing, if the raw list is non-empty and no normalized item has a non-empty `external_id`, raise `malformed_posts` immediately with the accumulated known credits and counts. Empty `[]` stays successful. Threads annotates `credits_charged` on its existing guard.

- [ ] **Step 4: Verify GREEN**

Run the same command. Expected: all pass, including existing empty-list and alternative-key cases.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/sources apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py apps/worker/tests/test_threads_source.py
git commit -m "fix(worker): validate each ScrapeCreators endpoint list"
```

---

### Task 2: Replace regex error filter with fixed allowlists (P2a)

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py:209-223`
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Produces: `_safe_error_label(error: Exception) -> str` composed only of an allowlisted class label and an allowlisted detail code; unknown detail -> `other`, unknown class -> `Exception`.
- Allowlisted codes: `success_false`, `malformed_json`, `malformed_envelope`, `missing_posts`, `malformed_posts`, `collection_failed`, `storage_failed`, `sources_unavailable`, `credential_unapproved`, `claim_expired`, `skipped_overlap`, `schedule_min_interval_hours`, `unknown_error`, `other`, `ok`, and `http_<three digits>`; source-prefixed `x|threads|instagram|tiktok` variants.
- Allowlisted classes: `Exception`, `RuntimeError`, `ValueError`, `TypeError`, `KeyError`, `OSError`, `ScrapeCreatorsError`, `SourceFetchError`, `HTTPError`.
- Label length bounded to 64 characters.

- [ ] **Step 1: Write failing test**

`test_safe_error_label_uses_fixed_allowlists_and_bounds_length` (already added) asserts tokens `private_keyword`, `this_is_private_post_text`, `abc123`, and 500 `a`s never appear; known safe codes survive; unknown class becomes `Exception`.

- [ ] **Step 2: Verify RED**

Run: `env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scheduler.py::test_safe_error_label_uses_fixed_allowlists_and_bounds_length`
Expected: FAIL because lowercase tokens are accepted.

- [ ] **Step 3: Implement allowlists**

Read `detail` or `code`; return `<safe class> <safe code>`, using `other` for anything not in the fixed sets. Remove the regex syntax filter. Truncate the final label to 64 characters.

- [ ] **Step 4: Verify GREEN and update old expectations**

Update `test_failed_status_update_is_redacted_and_the_loop_continues` and `test_safe_error_label_never_prints_raw_provider_text` from `unknown_error` to `other`. Run the scheduler tests. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py
git commit -m "fix(worker): allowlist safe error labels"
```

---

### Task 3: Preserve failure telemetry counts and credits (P2b)

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py` (`ScrapeCreatorsError.counts`)
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py`
- Modify: `apps/worker/sentiment_monitor/sources/tiktok.py`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py`
- Modify: `apps/worker/sentiment_monitor/scheduler.py:443-480, 532-777`
- Test: `apps/worker/tests/test_instagram_source.py`
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Extends: `SourceFetchError(detail, state, *, http_status=None, credits_charged=None, counts: dict[str, int] | None = None)`.
- Produces: `serve` logs on failure `returned/parsed/deduplicated` from known attempt metadata, `saved=0`, known `credits_charged` and `http_status`; unknown stays `-`.
- Storage failure after a successful fetch logs the unpacked counts and credits with `outcome=storage_failed`.
- Partial multi-endpoint failure logs earlier endpoint counts/credits plus the failing endpoint's HTTP status.

- [ ] **Step 1: Write failing tests**

Already added: `test_storage_failure_preserves_fetch_counts_and_credits`,
`test_malformed_failure_logs_known_credits_and_counts`,
`test_partial_multi_endpoint_failure_logs_known_counts_credits_and_status`,
`test_instagram_partial_failure_keeps_first_endpoint_counts_and_credits`.

- [ ] **Step 2: Verify RED**

Run the scheduler and Instagram tests. Expected: 6 failures showing zeroed counts, `credits_charged=-`, or missing `counts`.

- [ ] **Step 3: Implement carry-through**

Sources accumulate known counts/credits per endpoint and attach them to any raised `ScrapeCreatorsError`. `_guarded_fetch` copies `counts` into `SourceFetchError`. `serve` tracks the last unpacked counts/credits/http status per attempt; use them in the `SourceFetchError` branch and in the non-fetch storage branch (`saved=0`, `outcome=storage_failed`). Do not double-add credits.

- [ ] **Step 4: Verify GREEN**

Run the full worker unit suite. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor apps/worker/tests/test_instagram_source.py apps/worker/tests/test_scheduler.py
git commit -m "fix(worker): carry known counts and credits on failures"
```

---

### Task 4: Emit one safe status-write failure log (P3)

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py:369-380, 513-522, 730-777`
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Produces: `_call(connect, fn, *, log_error: bool = True)`.
- Status-write calls (`record_source_success`, `record_source_failure`) use `log_error=False`; their outer handlers emit exactly one `source_status_write_failed` line.

- [ ] **Step 1: Write failing tests**

Already added: `test_status_write_failure_logs_one_safe_structured_line`,
`test_status_write_failure_on_provider_failure_logs_one_structured_line`.

- [ ] **Step 2: Verify RED**

Run both tests. Expected: FAIL because stdout contains `Exception private_keyword` / `RuntimeError private_keyword` in addition to the structured line.

- [ ] **Step 3: Implement single-report path**

Add `log_error` to `_call`; pass `False` for status-write calls. Keep `_log_exception` for unrelated DB errors. Keep provider detail and atomicity unchanged.

- [ ] **Step 4: Verify GREEN**

Run the scheduler tests. Expected: all pass; one structured line, empty stdout/stderr.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py
git commit -m "fix(worker): log one safe status-write failure"
```

---

### Task 5: Optional test-only Postgres log path override (P3 pre-existing)

**Files:**
- Modify: `apps/web/src/db/postgres16.integration.test.ts:283-292`

**Interfaces:**
- Produces: `const logPath = process.env.POSTGRES_TEST_LOG_PATH ?? "/var/log/postgresql/postgresql-16-main.log";`
- Default behavior is unchanged; no system path is created.

- [ ] **Step 1: Apply the minimal override**

Only the test reads the environment variable. No application or production code changes.

- [ ] **Step 2: Verify default and override are safe**

Run the web unit suite (integration skips without `POSTGRES_TEST_URL`). If a disposable PG log is available, run the two PG integration files with `POSTGRES_TEST_LOG_PATH` pointing inside `.tooling/`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/db/postgres16.integration.test.ts
git commit -m "test(web): allow optional Postgres log path override"
```

---

### Task 6: Full verification

**Files:** none.

- [ ] **Step 1: Worker unit tests**

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests
```

Expected: all pass, no failures.

- [ ] **Step 2: Worker with disposable PG16**

Follow `.tooling/README-tooling.txt`; use port `55451` and no skips. Expected: same count with zero skips/failures.

- [ ] **Step 3: Web**

```bash
cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run
npm run typecheck
npm run lint
npm run build
```

Expected: tests pass, typecheck/lint/build exit 0.

- [ ] **Step 4: QA probe**

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python .tooling/qa-probe.py
```

Expected: unusable Instagram/TikTok lists FAILED with known credits; safe labels never leak; storage failure logs 3/2/1 `saved=0` `credits_charged=4`; one structured status line.

- [ ] **Step 5: Stop Postgres and report**

Stop the disposable cluster; print HEAD, commits, changed files, RED/GREEN evidence, and command results.
