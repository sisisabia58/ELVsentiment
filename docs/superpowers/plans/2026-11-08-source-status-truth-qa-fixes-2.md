# Source Status Truth QA Fixes (Round 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the independent QA2 P1/P2 findings on top of `1608b2e` without changing the approved behavior, migrations, RLS, or provider contract.

**Architecture:** Split `scheduler.serve` into explicit lifecycle phases with a per-job attempt context initialized before any fallible operation. Carry raw list cardinality and the transport HTTP status through every fetch/validation/storage path. Separate per-source attempt telemetry (exactly one immutable line per attempt) from job-finalization bookkeeping (its own safe line and job failure).

**Tech Stack:** Python 3.12, pytest, psycopg 3, urllib; PostgreSQL 16; existing Next.js 16 web suite unchanged.

**Spec:** `docs/superpowers/specs/2026-11-08-source-status-truth-design.md`

**QA evidence:** `.tooling/qa2/REPORT.txt`, `.tooling/qa2/*.py`

## Global Constraints

- Migrations `001` through `010` stay byte-identical; no application/UI architecture expansion.
- No network/provider calls; no `.env` reads; never set/use `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SCRAPECREATORS_API_KEY`, `THREADS_ACCESS_TOKEN`, `TYPESAFE_API_KEY`, `JEV_API_KEY`, `X_BEARER_TOKEN`, `OPENROUTER_API_KEY`.
- No sudo, no system directories; temporary files only under `.tooling/`; never commit `.tooling`; no `git push`.
- Never log keywords, post text, URLs, authors, secrets, request URLs, bodies, or raw provider text.
- Known values stay known; genuinely unknown HTTP status stays `-` and is never hard-coded to `200`.
- `saved` is only committed insertions; a rolled-back mention write logs `saved=0` `outcome=storage_failed`.
- Exactly one `source_collection` line per source attempt; finalization failure never rewrites a committed outcome.
- Unknown counts are not fabricated as raw-list zero: a present list's cardinality is used even when validation fails.
- Keep endpoint matrix, safe-label allowlist, credits rules, migration `010` grants/no-delete/app_user RLS, saved count/dedup, and mention+cursor rollback passing.

## Review Focus

- Early per-job DB failure before any provider call must not crash `serve`; it must log safely and record one job failure.
- Policy/gate deferral, budget admission, and no-sources deferral must not emit a source attempt line and must not call a provider.
- Consecutive jobs and multi-source/multi-variant jobs must never reuse another attempt's counts, credits, status, or committed flag.
- A wholly scalar list is malformed but has known cardinality; `returned` includes those entries and `parsed` excludes them.
- A known response status survives success, malformed JSON/envelope/list, `success_false`, and storage-failure paths; unknown stays `-`.
- A final job/schedule UPDATE failure after a committed mention+cursor must keep the `saved=1` success line and emit a distinct `job_finalize_failed` line.

---

## Lifecycle Map: `scheduler.serve`

One tick claims up to `max_jobs_per_tick` jobs with `for update skip locked`. Each job then runs the phases below. A phase boundary is a place where failure is classified differently, so each boundary gets its own handler.

| Phase | Operations | On failure |
|---|---|---|
| 0. Tick claim | `release_expired_claims`, `record_heartbeat`, `enqueue_due_schedules`, `claim_due_jobs`, load variants/sources, `gate` | Existing `_call` behavior; outside this plan |
| A. Policy/gate | `decide_job(gate_code)`, `_defer(credential_unapproved)` | Early no-attempt handler: safe log + one job failure; no `source_collection` |
| B. Source selection | `sources_allowed`; empty -> `_defer(sources_unavailable)` | Early no-attempt handler; no `source_collection` |
| C. Per variant, per source fetch | reset attempt context for the source; X state read + budget admission; mark attempt started immediately before the provider call; fetch + `_unpack_fetched`/`collect_newer_x`; record known counts/credits/http status in context | Provider failure (`SourceFetchError`): status bookkeeping + one `failed` line + job failure. Budget block is not an attempt: set `blocked_detail`, break, defer in Phase E |
| D. Storage commit | `_call(store_source)`; mark context committed; `_record_source_ready` (own `_call`, non-fatal); emit exactly one `success` line | Mention/cursor error: one `storage_failed` line using context counts/credits/status, `saved=0`, job failure |
| E. Job finalization | `_call(finish_job)` -> defer `blocked_detail`, else `jobs.status='succeeded'` + `project_schedules.last_collected_at` | Separate `job_finalize_failed` safe line + job failure; never emits/edits `source_collection` |

Attempt context shape (module-level helper, fresh per job, reset per source):

```python
{
    "job": job,
    "source": None,      # active/last source for this attempt
    "attempt": False,    # provider attempt started
    "counts": None,      # unpacked returned/parsed/deduplicated
    "credits": None,
    "http_status": None,
    "committed": False,  # mention+cursor commit succeeded
}
```

Error-handler dispatch:

- `SourceFetchError`: provider attempt failed -> Phase C handler.
- Any other exception with `attempt is True`: storage failure during/after a provider attempt -> Phase D handler.
- Any other exception with `attempt is False`: early failure -> safe `_log_exception`, one job failure, no `source_collection`.
- Phase E exceptions are caught by the finalization handler, not the attempt handlers.

---

### Task 1: Per-job lifecycle context and phase boundaries (P1)

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py:598-869`
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Produces: `_job_context(job) -> dict` and `_reset_source_attempt(context, source) -> dict`.
- Produces: `_log_job_finalize_failed(log, job, error) -> None`.
- Produces: `serve` dispatch rules from the lifecycle map; `_fail(job_id, "storage_failed")` for early non-attempt failures.
- Consumes: existing `_call`, `_defer`, `_fail`, `_log_exception`, `_log_collection`.

- [ ] **Step 1: Write the failing tests**

Add to `test_scheduler.py`:

```python
def test_early_deferral_failure_does_not_crash_serve_and_fails_job(tmp_path):
    class DeferralFail(_LoopConn):
        def execute(self, sql, params=None):
            if "status = 'deferred'" in sql:
                raise RuntimeError("synthetic defer storage failure")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines = []
    providers = []

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: DeferralFail(world), stop, load_limits(Path("config/limits.json"), {}),
            "worker-1", _policy_root(tmp_path, False),
            lambda *a, **k: providers.append("x"), lambda *a, **k: providers.append("threads"),
            log=lines.append,
        )
    failed = [p for s, p in world.calls if "status = 'failed'" in s and "claim_expired" not in s]
    assert failed == [("storage_failed", "job-1")]
    assert providers == []
    assert not any(line.startswith("source_collection") for line in lines)
```

```python
def test_budget_and_no_sources_deferrals_emit_no_source_attempt(tmp_path):
    # Budget: X admission returns a block report before any provider call.
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["x"]
    lines, providers = [], []

    class BudgetBlock(_LoopConn):
        def execute(self, sql, params=None):
            if "from x_read_counters" in " ".join(sql.lower().split()) and "for update" in sql.lower():
                return 100000
            return super().execute(sql, params)

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: BudgetBlock(world), stop, load_limits(Path("config/limits.json"), {}),
            "worker-1", _policy_root(tmp_path, True),
            lambda *a, **k: providers.append("x"), lambda *a, **k: providers.append("threads"),
            log=lines.append,
        )
    assert providers == []
    assert not any(line.startswith("source_collection") for line in lines)
    assert any(p and "x_customer_cap" in p for s, p in world.calls if "status = 'deferred'" in s)

    # No sources: gate allowed, policy allows none.
    world2 = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    lines2 = []
    with pytest.raises(SystemExit):
        with patch("sentiment_monitor.scheduler.sources_allowed", return_value=[]):
            serve(
                world2.connect, stop, load_limits(Path("config/limits.json"), {}),
                "worker-1", _policy_root(tmp_path, True),
                lambda *a, **k: providers.append("x"), lambda *a, **k: providers.append("threads"),
                log=lines2.append,
            )
    assert not any(line.startswith("source_collection") for line in lines2)
    assert any(p and "sources_unavailable" in p for s, p in world2.calls if "status = 'deferred'" in s)
```

```python
def test_consecutive_jobs_reset_attempt_context(tmp_path):
    job2 = {**_due_job(), "id": "job-2"}
    world = LoopWorld(jobs=[_due_job(), job2], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines, calls = [], {"n": 0}

    def fetch_threads(_variant):
        from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError
        calls["n"] += 1
        if calls["n"] == 1:
            raise ScrapeCreatorsError("http_429", http_status=429, credits_charged=4,
                                      counts={"returned": 3, "parsed": 2, "deduplicated": 1})
        return {"mentions": [{"external_id": "2", "excerpt": "synthetic"}],
                "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
                "credits_charged": 2, "http_status": 200}

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(world.connect, stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", _policy_root(tmp_path, True),
              lambda *a, **k: ([], None), fetch_threads, log=lines.append)
    failed = next(l for l in lines if l.startswith("source_collection") and "outcome=failed" in l)
    succeeded = next(l for l in lines if l.startswith("source_collection") and "outcome=success" in l)
    assert "returned=3" in failed and "credits_charged=4" in failed and "http_status=429" in failed
    assert "returned=1" in succeeded and "credits_charged=2" in succeeded and "http_status=200" in succeeded
    assert "returned=3" not in succeeded and "credits_charged=4" not in succeeded
```

```python
def test_multi_source_multi_variant_resets_attempt_context(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["v1", "v2"], cursor=None)
    world.sources = ["threads", "instagram"]
    lines = []

    def fetch_threads(variant):
        return {"mentions": [{"external_id": variant}], "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
                "credits_charged": 2, "http_status": 200}

    def fetch_instagram(variant):
        return {"mentions": [{"external_id": variant}], "counts": {"returned": 2, "parsed": 2, "deduplicated": 0},
                "credits_charged": 3, "http_status": 201}

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(world.connect, stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", _policy_root(tmp_path, True),
              lambda *a, **k: ([], None), fetch_threads, log=lines.append,
              fetch_instagram=fetch_instagram)
    collection = [l for l in lines if l.startswith("source_collection")]
    assert len(collection) == 4
    assert all("source=threads" in l and "returned=1" in l and "credits_charged=2" in l and "http_status=200" in l
               for l in collection if "source=threads" in l)
    assert all("source=instagram" in l and "returned=2" in l and "credits_charged=3" in l and "http_status=201" in l
               for l in collection if "source=instagram" in l)
```

- [ ] **Step 2: Verify RED**

Run: `env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scheduler.py -k "early_deferral_failure or budget_and_no_sources or consecutive_jobs_reset or multi_source_multi_variant_reset"`
Expected: FAIL; early deferral escapes with `UnboundLocalError` (or no job failure); other context lines absent.

- [ ] **Step 3: Implement lifecycle helpers and phase restructure**

In `scheduler.py` add `_job_context`, `_reset_source_attempt`, `_log_job_finalize_failed`. Restructure the per-job body exactly as the Lifecycle Map: initialize `context` before the main `try`, reset it before each source, set `attempt=True` immediately before each provider call, route `SourceFetchError` to the provider handler, non-attempt exceptions to the early handler, attempt exceptions to the storage handler, and run `finish_job` in its own `try/except` that emits `job_finalize_failed` and calls `_fail(job_id, "storage_failed")`.

- [ ] **Step 4: Verify GREEN**

Run the same `-k` command then the full scheduler file.
Expected: PASS; no `UnboundLocalError`; early/budget/no-source paths emit no `source_collection`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py
git commit -m "fix(worker): isolate job lifecycle phases and attempt context"
```

---

### Task 2: Keep raw cardinality for wholly scalar lists (P2a)

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py:39-80`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py:92-107`
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py:110-157`
- Modify: `apps/worker/sentiment_monitor/sources/tiktok.py:86-102`
- Test: `apps/worker/tests/test_scrapecreators.py`
- Test: `apps/worker/tests/test_threads_source.py`
- Test: `apps/worker/tests/test_instagram_source.py`
- Test: `apps/worker/tests/test_tiktok_source.py`

**Interfaces:**
- Produces: `select_post_list` raises `ScrapeCreatorsError("malformed_posts", counts={"returned": len(value), "parsed": 0, "deduplicated": 0})` when a present list is non-empty and contains no dict entries.
- Produces: `carry_attempt_context(error, credits, returned, collected, *, http_status=None)` adds `error.counts["returned"]` (when a non-negative int) to the accumulated `returned` before calling `failure_counts`; sets `error.http_status` only when the error has none.
- Consumes: Task 1 scheduler storage-failure logging (unchanged field names).

- [ ] **Step 1: Write the failing tests**

```python
def test_select_post_list_keeps_known_scalar_cardinality():
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": [1, 2]}, ("posts",))
    assert caught.value.code == "malformed_posts"
    assert caught.value.counts == {"returned": 2, "parsed": 0, "deduplicated": 0}
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": {"bad": True}}, ("posts",))
    assert caught.value.counts is None  # non-list cardinality is unknown
```

```python
def test_threads_scalar_only_list_keeps_raw_returned_count():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": [1, 2], "credits_charged": 2})
    assert caught.value.code == "malformed_posts"
    assert caught.value.counts == {"returned": 2, "parsed": 0, "deduplicated": 0}
    assert caught.value.credits_charged == 2
```

```python
def test_instagram_scalar_only_second_list_keeps_accumulated_returned():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _instagram((
            {"reels": [{"pk": "1"}], "credits_charged": 2},
            {"posts": [1, 2], "credits_charged": 3},
        ))
    assert caught.value.counts == {"returned": 3, "parsed": 1, "deduplicated": 0}
    assert caught.value.credits_charged == 5
```

```python
def test_tiktok_scalar_only_second_list_keeps_accumulated_returned():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _tiktok((
            {"search_item_list": [{"aweme_id": "1"}], "credits_charged": 2},
            {"search_item_list": [1, 2], "credits_charged": 3},
        ))
    assert caught.value.counts == {"returned": 3, "parsed": 1, "deduplicated": 0}
    assert caught.value.credits_charged == 5
```

- [ ] **Step 2: Verify RED**

Run: `env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scrapecreators.py apps/worker/tests/test_threads_source.py apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py -k "cardinality or scalar_only"`
Expected: FAIL; scalar lists report `returned=0` for Threads and only prior counts for IG/TikTok.

- [ ] **Step 3: Implement cardinality carry**

`select_post_list` attaches `counts` for scalar-only lists only. `carry_attempt_context` merges that known `returned` into the accumulated count before `failure_counts`, so parsed/deduplicated keep only valid collected entries. Do not fabricate a count for non-list values.

- [ ] **Step 4: Verify GREEN**

Run the same command. Expected: PASS, including existing missing/malformed/unusable cases.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/sources apps/worker/tests/test_scrapecreators.py apps/worker/tests/test_threads_source.py apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py
git commit -m "fix(worker): retain raw list cardinality on malformed lists"
```

---

### Task 3: Carry known HTTP status through every path (P2b)

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py:83-115`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py`
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py`
- Modify: `apps/worker/sentiment_monitor/sources/tiktok.py`
- Modify: `apps/worker/sentiment_monitor/scheduler.py:451-495,705-775`
- Test: `apps/worker/tests/test_scrapecreators.py`
- Test: `apps/worker/tests/test_threads_source.py`
- Test: `apps/worker/tests/test_instagram_source.py`
- Test: `apps/worker/tests/test_tiktok_source.py`
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Produces: `FetchedJSON(dict)` with `.http_status: int | None`; `fetch_scrapecreators_json` returns it and attaches `http_status` to `malformed_json`, `malformed_envelope`, and `success_false` errors.
- Produces: each source result includes `"http_status": int | None`; for two-endpoint sources it is the last attempted endpoint's status.
- Produces: `_unpack_fetched(...) -> (mentions, next_cursor, counts, credits, http_status)`.
- Consumes: Task 1 context `http_status`.

- [ ] **Step 1: Write the failing tests**

Add a status-aware response helper:

```python
class StatusResponse(io.StringIO):
    def __init__(self, body, status=200):
        super().__init__(body)
        self.status = status
    def __enter__(self): return self
    def __exit__(self, *args): return False
```

```python
def test_fetch_scrapecreators_keeps_known_status_on_success_and_typed_errors():
    def ok(request, timeout=0):
        return StatusResponse('{"posts": []}', status=200)
    payload = fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=ok)
    assert payload.http_status == 200

    def bad_json(request, timeout=0):
        return StatusResponse("{not-json", status=200)
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=bad_json)
    assert caught.value.http_status == 200

    def envelope(request, timeout=0):
        return StatusResponse("[1, 2]", status=200)
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=envelope)
    assert caught.value.http_status == 200

    def success_false(request, timeout=0):
        return StatusResponse('{"success": false}', status=200)
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_scrapecreators_json("/v1/threads/search", {"query": "x"}, "key", opener=success_false)
    assert caught.value.http_status == 200
```

```python
def test_threads_success_result_keeps_known_response_status():
    result = fetch_threads_mentions("kopi", "key", "2026-11-01T00:00:00Z",
        opener=lambda *a, **k: StatusResponse('{"posts": []}', status=200))
    assert result["http_status"] == 200
```

```python
def test_instagram_uses_last_attempted_endpoint_status():
    def opener(request, timeout=0):
        if "/v2/instagram/reels/search" in request.full_url:
            return StatusResponse('{"reels": []}', status=201)
        return StatusResponse('{"posts": []}', status=200)
    result = fetch_instagram_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)
    assert result["http_status"] == 200
```

```python
def test_tiktok_malformed_second_endpoint_keeps_its_response_status():
    def opener(request, timeout=0):
        if "/v1/tiktok/search/keyword" in request.full_url:
            return StatusResponse('{"search_item_list": []}', status=201)
        return StatusResponse("{not-json", status=202)
    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_tiktok_mentions("Kopi", "key", "2026-11-01T00:00:00Z", opener=opener)
    assert caught.value.code == "malformed_json"
    assert caught.value.http_status == 202
```

```python
def test_success_and_storage_failure_logs_carry_known_http_status(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(_variant):
        return {"mentions": [{"external_id": "1", "excerpt": "synthetic"}],
                "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
                "credits_charged": 2, "http_status": 200}

    def stop(_seconds): raise SystemExit
    with pytest.raises(SystemExit):
        serve(world.connect, stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", _policy_root(tmp_path, True),
              lambda *a, **k: ([], None), fetch_threads, log=lines.append)
    assert "http_status=200" in next(l for l in lines if l.startswith("source_collection"))
```

Also assert an unknown status (`io.StringIO` without `.status`) stays `http_status=-`.

- [ ] **Step 2: Verify RED**

Run the source + scheduler tests with `-k "status"`. Expected: FAIL; helper/source/results lack `http_status`; success/storage lines show `-`.

- [ ] **Step 3: Implement transport-status carry**

Read `response.status` or `response.getcode()` once after `read()`; keep only `type(value) is int`. Wrap the decoded dict in `FetchedJSON`; attach the status to every typed error. Sources record the current endpoint status and include the last attempted one in the result and any error via `carry_attempt_context(..., http_status=...)`. `_unpack_fetched` returns the result `http_status`; `serve` stores it in context and passes it to success and storage-failure logs.

- [ ] **Step 4: Verify GREEN**

Run the same command, then the full worker source tests. Expected: PASS; known `200` preserved, unknown stays `-`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor apps/worker/tests/test_scrapecreators.py apps/worker/tests/test_threads_source.py apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py apps/worker/tests/test_scheduler.py
git commit -m "fix(worker): carry known response status through telemetry"
```

---

### Task 4: Separate job finalization from source outcomes (P2c)

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py` (finalization phase from Task 1)
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Consumes: Task 1 `_log_job_finalize_failed` and finalization phase; Task 3 `http_status`.
- Produces: on finalization failure, exactly one `source_collection outcome=success saved=1` line remains, plus one `job_finalize_failed job_id=<id> project_id=<id> error=<safe label>` line and one job failure.

- [ ] **Step 1: Write the failing test**

```python
def test_job_finalization_failure_keeps_committed_source_outcome(tmp_path):
    class FinishFail(_LoopConn):
        def execute(self, sql, params=None):
            if "status = 'succeeded'" in sql:
                raise RuntimeError("synthetic finish bookkeeping failure")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(_variant):
        return {"mentions": [{"external_id": "1", "excerpt": "synthetic"}],
                "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
                "credits_charged": 2, "http_status": 200}

    def stop(_seconds): raise SystemExit
    with pytest.raises(SystemExit):
        serve(lambda: FinishFail(world), stop, load_limits(Path("config/limits.json"), {}),
              "worker-1", _policy_root(tmp_path, True),
              lambda *a, **k: ([], None), fetch_threads, log=lines.append)

    collection = [l for l in lines if l.startswith("source_collection")]
    assert len(collection) == 1
    assert "outcome=success" in collection[0] and "saved=1" in collection[0]
    assert not any("outcome=storage_failed" in l for l in collection)
    finalize = [l for l in lines if l.startswith("job_finalize_failed")]
    assert len(finalize) == 1 and "job_id=job-1" in finalize[0] and "private" not in finalize[0]
    failed = [p for s, p in world.calls if "status = 'failed'" in s and "claim_expired" not in s]
    assert failed == [("storage_failed", "job-1")]
    assert [s for s, _p in world.calls].count("COMMIT") >= 2  # mention/cursor commit survived
```

- [ ] **Step 2: Verify RED**

Run: `env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scheduler.py::test_job_finalization_failure_keeps_committed_source_outcome`
Expected: FAIL because a second `source_collection outcome=storage_failed saved=0` is emitted (or no `job_finalize_failed` exists).

- [ ] **Step 3: Confirm finalization isolation**

Ensure the finalization `try/except` from Task 1 is the only place that catches the `status='succeeded'`/schedule UPDATE failure, and that it emits only `job_finalize_failed` + job failure. The attempt handlers must not run for finalization errors. Keep the existing distinct tests for status-write failure and mention-storage rollback unchanged.

- [ ] **Step 4: Verify GREEN**

Run the finalization test plus `-k "status_write or storage_failure or finalization"`. Expected: PASS; three distinct classified outcomes.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py
git commit -m "fix(worker): report job finalization failures separately"
```

---

### Task 5: Full verification

**Files:** none.

- [ ] **Step 1: Reproduce probes and confirm green**

Run each `.tooling/qa2` probe with only the hardcoded temp/ROOT inputs redirected into `.tooling/qa2/tmp` (behavior unchanged), plus `.tooling/qa-probe.py`:

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python .tooling/qa2/run/<probe>.py
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python .tooling/qa2/run/qa-probe.py
```

Expected: early failure RECOVERED with one job failure; scalar-list counts `2/0/0` (Threads) and `3/1/0` (IG/TikTok); known status 200 everywhere it is supplied; finalization emits only one success line plus `job_finalize_failed`; `postcommit_db_probe` confirms committed mention+cursor and no contradictory `saved=0`.

- [ ] **Step 2: Worker unit tests**

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests
```

Expected: all pass, zero failures.

- [ ] **Step 3: Worker with disposable PG16 (port 55461, no skips)**

Follow `.tooling/README-tooling.txt`; init/start a disposable cluster under `.tooling/`, pass only `POSTGRES_TEST_URL`, run the worker suite, then stop the cluster. Expected: same pass count with zero skips/failures.

- [ ] **Step 4: Web**

```bash
cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run
npm run typecheck
npm run lint
npm run build
```

Expected: tests pass, typecheck/lint/build exit 0.

- [ ] **Step 5: Stop Postgres and report**

Stop the disposable cluster; report HEAD, commits, changed files, per-finding RED/GREEN evidence, exact counts, and known defects.

---

## Self-Review

- **Spec coverage:** P1 maps to Task 1; P2a to Task 2; P2b to Task 3; P2c to Task 4. Existing behavior guards are covered by the Global Constraints and Task 5.
- **Step scan:** Each step names exact files, tests, commands, or signatures. No "handle edge cases" placeholders.
- **Type consistency:** `_unpack_fetched` gains only a fifth return value (credits remains index 3); `carry_attempt_context` keeps its first four positional arguments and adds a keyword-only `http_status`; context keys are used consistently across Tasks 1, 3, and 4.
- **Review Focus:** Every listed failure mode has a named test in the owning task.
- **Proportion:** Tasks are grouped by QA finding; no new modules or migrations.
