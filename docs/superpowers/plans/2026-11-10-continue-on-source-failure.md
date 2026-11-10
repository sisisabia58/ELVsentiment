# Continue Collection After a Source Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single failing source+keyword must not abort the rest of a collection job; the job reports partial success without schema changes.

**Architecture:** Keep the scheduler's existing per-source commit path. Catch `SourceFetchError` around each source attempt, record/log it, accumulate a failure note, and fall through to the next source and next keyword. Instagram tries its remaining unconditional route after a first-route failure when no credits/counts were accumulated. `jobPresentation` turns the machine-readable partial-failure detail into a friendly Indonesian explanation.

**Tech Stack:** Python 3.12 worker (pytest), Next.js web (TypeScript, vitest), PostgreSQL 16 only for existing integration tests.

**Spec:** `/workspace/sc-research/impl/sourcefail-20261110/brief.txt`

## Global Constraints

- Only work in `/workspace/elvsentiment-wt-sourcefail` on branch `fix/continue-on-source-failure`.
- No new migrations; job statuses stay `queued|claimed|succeeded|deferred|failed`.
- `sha256` of `apps/web/src/db/sql/011_search_intent_and_relevance.sql` must remain `8f6f5be086837e76711d7af80fee5f20df3103ec6cc0e44346c32393c5f1d0b8`.
- No provider/paid/network calls. Tests use synthetic openers and scheduler-boundary stubs only.
- All Python/Node commands run through `/workspace/sc-research/impl/sourcefail-20261110/run-clean`.
- Local commits only: no amend, rebase, reset, `--no-verify`, push, merge, fetch, or clone.
- Do not modify `.tooling/venv` or `apps/web/node_modules` (symlinked sibling tooling).
- Preserve existing success logging, F1–F6 telemetry, sanitized logs, and storage/config failure behaviour.

## Review Focus

- A job whose only attempted source fails must still end `failed`, not `succeeded` with an empty partial note.
- A partial success must still update `project_schedules.last_collected_at`.
- A failed keyword must not cause already-committed earlier keyword/source rows or credits to be rolled back.
- Instagram must not turn a real `malformed_posts`/`missing_posts` after a successful parse into a silent success.
- Partial status detail must stay parseable and must not leak raw provider text; only safe `detail` codes and the user's keyword are stored.

---

### Task 1: Instagram attempts remaining routes after a first-route failure

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py` (`fetch_instagram_mentions`)
- Test: `apps/worker/tests/test_instagram_source.py`

**Interfaces:**
- Consumes: `fetch_scrapecreators_json`, `carry_attempt_context`, `known_credits`, `ScrapeCreatorsError`.
- Produces: unchanged `fetch_instagram_mentions(...) -> dict[str, Any]`; on a first-route `ScrapeCreatorsError` with no accumulated state it now continues to later unconditional routes. If every unconditional route fails it re-raises a `ScrapeCreatorsError` carrying accumulated credits/counts.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/tests/test_instagram_source.py`:

```python
def test_instagram_phrase_first_route_404_falls_through_to_hashtag():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        if "/v2/instagram/reels/search" in request.full_url:
            raise urllib.error.HTTPError(request.full_url, 404, "missing", {}, None)
        return Response(json.dumps({"posts": [{"pk": "ig-h", "caption": "Kopi hashtag"}], "credits_charged": 1}))

    result = fetch_instagram_mentions(
        "Kopi", "key", "2026-11-01T00:00:00Z", intent="phrase", opener=opener
    )

    assert len(seen) == 2
    assert [m["external_id"] for m in result["mentions"]] == ["ig-h"]
    assert result["mentions"][0]["route_id"] == "instagram.hashtag_from_phrase"
    assert result["counts"]["returned"] == 1
    assert result["counts"]["parsed"] == 1
    assert result["credits_charged"] == 1


def test_instagram_all_routes_404_still_fails_as_source_failure():
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        raise urllib.error.HTTPError(request.full_url, 404, "missing", {}, None)

    with pytest.raises(ScrapeCreatorsError) as caught:
        fetch_instagram_mentions(
            "Kopi", "key", "2026-11-01T00:00:00Z", intent="phrase", opener=opener
        )

    assert caught.value.code == "http_404"
    assert caught.value.http_status == 404
    assert len(seen) == 2
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/.tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_instagram_source.py -k 'first_route_404 or all_routes_404'`

Workdir: `/workspace/elvsentiment-wt-sourcefail`

Expected: FAIL. The first test raises `http_404` before calling the hashtag route (`len(seen) == 1`).

- [ ] **Step 3: Implement route fallthrough**

In `fetch_instagram_mentions`, before the route loop add `route_errors: list[ScrapeCreatorsError] = []`. Replace the unconditional-route `except ScrapeCreatorsError` block with:

```python
        except ScrapeCreatorsError as error:
            if credits or returned is not None or parsed_total:
                raise carry_attempt_context(
                    error, credits, returned, collected, parsed=parsed_total
                ) from None
            if error.credits_charged is not None:
                credits.append(error.credits_charged)
            route_errors.append(error)
            continue
```

After the unconditional `for route in routes` loop and before the page-2 block, add:

```python
    if returned is None and route_errors:
        raise carry_attempt_context(
            route_errors[0], credits, returned, collected, parsed=parsed_total
        ) from None
```

Leave the conditional page-2 block untouched.

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/.tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_instagram_source.py`

Workdir: `/workspace/elvsentiment-wt-sourcefail`

Expected: PASS, all tests in that file.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/sources/instagram.py apps/worker/tests/test_instagram_source.py
git commit -m "fix(worker): try remaining instagram routes after a first-route failure"
```

---

### Task 2: Scheduler continues to the next source and keyword on source failure

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py` (`serve` job loop and a small failure helper)
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Consumes: existing `record_source_failure`, `_log_collection`, `_reset_source_attempt`, `_commit_source`, `_fail`, `SourceFetchError`.
- Produces: job-level `failures: list[str]` and `committed_sources: int`; `jobs.status='succeeded'` with `status_detail` `"partial_failures:<source>:<quote(keyword)>:<detail>|<...>"` when some commits succeeded and some source attempts failed. If every source attempt failed, `jobs.status='failed'` with `status_detail="all_sources_failed:<source>:<quote(keyword)>:<detail>|<...>"`. Success with no failures keeps `status_detail=null`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/tests/test_scheduler.py`:

```python
def test_barayam_partial_source_failure_continues_sources_and_keywords(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["ayam barayam", "ayam geprek", "sambal"], cursor=None)
    world.sources = ["threads", "instagram", "tiktok"]
    calls = []
    lines = []

    def post(source, variant):
        return [{
            "external_id": f"{source}-{variant}",
            "excerpt": f"{source} {variant}",
            "url": f"https://example.com/{source}/{variant}",
            "author": "a",
            "posted_at": "2026-11-01T00:00:00Z",
            "variant": variant,
        }]

    def fetch_threads(variant):
        calls.append(("threads", variant))
        return post("threads", variant), None

    def fetch_instagram(variant):
        calls.append(("instagram", variant))
        if variant == "ayam barayam":
            raise ScrapeCreatorsError("http_404", http_status=404)
        return post("instagram", variant), None

    def fetch_tiktok(variant):
        calls.append(("tiktok", variant))
        return post("tiktok", variant), None

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
            fetch_instagram=fetch_instagram,
            fetch_tiktok=fetch_tiktok,
        )

    assert calls == [
        ("threads", "ayam barayam"), ("instagram", "ayam barayam"), ("tiktok", "ayam barayam"),
        ("threads", "ayam geprek"), ("instagram", "ayam geprek"), ("tiktok", "ayam geprek"),
        ("threads", "sambal"), ("instagram", "sambal"), ("tiktok", "sambal"),
    ]
    failed = [line for line in lines if line.startswith("source_collection") and "outcome=failed" in line]
    assert len(failed) == 1
    assert "source=instagram" in failed[0]
    assert "detail=instagram_http_404" in failed[0]
    successes = [line for line in lines if line.startswith("source_collection") and "outcome=success" in line]
    assert len(successes) == 8

    updates = [
        params for sql, params in world.calls
        if "update jobs set status = 'succeeded'" in sql.lower()
    ]
    assert len(updates) == 1
    detail = updates[0][0]
    assert detail.startswith("partial_failures:")
    assert "instagram:ayam%20barayam:instagram_http_404" in detail

    failed_jobs = [
        params for sql, params in world.calls
        if "update jobs set status = 'failed'" in sql.lower()
        and "claim_expired" not in sql.lower()
    ]
    assert failed_jobs == []
    schedule_updates = [
        params for sql, params in world.calls
        if "update project_schedules set last_collected_at" in sql.lower()
    ]
    assert schedule_updates == [("project-1",)]


def test_every_source_failing_fails_the_job_with_a_summary(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["ayam barayam"], cursor=None)
    world.sources = ["instagram"]

    def fetch_instagram(_variant):
        raise ScrapeCreatorsError("http_404", http_status=404)

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            lambda *_args, **_kwargs: ([], None),
            fetch_instagram=fetch_instagram,
        )

    failed = [
        params for sql, params in world.calls
        if "update jobs set status = 'failed'" in sql.lower()
        and "claim_expired" not in sql.lower()
    ]
    assert failed == [(
        "all_sources_failed:instagram:ayam%20barayam:instagram_http_404",
        "job-1",
    )]
    succeeded = [
        sql for sql, _params in world.calls
        if "update jobs set status = 'succeeded'" in sql.lower()
    ]
    assert succeeded == []
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/.tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scheduler.py -k 'barayam_partial or every_source_failing'`

Workdir: `/workspace/elvsentiment-wt-sourcefail`

Expected: FAIL. The first test stops after keyword 1 Instagram and marks the job failed; the second still fails but without the summary detail.

- [ ] **Step 3: Implement continue-on-source-failure**

Add near the other logging helpers:

```python
def _source_failure_note(source: str, variant: Any, detail: str) -> str:
    keyword = quote(str(variant), safe="")
    return f"{source}:{keyword}:{detail}"


def _record_source_failure(connect, log, job, source: str, error: SourceFetchError) -> None:
    try:
        _call(
            connect,
            lambda conn: record_source_failure(
                conn,
                job["customer_id"],
                job["project_id"],
                source,
                error.detail,
                error.state,
            ),
            log_error=False,
        )
    except Exception as status_error:
        _log_status_write_failed(log, job, source, status_error)
    _log_collection(
        log,
        job,
        source,
        "failed",
        error.counts,
        0,
        http_status=error.http_status,
        credits=error.credits_charged,
        detail=error.detail,
    )
```

Inside `serve`, immediately after `context = _job_context(job)` add:

```python
            failures: list[str] = []
            committed_sources = 0
```

Wrap each source block body (`x`, `threads`, `instagram`, `tiktok`) in its own `try: ... except SourceFetchError as error:` block. On failure call `_record_source_failure(connect, log, job, "<source>", error)`, append `_source_failure_note("<source>", variant, error.detail)` to `failures`, and fall through (do not `continue`, `break`, or re-raise). For `x`, wrap only the collection + commit portion, leaving the existing admission `blocked_detail` logic outside the `try`. After each successful `_commit_source(...)` call add `committed_sources += 1`.

Replace the outer `except SourceFetchError as error:` block by deleting it: source errors are now handled inside each source block. Keep `except _CommitFailed` and `except Exception` unchanged.

Replace the `finish_job` body's status update so it is:

```python
                def finish_job(conn, job=job, blocked_detail=blocked_detail):
                    if blocked_detail:
                        _defer(conn, job["id"], blocked_detail)
                        return
                    if failures and committed_sources == 0:
                        conn.execute(
                            "update jobs set status = 'failed', status_detail = %s where id = %s",
                            ("all_sources_failed:" + "|".join(failures), job["id"]),
                        )
                        return
                    detail = "partial_failures:" + "|".join(failures) if failures else None
                    conn.execute(
                        "update jobs set status = 'succeeded', status_detail = %s where id = %s",
                        (detail, job["id"]),
                    )
                    conn.execute(
                        "update project_schedules set last_collected_at = now() where project_id = %s",
                        (job["project_id"],),
                    )
```

Keep `_source_failure_note`'s detail input as `error.detail` (already a safe code such as `instagram_http_404`). Do not store exception text.

- [ ] **Step 4: Run the scheduler tests to verify GREEN**

Run: `/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/.tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scheduler.py`

Workdir: `/workspace/elvsentiment-wt-sourcefail`

Expected: PASS, all tests in that file (existing fetch-error tests must still assert a single failed job when the only source fails).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py
git commit -m "fix(worker): continue collection after a source failure and report partial success"
```

---

### Task 3: Friendly partial-failure explanation in run history

**Files:**
- Modify: `apps/web/src/monitor/load.ts` (`jobPresentation`)
- Test: `apps/web/src/monitor/monitor.test.ts`

**Interfaces:**
- Consumes: `SOURCE_NAME` from `./sources` (already imported in `load.ts` as part of policy re-export).
- Produces: unchanged `jobPresentation(status, detail)` signature. For `status="succeeded"` and `detail` starting `"partial_failures:"`, label stays `"Selesai"` and explanation names failed sources and keywords.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/monitor/monitor.test.ts`, next to the existing `jobPresentation` assertions, add:

```ts
    const partial = jobPresentation(
      "succeeded",
      "partial_failures:instagram:ayam%20barayam:instagram_http_404|tiktok:sambal:tiktok_http_500",
    );
    expect(partial.label).toBe("Selesai");
    expect(partial.explanation).toContain("Instagram");
    expect(partial.explanation).toContain("ayam barayam");
    expect(partial.explanation).toContain("TikTok");
    expect(partial.explanation).toContain("sambal");
    expect(partial.explanation).not.toContain("partial_failures");
```

- [ ] **Step 2: Run the test to verify RED**

Run: `/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/vitest run src/monitor/monitor.test.ts`

Workdir: `/workspace/elvsentiment-wt-sourcefail/apps/web`

Expected: FAIL. `partial.explanation` is the generic "Pengumpulan selesai..." text and lacks `Instagram`/keyword.

- [ ] **Step 3: Implement partial detail parsing**

In `apps/web/src/monitor/load.ts`, add a small helper above `jobPresentation`:

```ts
function decodeKeyword(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function partialFailureExplanation(detail: string): string | null {
  const prefix = "partial_failures:";
  if (!detail.startsWith(prefix)) return null;
  const bySource = new Map<string, string[]>();
  for (const entry of detail.slice(prefix.length).split("|")) {
    const [source, rawKeyword] = entry.split(":");
    const name = SOURCE_NAME[source as SourceId];
    if (!name) continue;
    const keyword = decodeKeyword(rawKeyword ?? "").trim();
    if (!keyword) continue;
    const keywords = bySource.get(name) ?? [];
    if (!keywords.includes(keyword)) keywords.push(keyword);
    bySource.set(name, keywords);
  }
  if (bySource.size === 0) return null;
  const parts = [...bySource].map(([name, keywords]) => `${name} (kata kunci ${keywords.join(", ")})`);
  return `Pengumpulan selesai. Beberapa sumber gagal: ${parts.join(", ")}.`;
}
```

Then at the start of `jobPresentation`, after the `skipped_overlap` check, add:

```ts
  if (status === "succeeded") {
    const partial = detail ? partialFailureExplanation(detail) : null;
    if (partial) return { label: "Selesai", explanation: partial };
  }
```

Leave the existing generic `status === "succeeded"` line after it.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/vitest run src/monitor/monitor.test.ts`

Workdir: `/workspace/elvsentiment-wt-sourcefail/apps/web`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/monitor/load.ts apps/web/src/monitor/monitor.test.ts
git commit -m "feat(web): explain partial source failures in collection history"
```

---

### Task 4: Final verification gates

**Files:**
- Create: `/workspace/sc-research/impl/sourcefail-20261110/notes.md`
- Read only: migrations `001`–`011`

- [ ] **Step 1: Confirm migrations untouched and capture hash**

Run (workdir `/workspace/elvsentiment-wt-sourcefail`):

```bash
git diff --name-only de21b15f59003c16e885a03437f95b3f2dd4635d..HEAD -- apps/web/src/db/sql
sha256sum apps/web/src/db/sql/011_search_intent_and_relevance.sql
```

Expected: no migration paths; hash `8f6f5be086837e76711d7af80fee5f20df3103ec6cc0e44346c32393c5f1d0b8`.

- [ ] **Step 2: Start disposable PG16**

Use only this worktree's binary symlink target, never production. Pick a free port (e.g. `55496`):

```bash
PG=/workspace/elvsentiment-wt-sourcefail/.tooling/venv/lib/python3.12/site-packages/pgserver/pginstall/bin
PGDATA=/workspace/sc-research/impl/sourcefail-20261110/pg/data
mkdir -p "$PGDATA"
"$PG/initdb" -D "$PGDATA" -U postgres --auth=trust
"$PG/pg_ctl" -D "$PGDATA" -o "-k /workspace/sc-research/impl/sourcefail-20261110/pg -h '' -p 55496" -w start
```

Export for the gate commands:

```bash
POSTGRES_TEST_URL="postgresql://postgres@/postgres?host=/workspace/sc-research/impl/sourcefail-20261110/pg&port=55496"
POSTGRES_TEST_LOG_PATH=/workspace/sc-research/impl/sourcefail-20261110/logs/postgres.log
```

Expected: PG16 starts; `psql "$POSTGRES_TEST_URL" -c 'show server_version'` reports 16.x. If the port is busy, choose another free port and record it.

- [ ] **Step 3: Worker no-DB tests**

Run (workdir `/workspace/elvsentiment-wt-sourcefail`):

```bash
/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/.tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests --ignore=apps/worker/tests/test_postgres16.py
```

Expected: all pass, no failures/skips caused by DB absence.

- [ ] **Step 4: Worker real PG tests**

Run (workdir `/workspace/elvsentiment-wt-sourcefail`, passing `POSTGRES_TEST_URL` through `run-clean`'s `env`):

```bash
/workspace/sc-research/impl/sourcefail-20261110/run-clean env POSTGRES_TEST_URL="$POSTGRES_TEST_URL" /workspace/elvsentiment-wt-sourcefail/.tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_postgres16.py
```

Expected: all pass, zero skips (verify the summary reports no `s`).

- [ ] **Step 5: Web vitest**

Run (workdir `/workspace/elvsentiment-wt-sourcefail/apps/web`):

```bash
/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Web PG integration**

Run (workdir `/workspace/elvsentiment-wt-sourcefail/apps/web`):

```bash
/workspace/sc-research/impl/sourcefail-20261110/run-clean env POSTGRES_TEST_URL="$POSTGRES_TEST_URL" POSTGRES_TEST_LOG_PATH="$POSTGRES_TEST_LOG_PATH" /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/vitest run src/db/postgres16.integration.test.ts src/db/scoring-postgres16.integration.test.ts
```

Expected: both files pass, no skipped tests.

- [ ] **Step 7: Typecheck, lint, offline build**

Run (workdir `/workspace/elvsentiment-wt-sourcefail/apps/web`):

```bash
/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/next typegen
/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/tsc --noEmit
/workspace/sc-research/impl/sourcefail-20261110/run-clean /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/eslint
/workspace/sc-research/impl/sourcefail-20261110/run-clean env NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/workspace/elvsentiment-wt-sourcefail/.tooling/font-responses.cjs NEXT_TELEMETRY_DISABLED=1 /workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin/next build
```

Expected: each exits 0. If `next typegen` needs the `npm run typecheck` wrapper instead, use `/workspace/sc-research/impl/sourcefail-20261110/run-clean env PATH=/usr/local/bin:/usr/bin:/bin:/workspace/elvsentiment-wt-sourcefail/apps/web/node_modules/.bin npm run typecheck` and record the exact command.

- [ ] **Step 8: Stop and remove disposable PG**

Run:

```bash
PG=/workspace/elvsentiment-wt-sourcefail/.tooling/venv/lib/python3.12/site-packages/pgserver/pginstall/bin
"$PG/pg_ctl" -D /workspace/sc-research/impl/sourcefail-20261110/pg/data -m fast stop
rm -rf /workspace/sc-research/impl/sourcefail-20261110/pg/data
```

- [ ] **Step 9: Record notes and commit plan/notes if tracked**

Write `/workspace/sc-research/impl/sourcefail-20261110/notes.md` with: behaviour change, skills invoked (writing-plans, systematic-debugging, test-driven-development, executing-plans, verification-before-completion), RED→GREEN list, files changed, gate table (command, cwd, exit code, exact counts), migration needed (no), 001–011 hash confirmation, follow-ups, open questions for QA.

Run (workdir `/workspace/elvsentiment-wt-sourcefail`):

```bash
git status --short
git log --oneline de21b15f59003c16e885a03437f95b3f2dd4635d..HEAD
```

Expected: only intended files tracked; `.tooling` and disposable PG artifacts are ignored. Do not commit `notes.md` outside the worktree unless it is already under an ignored path.
