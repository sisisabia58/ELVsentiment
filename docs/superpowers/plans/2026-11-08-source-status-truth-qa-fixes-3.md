# Source Status Truth QA Fixes (Round 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close independent QA3 findings F1-F4 on `252f6da` without changing approved behavior, migrations, RLS, or provider contracts.

**Architecture:** Make `_call` produce an explicit commit receipt and typed post-commit failures, so a committed save is never reclassified as a rollback. Convert transport/read failures to typed `ScrapeCreatorsError` codes that carry accumulated endpoint context, read HTTP status before `read()`, distinguish unknown raw list cardinality from observed zero, and never inherit a previous endpoint's status. Route every telemetry log through a non-raising wrapper.

**Tech Stack:** Python 3.12, pytest, psycopg 3, urllib; PostgreSQL 16; existing Next.js 16 web suite unchanged.

**Spec:** `docs/superpowers/specs/2026-11-08-source-status-truth-design.md`

**QA evidence:** `.tooling/qa3/REPORT.txt`, `.tooling/qa3/*.py`, adapted DB probes in `.tooling/qa3/local/`.

## Global Constraints

- Migrations `001` through `010` stay byte-identical; no app/UI architecture expansion.
- No network/provider calls; no `.env` reads; never set/use `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SCRAPECREATORS_API_KEY`, `THREADS_ACCESS_TOKEN`, `TYPESAFE_API_KEY`, `JEV_API_KEY`, `X_BEARER_TOKEN`, `OPENROUTER_API_KEY`.
- No sudo, no system directories; temporary files only under `.tooling/`; never commit `.tooling`; no `git push`.
- Never log keywords, post text, URLs, authors, secrets, request URLs, bodies, or raw exception text.
- Keep early deferral `storage_failed` labels, no-keyword job behavior, and the global claim loop unchanged.
- Keep endpoint matrix 1534, credits 78, label adversaries 64, migration `010` grants/no-delete/RLS, dedup, and rollback passing.
- Exactly one truthful `source_collection` line per source attempt. Logging never fails data or the job and never triggers a re-fetch.

## Review Focus

- A logger that raises before recording the success line must not produce any false `storage_failed` line, and the job must still succeed when the commit succeeded.
- A logger that raises after recording the success line must not produce a second contradictory line.
- `conn.close()` raising after `commit()` returned must keep `saved` and the source success outcome, and log a distinct cleanup line.
- `commit()` itself raising has unknown durability: log `storage_commit_unknown` with `saved=-`, never `saved=0`, and fail the job with that safe detail.
- A real mention/cursor write failure before commit must still log `storage_failed` `saved=0` and fail the job.
- A first endpoint status must never be reused for a later endpoint that has no status; retained counts/credits remain the earlier completed endpoints' partial values, not an invented complete total.

---

## Design Decisions Locked By This Plan

1. **Commit receipt.** `_call(connect, fn, *, log_error=True, receipt=None)` sets `receipt["committed"] = True` immediately after `conn.commit()` returns and before returning. It raises `_CommitFailed(error)` when `commit()` raises, and `_CloseFailed(error, result)` when `close()` raises after a successful commit. A close failure while another error is already propagating is swallowed so it cannot mask the real storage failure.
2. **Outcomes.** True rollback (commit never reached) -> `storage_failed`, `saved=0`, job `failed/storage_failed`. Commit reached but cleanup/logging/status failed -> `success` with actual `saved`, distinct `source_cleanup_failed` or `source_status_write_failed` line, job continues to normal finalization. Commit unknown -> `storage_commit_unknown`, `saved=-`, job `failed/storage_commit_unknown`.
3. **Safe logging.** `_safe_log(log, line)` catches and discards logger exceptions. `_log_collection`, `_log_status_write_failed`, `_log_job_finalize_failed`, `_log_cleanup_failed`, heartbeat output, and `_log_exception` output never propagate logger failure. No logging failure is itself logged (no recursion).
4. **F2 transport.** `fetch_scrapecreators_json` reads `_response_status(response)` before `response.read()`. Each HTTP error keeps `http_N`. Timeouts become `read_timeout`; other `URLError`/`OSError` become `transport_error`; both attach only the current response status (or `None`). Source functions catch those typed errors and call `carry_attempt_context` to retain earlier endpoint counts/credits.
5. **F3 counts.** Sources track `returned` as `int | None`: `None` until an endpoint yields a list. Missing/non-list fields keep it unknown (`-`). A scalar list keeps `len`. Completed endpoints retain their measured partial count; a missing first endpoint never reports `returned=0`.
6. **F4 status.** `carry_attempt_context` only attaches a status passed by the caller for the *current* endpoint (validation failures). Fetch failures pass no previous status, so an unknown current status stays `None` (`-`).

---

## Task 1: Commit receipts and safe telemetry (F1)

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py` (`_call`, `_SAFE_DETAIL_CODES`, logging helpers, `_job_context`, `_reset_source_attempt`, all four store blocks, broad `except`)
- Test: `apps/worker/tests/test_scheduler.py` (new commit-receipt tests already added)
- Test: `apps/worker/tests/test_postgres16.py` (`_RealCommitMixedConn`, `_run_real_commit_scenario`, `test_postgres16_commit_receipt_statuses_for_all_sources`)

**Interfaces:**
- Produces: `_CommitFailed(error)`, `_CloseFailed(error, result)`, `_safe_log(log, message)`, `_log_cleanup_failed(log, job, source, error)`, `_call(..., receipt=None)`.
- Produces: outcome strings `success`, `storage_failed`, `storage_commit_unknown`; detail `storage_commit_unknown`.

- [ ] **Step 1: Confirm the failing tests**

Run: `env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scheduler.py -k "committed_close or logger_failure or commit_failure or commit_unknown or write_failure_before_commit"`
Expected: FAIL on close/logger/commit cases; write-failure case already passes.

- [ ] **Step 2: Implement `_call` receipt and typed failures**

As in Design Decision 1. Add `storage_commit_unknown` to `_SAFE_DETAIL_CODES`.

- [ ] **Step 3: Wrap telemetry in `_safe_log` and add cleanup logging**

As in Design Decision 3. Add `_log_cleanup_failed` emitting `source_cleanup_failed job_id=... project_id=... source=... error=<safe label>`.

- [ ] **Step 4: Classify each store block**

For every source: call `_call(..., receipt=context)`. Catch `_CommitFailed` -> one `storage_commit_unknown` line + `fail_job("storage_commit_unknown")` + `continue`. Catch `_CloseFailed` -> `saved=error.result`, mark committed, record ready, one success line, one cleanup line, continue normal finalization. The broad handler consults `context["committed"]`: committed -> cleanup line + continue (never `storage_failed`); not committed + attempt -> `storage_failed saved=0` + fail job; not committed + no attempt -> safe exception log + fail job.

- [ ] **Step 5: Run unit and real-PG commit tests**

Run the task-1 selections plus `test_postgres16.py -k commit_receipt`.
Expected: all pass for threads, instagram, tiktok, and x; write failure still `storage_failed saved=0`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py apps/worker/tests/test_postgres16.py
git commit -m "fix(worker): keep committed saves out of rollback accounting"
```

## Task 2: Typed transport/read failures (F2)

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py` (`fetch_scrapecreators_json`, `carry_attempt_context`)
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py` (fetch `except` blocks)
- Modify: `apps/worker/sentiment_monitor/sources/tiktok.py` (fetch `except` blocks)
- Modify: `apps/worker/sentiment_monitor/scheduler.py` (`_SAFE_DETAIL_CODES`, `_guarded_fetch` credits passthrough)
- Test: `apps/worker/tests/test_scrapecreators.py`, `test_threads_source.py`, `test_instagram_source.py`, `test_tiktok_source.py`

**Interfaces:**
- Produces: `ScrapeCreatorsError.code` values `transport_error` and `read_timeout`, with `http_status` equal to the current response status when one was received.
- Consumes: `carry_attempt_context(error, credits, returned, collected, *, http_status=None)`.

- [ ] **Step 1: Confirm the failing tests**

Run the four source test files with `-k "transport or read_timeout"`.
Expected: FAIL; current code leaks generic failures or loses `http=200`/counts/credits.

- [ ] **Step 2: Read status before `read()` and type transport failures**

Capture the status before reading; convert `HTTPError` to `http_N`, timeouts to `read_timeout`, and other `URLError`/`OSError` to `transport_error`, with no message/URL in the exception string.

- [ ] **Step 3: Carry accumulated context and allowlist safe codes**

Pass accumulated counts/credits through `carry_attempt_context`; add `transport_error`/`read_timeout` to `_SAFE_DETAIL_CODES`; carry `credits_charged` in `_guarded_fetch`'s generic guard.

- [ ] **Step 4: Run source tests**

Run the four source test files.
Expected: all pass, including retained counts/credits and current status.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/sources apps/worker/sentiment_monitor/scheduler.py apps/worker/tests
git commit -m "fix(worker): keep transport context and known status on read failures"
```

## Task 3: Unknown raw list cardinality (F3)

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py` (`failure_counts`, `carry_attempt_context`)
- Modify: `apps/worker/sentiment_monitor/sources/threads.py`, `instagram.py`, `tiktok.py` (returned accumulators)
- Test: `apps/worker/tests/test_threads_source.py`, `test_instagram_source.py`, `test_tiktok_source.py`

**Interfaces:**
- Produces: `failure_counts(returned: int | None, collected)` omits `returned` when unknown; `carry_attempt_context` accepts `int | None` and preserves partial counts from completed endpoints.

- [ ] **Step 1: Confirm the failing tests**

Run the source test files with `-k "unknown or partial_not_zero"`.
Expected: FAIL; missing/non-list first endpoint logs `returned=0` today.

- [ ] **Step 2: Track unknown returned and omit it**

Initialize `returned=None`; set it from the first observed list and add later list lengths. A scalar list keeps its `len`; a missing/non-list field leaves `returned` unknown. Completed earlier endpoints remain a partial value.

- [ ] **Step 3: Update `failure_counts`/`carry_attempt_context`**

Only emit `returned` when known; keep `parsed`/`deduplicated` from collected known items.

- [ ] **Step 4: Run source and matrix tests**

Run source tests plus `.tooling/qa3/matrix_probe.py`.
Expected: missing/non-list `returned=-`, scalar list keeps len, empty list succeeds with `0`, matrix 1534/78/64 unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/sources apps/worker/tests
git commit -m "fix(worker): keep unknown raw post counts unknown"
```

## Task 4: Never inherit a previous endpoint status (F4)

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py`, `tiktok.py` (fetch `except` passes no previous status)
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py` (`carry_attempt_context` status rule)
- Test: `apps/worker/tests/test_instagram_source.py`, `test_tiktok_source.py`

**Interfaces:**
- Consumes: `carry_attempt_context(..., http_status=...)` where `http_status` is only the current endpoint's known response status.

- [ ] **Step 1: Confirm the failing tests**

Run `-k "does_not_inherit_first_status"`.
Expected: FAIL; the second malformed response logs the first endpoint's status.

- [ ] **Step 2: Pass only the current endpoint status**

Fetch failures pass no `http_status` fallback; validation failures pass the current payload status. Unknown current status stays `None`.

- [ ] **Step 3: Run source and HTTP edge probes**

Run the source tests and `.tooling/qa3/addition-endpoint_probe.py`, `.tooling/qa3/http_edges_probe.py`.
Expected: `201` then unknown logs `http_status=-`; current known statuses are preserved.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/sentiment_monitor/sources apps/worker/tests
git commit -m "fix(worker): never reuse a previous endpoint status"
```

## Task 5: Full verification and fresh review

- [ ] **Step 1: Run every non-DB QA probe**

Use the isolated `env -i` command from `.tooling/README-tooling.txt` for each `.tooling/qa3/*.py` probe (except the DB probes), plus `.tooling/qa-probe.py` and `.tooling/qa2/*.py`. Record counts.

- [ ] **Step 2: Run adapted DB probes**

Start disposable PG16 on port 55491 with data/socket under `.tooling/`, apply migrations `001`-`010`, create non-superuser `app_user`/`worker_role` logins and fixtures. Run `.tooling/qa3/local/*.py`. Record outputs; the exploratory logger probe asserts the pre-fix defect, so report its flipped assertions explicitly and rely on the repo tests for the corrected acceptance contract.

- [ ] **Step 3: Run worker unit and real-PG suites**

Run worker unit tests, then worker tests with `POSTGRES_TEST_URL` on a second disposable PG16 (port 55492) so the fixture may drop cluster-global roles; expect no skips.

- [ ] **Step 4: Run web verification**

`cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run`, `npm run typecheck`, `npm run lint`, `npm run build`.

- [ ] **Step 5: Fresh code review**

Invoke `requesting-code-review` focused on commit-receipt lifecycle and cross-endpoint telemetry semantics; fix valid findings, re-run affected checks, commit.

- [ ] **Step 6: Stop all disposable Postgres servers and report final HEAD, commits, files, red/green per finding, counts, and known issues.**
