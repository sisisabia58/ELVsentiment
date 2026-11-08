# Truthful Source Status and Explicit Provider Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make configured-but-untested sources render honestly, fail ScrapeCreators responses with safe codes, report real collection counts, and let `worker_role` upsert `source_status` without breaking tenant isolation or provider-error visibility.

**Architecture:** The web derives a UI-only `untested` state from configuration plus the absence of a `source_status` row; the database enum is unchanged. The worker validates provider envelopes at the fetch boundary, wraps only fetch failures in a typed `SourceFetchError`, writes mentions+cursor atomically, then writes source status in a separate transaction so provider detail survives bookkeeping failure. A new additive migration grants `worker_role` select/insert/update on `source_status` only, with separate policies and no delete.

**Tech Stack:** Python 3.12, pytest, psycopg 3, urllib; TypeScript, Next.js 16, React 19, Vitest, PGlite; PostgreSQL 16.

**Spec:** `docs/superpowers/specs/2026-11-08-source-status-truth-design.md`

## Global Constraints

- Migrations `001` through `009` stay byte-identical. Only `010_source_status_worker.sql` is added.
- `source_status.state` keeps `ready | unavailable | authorization_failed | rate_limited`; `untested` is UI-only.
- `worker_role` gets select, insert, update on `source_status`; no delete. `app_user` grants/policies do not change.
- No `collection_runs` schema change, no scoring/quota/default-source/X behavior change.
- No network/provider calls in tests. Mock `opener` only. Never read `.env`.
- Never set or use `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SCRAPECREATORS_API_KEY`, `THREADS_ACCESS_TOKEN`, `TYPESAFE_API_KEY`, `JEV_API_KEY`, `X_BEARER_TOKEN`, or `OPENROUTER_API_KEY`. Only `POSTGRES_TEST_URL` points at the disposable local PG16.
- Logs never contain keywords, post text, URLs, keys, headers, request URLs, or raw exception strings. Unknown errors log class name plus a safe code.
- Mentions and cursor stay atomic. Status bookkeeping never joins that transaction.
- Ready is written only after provider success and a committed mention/cursor write.
- Failure upserts preserve `last_success_at`.
- Commit per task. Do not push.
- Temporary files go under `.tooling/`.

## Review Focus

- `success:false` with a valid-looking post list must fail as `success_false`, never look like an empty success.
- A present empty post list is success; a missing list key is `missing_posts`; a non-list value is `malformed_posts`.
- A status-write failure after a provider failure must leave the job's detail equal to the provider detail and must not roll back mentions/cursor.
- `saved` must come from inserted rows (`insert ... on conflict do nothing returning id`), not from parsed or deduplicated counts.
- Configured sources with no row must never render `Tidak tersedia` and must never be marked `ready`.

---

### Task 1: Web truthful source state and copy

**Files:**
- Modify: `apps/web/src/monitor/load.ts:23-29,111-137,303-314,404`
- Modify: `apps/web/src/monitor/source-status.ts:3-14`
- Modify: `apps/web/src/components/source-status-list.tsx:5-10`
- Modify: `apps/web/src/projects/dashboard-status.ts:63-68`
- Test: `apps/web/src/monitor/source-status.test.ts`
- Test: `apps/web/src/monitor/monitor.test.ts`
- Test: `apps/web/src/monitor/source-availability.test.ts`
- Test: `apps/web/src/components/onboarding.test.tsx`

**Interfaces:**
- Produces: `type RecordedSourceState = "ready" | "unavailable" | "authorization_failed" | "rate_limited"`.
- Produces: `type SourceHealth["state"] = RecordedSourceState | "untested"`.
- Produces: `export function resolveSourceState(configured: boolean, rowState?: RecordedSourceState | null): SourceHealth["state"]`.
- Produces: `sourceStatusLines` and all label maps understand `untested`.

- [ ] **Step 1: Write failing web state tests**

Add to `apps/web/src/monitor/source-status.test.ts`:

```ts
import { resolveSourceState } from "./load";

it("derives untested only for configured sources with no row", () => {
  expect(resolveSourceState(false, null)).toBe("unavailable");
  expect(resolveSourceState(false, "ready")).toBe("unavailable");
  expect(resolveSourceState(true, null)).toBe("untested");
  for (const state of ["ready", "unavailable", "authorization_failed", "rate_limited"] as const) {
    expect(resolveSourceState(true, state)).toBe(state);
  }
});

it("renders Belum diuji for a configured source without a row", () => {
  expect(sourceStatusLines([{ source: "threads", state: "untested", configured: true }])).toEqual([
    "Status Threads: Belum diuji",
  ]);
});
```

Add to `apps/web/src/monitor/monitor.test.ts`:

```ts
it("marks a configured but never-tested source untested, not unavailable or ready", async () => {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  const owner = await registerOwner(db, { email: "untested@example.com", password: "sandi-panjang" });
  const project = await createProject(db, owner.customerId, "Kopi Uji");
  const previous = {
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN,
    SCRAPECREATORS_API_KEY: process.env.SCRAPECREATORS_API_KEY,
  };
  process.env.X_BEARER_TOKEN = "test-x";
  process.env.SCRAPECREATORS_API_KEY = "test-sc";
  try {
    const workspace = await loadWorkspace(db, owner.customerId, project.projectId, new Date(), readLimits());
    const x = workspace.sources.find((item) => item.source === "x");
    expect(x).toMatchObject({ configured: true, state: "untested", detail: "", lastSuccessAt: null });
    expect(workspace.sources.every((item) => item.state === "untested")).toBe(true);
    expect(dashboardFor(workspace, "7", "all", new Date()).partial).toBe(false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

it("treats a recorded failure as partial and preserves its last success", async () => {
  const workspace = {
    ...({} as Workspace),
    mentions: [],
    sources: [
      { source: "x", state: "ready", detail: "ok", lastSuccessAt: "2026-11-01T00:00:00.000Z", configured: true },
      { source: "threads", state: "authorization_failed", detail: "threads_http_401", lastSuccessAt: "2026-10-01T00:00:00.000Z", configured: true },
      { source: "instagram", state: "untested", detail: "", lastSuccessAt: null, configured: true },
      { source: "tiktok", state: "unavailable", detail: "", lastSuccessAt: null, configured: false },
    ],
  } as Workspace;
  expect(dashboardFor(workspace, "7", "all", new Date()).partial).toBe(true);
});
```

Add to `apps/web/src/monitor/source-availability.test.ts`:

```ts
it("does not call a configured source unavailable in settings or onboarding copy", () => {
  render(
    createElement(SourceChoices, {
      credentials: { x: true, threads: true, instagram: true, tiktok: true },
      selected: ["x", "threads"],
      onChange: () => undefined,
    }),
  );
  expect(screen.queryByText(/sedang tidak tersedia/)).toBeNull();
});
```

Add to `apps/web/src/components/onboarding.test.tsx`:

```ts
it("labels an untested source as Belum diuji", () => {
  render(<SourceStatusList reports={[{ source: "threads", state: "untested", outcome: "success", fetchedCount: 0 }]} />);
  expect(screen.getByText("Belum diuji")).toBeTruthy();
  expect(screen.queryByText("Tidak tersedia")).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run in `apps/web`:

```bash
env -u DATABASE_URL -u WORKER_DATABASE_URL -u MIGRATION_DATABASE_URL -u SCRAPECREATORS_API_KEY -u THREADS_ACCESS_TOKEN -u TYPESAFE_API_KEY -u JEV_API_KEY -u X_BEARER_TOKEN -u OPENROUTER_API_KEY npx -y node@24 node_modules/vitest/vitest.mjs run src/monitor/source-status.test.ts src/monitor/monitor.test.ts src/monitor/source-availability.test.ts src/components/onboarding.test.tsx
```

Expected: FAIL because `untested` and `resolveSourceState` do not exist.

- [ ] **Step 3: Implement the state resolver and copy**

In `apps/web/src/monitor/load.ts`:

```ts
export type RecordedSourceState = "ready" | "unavailable" | "authorization_failed" | "rate_limited";
export type SourceHealth = {
  source: SourceId;
  state: RecordedSourceState | "untested";
  detail: string;
  lastSuccessAt: string | null;
  configured: boolean;
};

export function resolveSourceState(
  configured: boolean,
  rowState?: RecordedSourceState | null,
): SourceHealth["state"] {
  if (!configured) return "unavailable";
  return rowState ?? "untested";
}
```

Add `untested: "Belum diuji"` to `SOURCE_COPY`. Update `sourceHealthCopy`:

```ts
if (!health.configured) return `Sumber ${name} sedang tidak tersedia, kami sedang memperbaikinya.`;
if (health.state === "untested") {
  return `Sumber ${name} sudah dikonfigurasi dan belum diuji. Pengumpulan berikutnya akan menguji aksesnya.`;
}
if (health.state === "unavailable") return `Sumber ${name} sedang tidak tersedia, kami sedang memperbaikinya.`;
```

Change the loader state line to:

```ts
const state = resolveSourceState(configured, row?.state ?? null);
```

Change `dashboardFor` partial to:

```ts
partial: workspace.sources.some(
  (item) => !item.configured || item.state === "unavailable" || item.state === "authorization_failed" || item.state === "rate_limited",
),
```

Add `untested: "Belum diuji"` to the label maps in `source-status.ts`, `source-status-list.tsx`, and `dashboard-status.ts`. In `sourceStatusLines`, handle unconfigured first, then `untested`, then existing states. Keep `selectedSourcesReady` credential-based; do not require `ready`.

- [ ] **Step 4: Run the tests to verify they pass**

Use the Step 2 command. Expected: all listed tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/monitor/load.ts apps/web/src/monitor/source-status.ts apps/web/src/components/source-status-list.tsx apps/web/src/projects/dashboard-status.ts apps/web/src/monitor/source-status.test.ts apps/web/src/monitor/monitor.test.ts apps/web/src/monitor/source-availability.test.ts apps/web/src/components/onboarding.test.tsx
git commit -m "feat(web): derive untested source state truthfully"
```

---

### Task 2: Migration 010 and worker status permissions

**Files:**
- Create: `apps/web/src/db/sql/010_source_status_worker.sql`
- Test: `apps/worker/tests/test_postgres16.py`

**Interfaces:**
- Produces: migration `010_source_status_worker.sql` with `grant select, insert, update on source_status to worker_role` and policies `source_status_worker_select`, `source_status_worker_insert`, `source_status_worker_update`.
- Produces: real-PG assertions that `worker_role` can upsert and read cross-tenant `source_status`, cannot delete it, and `app_user` RLS is unchanged.

- [ ] **Step 1: Write failing migration tests**

Add to `apps/worker/tests/test_postgres16.py` after the 009 migration test:

```python
def test_migration_010_grants_only_worker_source_status_dml():
    path = SQL_DIR / "010_source_status_worker.sql"
    assert path.is_file(), "010_source_status_worker.sql must exist"
    sql = path.read_text(encoding="utf-8").lower()
    grants = [line for line in sql.splitlines() if line.startswith("grant")]
    assert grants == ["grant select, insert, update on source_status to worker_role;"]
    for policy in (
        "source_status_worker_select",
        "source_status_worker_insert",
        "source_status_worker_update",
    ):
        assert f"create policy {policy} on source_status" in sql
    assert "for delete" not in sql


def test_postgres16_migration_010_worker_status_permissions_and_tenant_isolation(pg16):
    conn = pg16
    _seed(conn)
    checksum = hashlib.sha256((SQL_DIR / "010_source_status_worker.sql").read_bytes()).hexdigest()
    assert conn.execute(
        "select checksum from schema_migrations where filename = '010_source_status_worker.sql'"
    ).fetchone() == (checksum,)

    privileges = conn.execute(
        """
        select has_table_privilege('worker_role', 'public.source_status', 'select'),
               has_table_privilege('worker_role', 'public.source_status', 'insert'),
               has_table_privilege('worker_role', 'public.source_status', 'update'),
               has_table_privilege('worker_role', 'public.source_status', 'delete'),
               has_table_privilege('app_user', 'public.source_status', 'delete')
        """
    ).fetchone()
    assert privileges == (True, True, True, False, True)

    policies = dict(
        conn.execute(
            "select polname, polcmd from pg_policy where polrelid = 'public.source_status'::regclass"
        ).fetchall()
    )
    assert policies["source_status_worker_select"] == "r"
    assert policies["source_status_worker_insert"] == "a"
    assert policies["source_status_worker_update"] == "w"
    assert "source_status_worker_delete" not in policies

    project_b = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    conn.execute(
        "insert into projects (id, customer_id, brand_name, created_at) values (%s, %s, %s, now())",
        (project_b, CUSTOMER_B, "tenant b"),
    )
    conn.commit()

    conn.execute("begin")
    conn.execute("set local role worker_role")
    conn.execute(
        """
        insert into source_status (customer_id, project_id, source, state, detail, updated_at)
        values (%s, %s, 'threads', 'ready', 'ok', now()),
               (%s, %s, 'threads', 'unavailable', 'threads_http_500', now())
        on conflict (customer_id, project_id, source) do update
          set state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at
        """,
        (CUSTOMER_A, PROJECT_A, CUSTOMER_B, project_b),
    )
    assert conn.execute("select count(*) from source_status").fetchone() == (2,)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("delete from source_status")
    conn.rollback()

    conn.execute("begin")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_A,))
    conn.execute("set local role app_user")
    visible = conn.execute("select customer_id::text from source_status").fetchall()
    assert visible == [(CUSTOMER_A,)]
    conn.rollback()

    roles = dict(
        conn.execute(
            "select rolname, rolsuper or rolbypassrls from pg_roles where rolname in ('app_user','worker_role')"
        ).fetchall()
    )
    assert roles == {"app_user": False, "worker_role": False}
```

Add the real-PG test fixture's database migration checksum assertion through the existing `_apply_schema`; it already applies all `*.sql` files.

- [ ] **Step 2: Run the failing test**

Start disposable PG16 per `.tooling/README-tooling.txt`:

```bash
.tooling/venv/lib/python3.12/site-packages/pgserver/pginstall/bin/initdb -D .pgdata -U postgres --auth=trust
.tooling/venv/lib/python3.12/site-packages/pgserver/pginstall/bin/pg_ctl -D .pgdata -o "-k $PWD/.tooling -h '' -p 55441" -w start
export POSTGRES_TEST_URL="postgresql://postgres@/postgres?host=$PWD/.tooling&port=55441"
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling POSTGRES_TEST_URL="$POSTGRES_TEST_URL" PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_postgres16.py
```

Expected: FAIL because `010_source_status_worker.sql` is missing.

- [ ] **Step 3: Add the migration**

Create `apps/web/src/db/sql/010_source_status_worker.sql`:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: all `test_postgres16.py` tests PASS, none skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/db/sql/010_source_status_worker.sql apps/worker/tests/test_postgres16.py
git commit -m "feat(db): let worker upsert source status without delete"
```

---

### Task 3: ScrapeCreators envelope validation and safe errors

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py:1-59`
- Test: `apps/worker/tests/test_scrapecreators.py` (create)

**Interfaces:**
- Produces: `class ScrapeCreatorsError(Exception)` with attributes `code: str`, `http_status: int | None`, `credits_charged: int | None`; `str(error) == code`.
- Produces: `fetch_scrapecreators_json(...)` raises `ScrapeCreatorsError("http_<status>")` for non-2xx, `malformed_json`, `malformed_envelope`, or `success_false`.
- Produces: `credits_from(payload: dict[str, Any]) -> int | None`, returning a numeric top-level `credits_charged`, never a bool, never 0 when absent.
- Produces: `select_post_list(payload, keys: tuple[str, ...]) -> list` returning the first present key; raises `missing_posts` or `malformed_posts`.

- [ ] **Step 1: Write failing envelope tests**

Create `apps/worker/tests/test_scrapecreators.py`:

```python
import io
import json
import urllib.error

import pytest

from sentiment_monitor.sources.scrapecreators import (
    ScrapeCreatorsError,
    credits_from,
    fetch_scrapecreators_json,
    select_post_list,
)


class Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _fetch(body, status_ok=True):
    def opener(request, timeout=0):
        if not status_ok:
            raise urllib.error.HTTPError(request.full_url, 429, "rate", {}, None)
        return Response(body)

    return fetch_scrapecreators_json("/v1/threads/search", {"query": "rahasia"}, "key", opener=opener)


def test_success_false_is_explicit_failure_with_credits():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch(json.dumps({"success": False, "message": "keyword rahasia", "credits_charged": 7}))
    error = caught.value
    assert error.code == "success_false"
    assert error.credits_charged == 7
    assert "rahasia" not in str(error)


def test_malformed_json_and_non_object_fail_safely():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch("{not-json")
    assert caught.value.code == "malformed_json"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch("[1, 2, 3]")
    assert caught.value.code == "malformed_envelope"


def test_non_2xx_becomes_http_code():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _fetch("{}", status_ok=False)
    assert caught.value.code == "http_429"
    assert caught.value.http_status == 429


def test_credits_excludes_bool_and_absent_is_unknown():
    assert credits_from({"credits_charged": 3}) == 3
    assert credits_from({"credits_charged": 3.0}) == 3
    assert credits_from({"credits_charged": True}) is None
    assert credits_from({}) is None


def test_select_post_list_distinguishes_missing_empty_and_malformed():
    assert select_post_list({"posts": []}, ("posts", "items")) == []
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"items": []}, ("posts",))
    assert caught.value.code == "missing_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": {"bad": True}}, ("posts",))
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        select_post_list({"posts": [1, 2]}, ("posts",))
    assert caught.value.code == "malformed_posts"
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scrapecreators.py
```

Expected: FAIL with import errors for `ScrapeCreatorsError`, `credits_from`, `select_post_list`.

- [ ] **Step 3: Implement validation in `scrapecreators.py`**

Implement:

```python
class ScrapeCreatorsError(Exception):
    def __init__(self, code: str, *, http_status: int | None = None, credits_charged: int | None = None):
        super().__init__(code)
        self.code = code
        self.http_status = http_status
        self.credits_charged = credits_charged
```

Inside `fetch_scrapecreators_json`:

```python
try:
    with opener(request, timeout=30) as response:
        raw = response.read()
except urllib.error.HTTPError as error:
    raise ScrapeCreatorsError(f"http_{error.code}", http_status=error.code) from None
try:
    data = json.loads(raw)
except (json.JSONDecodeError, UnicodeDecodeError):
    raise ScrapeCreatorsError("malformed_json") from None
if not isinstance(data, dict):
    raise ScrapeCreatorsError("malformed_envelope")
if data.get("success") is False:
    raise ScrapeCreatorsError("success_false", credits_charged=credits_from(data))
return data
```

`credits_from` returns `value` when `type(value) is int`, `int(value)` when `isinstance(value, float)` and `value.is_integer()`, else `None`. `select_post_list` returns the first key present when its value is a list; raises `missing_posts` when no key is present; raises `malformed_posts` when the first present value is not a list or a non-empty list has no dict entries. A present empty list returns `[]`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/sources/scrapecreators.py apps/worker/tests/test_scrapecreators.py
git commit -m "feat(worker): validate ScrapeCreators envelopes with safe codes"
```

---

### Task 4: Per-source list validation and counts

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/threads.py:69-94`
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py:79-131`
- Modify: `apps/worker/sentiment_monitor/sources/tiktok.py:51-91`
- Test: `apps/worker/tests/test_threads_source.py`
- Test: `apps/worker/tests/test_instagram_source.py`
- Test: `apps/worker/tests/test_tiktok_source.py`

**Interfaces:**
- Produces: every source result includes `counts: {"returned": int, "parsed": int, "deduplicated": int}` and optional `credits_charged: int | None`.
- Produces: list keys — Threads `("posts", "items", "data")`; Instagram reels `("reels", "items", "data")`, hashtag `("posts", "items", "medias", "data")`; TikTok both `("search_item_list", "aweme_list", "items", "data")`.
- Produces: a present empty list is success; a missing key raises `missing_posts`; a malformed list raises `malformed_posts`.

- [ ] **Step 1: Write failing per-source tests**

Add to `apps/worker/tests/test_threads_source.py`:

```python
import pytest
from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError


class Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _threads(payload):
    return fetch_threads_mentions("kopi", "key", "2026-11-01T00:00:00Z", opener=lambda *a, **k: Response(json.dumps(payload)))


def test_threads_present_empty_list_is_success_with_zero_counts():
    result = _threads({"posts": []})
    assert result["mentions"] == []
    assert result["counts"] == {"returned": 0, "parsed": 0, "deduplicated": 0}


def test_threads_reports_returned_parsed_and_deduplicated():
    result = _threads({"posts": [{"pk": "1"}, {"pk": "1"}, {"pk": "2"}]})
    assert result["counts"] == {"returned": 3, "parsed": 3, "deduplicated": 1}


@pytest.mark.parametrize("key", ["posts", "items", "data"])
def test_threads_accepts_each_recognized_key(key):
    assert _threads({key: []})["counts"]["returned"] == 0


def test_threads_missing_or_malformed_list_fails_safely():
    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"unexpected": []})
    assert caught.value.code == "missing_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": {"bad": True}})
    assert caught.value.code == "malformed_posts"
    with pytest.raises(ScrapeCreatorsError) as caught:
        _threads({"posts": [1, 2]})
    assert caught.value.code == "malformed_posts"
```

Add analogous tests to Instagram:

```python
def test_instagram_counts_sum_both_calls_and_dedupe():
    ...opener returns reels with two entries (one duplicate) and hashtag with one duplicate...
    assert result["counts"] == {"returned": 3, "parsed": 3, "deduplicated": 1}


@pytest.mark.parametrize("key", ["reels", "items", "data"])
def test_instagram_reels_accepts_each_key(key): ...
@pytest.mark.parametrize("key", ["posts", "items", "medias", "data"])
def test_instagram_hashtag_accepts_each_key(key): ...
def test_instagram_missing_or_malformed_list_fails_safely(): ...
```

Add analogous tests to TikTok:

```python
@pytest.mark.parametrize("key", ["search_item_list", "aweme_list", "items", "data"])
def test_tiktok_accepts_each_key_on_both_endpoints(key): ...
def test_tiktok_counts_sum_both_calls_and_dedupe(): ...
def test_tiktok_missing_or_malformed_list_fails_safely(): ...
```

Keep existing normalization and request tests passing.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_threads_source.py apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py
```

Expected: FAIL on missing `counts` and on missing-key behavior.

- [ ] **Step 3: Implement counts and list validation**

In each source:
1. Call `select_post_list(payload, KEYS)` for each endpoint.
2. `returned` is the sum of raw list lengths before filtering/normalization.
3. `parsed` is the number of normalized dict entries produced before deduplication.
4. `deduplicated` is `parsed - len(unique)`.
5. Include `credits_charged` summed across calls; `None` if no call reported one.
6. Keep Threads `outcome` as its current `"empty_or_success"`; keep Instagram/TikTok `"success"`. Empty lists still succeed.

Do not filter raw lists before counting. For Threads/IG, count only dict entries in `parsed`; TikTok currently filters dicts in `_extract_tiktok_list`, so return both the raw list and the dict list from the helper (or inline the filtering).

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: all three files PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/sources/threads.py apps/worker/sentiment_monitor/sources/instagram.py apps/worker/sentiment_monitor/sources/tiktok.py apps/worker/tests/test_threads_source.py apps/worker/tests/test_instagram_source.py apps/worker/tests/test_tiktok_source.py
git commit -m "feat(worker): validate source lists and report distinct counts"
```

---

### Task 5: Actual inserted count from the mention write

**Files:**
- Modify: `apps/worker/sentiment_monitor/pg_store.py:61-118`
- Modify: `apps/worker/tests/test_pg_store.py`
- Test: `apps/worker/tests/test_postgres16.py`

**Interfaces:**
- Produces: `PostgresStore.write_mentions_and_cursor(...) -> int` returning the number of rows returned by `insert ... on conflict do nothing returning id`.
- Produces: missing driver rows yield `0`, never `parsed`.
- Produces: real-PG tests for dedup and cursor rollback.

- [ ] **Step 1: Write failing saved-count tests**

Add to `apps/worker/tests/test_pg_store.py`:

```python
class InsertRowsTx(Tx):
    def __init__(self, rows):
        super().__init__()
        self.rows = rows

    def execute(self, sql, params=None):
        result = super().execute(sql, params)
        if "insert into mentions" in sql:
            return self.rows
        return result


def test_saved_count_comes_from_inserted_rows_not_parsed():
    tx = InsertRowsTx([{"id": "one"}, {"id": "two"}])
    saved = PostgresStore(tx).write_mentions_and_cursor(
        customer_id="customer-a",
        project_id="project-1",
        query_key="q",
        source="threads",
        mentions=[MENTION, {**MENTION, "external_id": "101"}, {**MENTION, "external_id": "102"}],
        next_cursor="cursor-2",
    )
    assert saved == 2
    assert "returning id" in "\n".join(tx.statements).lower()


def test_saved_is_zero_when_the_driver_returns_no_rows():
    tx = Tx()
    saved = PostgresStore(tx).write_mentions_and_cursor(
        customer_id="customer-a",
        project_id="project-1",
        query_key="q",
        source="threads",
        mentions=[MENTION],
        next_cursor=None,
    )
    assert saved == 0
```

Add to `apps/worker/tests/test_postgres16.py`:

```python
def test_postgres16_mention_write_returns_real_inserted_count_and_rolls_back_on_failure(pg16):
    from sentiment_monitor.pg_store import PostgresStore

    conn = pg16
    _seed(conn)
    conn.execute("begin")
    conn.execute("set local role worker_role")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_A,))
    store = PostgresStore(CursorRowAdapter(conn))
    mention = {
        "external_id": "dedup-1",
        "excerpt": "uji",
        "url": None,
        "author": "a",
        "posted_at": "2026-11-01T00:00:00+00:00",
        "variant": "uji",
    }
    assert store.write_mentions_and_cursor(
        customer_id=CUSTOMER_A,
        project_id=PROJECT_A,
        query_key="q",
        source="threads",
        mentions=[mention, mention],
        next_cursor="cursor-1",
    ) == 1
    conn.rollback()

    conn.execute("begin")
    conn.execute("set local role worker_role")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_A,))
    store = PostgresStore(CursorRowAdapter(conn))
    try:
        store.write_mentions_and_cursor(
            customer_id=CUSTOMER_A,
            project_id=PROJECT_A,
            query_key="q",
            source="threads",
            mentions=[mention, {**mention, "source": "threads", "external_id": "bad", "posted_at": "not-a-time"}],
            next_cursor="cursor-2",
        )
    except Exception:
        pass
    conn.rollback()
    assert conn.execute("select count(*) from mentions").fetchone() == (0,)
    assert conn.execute("select count(*) from source_cursors").fetchone() == (0,)
```

Import `CursorRowAdapter` from `sentiment_monitor.scheduler` in that test.

- [ ] **Step 2: Run the failing tests**

Unit:

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_pg_store.py
```

Expected: FAIL because `write_mentions_and_cursor` returns `None`.

Real PG: use the Task 2 start command with `POSTGRES_TEST_URL` and run `apps/worker/tests/test_postgres16.py`. Expected: FAIL on the new test.

- [ ] **Step 3: Return saved rows**

Change the mention insert to:

```sql
insert into mentions (...) values (...)
on conflict (customer_id, source, external_id) do nothing
returning id
```

Process each mention sequentially and add `len(rows)` to `saved` when the result is a non-empty sequence; treat `None` as zero. Return `saved` after the commit. Keep cursor/mention atomicity unchanged.

In `scheduler.store_source`, return the value from `write_mentions_and_cursor`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/pg_store.py apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_pg_store.py apps/worker/tests/test_postgres16.py
git commit -m "feat(worker): report actually inserted mention rows"
```

---

### Task 6: Scheduler safe detail, explicit state, and status upserts

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py:243-294,358-378`
- Test: `apps/worker/tests/test_scheduler.py`
- Test: `apps/worker/tests/test_postgres16.py`

**Interfaces:**
- Produces: `record_source_failure(conn, customer_id, project_id, source, detail, state)`; upsert sets `state`, `detail`, `updated_at`; never assigns `last_success_at`.
- Produces: `record_source_success(conn, customer_id, project_id, source)`; upsert sets `state='ready'`, `detail='ok'`, `last_success_at=now()`, `updated_at=now()`.
- Produces: `source_failure_state(detail: str, http_status: int | None = None) -> str` with deterministic HTTP mapping only (401/403 auth, 402/429 rate, else unavailable).
- Produces: `_failure_detail` handles `ScrapeCreatorsError` as `<source>_<code>`.

- [ ] **Step 1: Write failing scheduler unit tests**

Replace the old `record_source_failure` assertions in `test_failure_detail_and_record_source_failure_for_scrapecreators_and_x` with:

```python
from sentiment_monitor.scheduler import (
    ScrapeCreatorsError,
    record_source_failure,
    record_source_success,
    source_failure_state,
)

assert _failure_detail(ScrapeCreatorsError("success_false"), source="threads") == "threads_success_false"
assert _failure_detail(ScrapeCreatorsError("http_402", http_status=402), source="instagram") == "instagram_http_402"
assert _failure_detail(ig_402, source="instagram") == "instagram_http_402"

assert source_failure_state("threads_http_401", 401) == "authorization_failed"
assert source_failure_state("threads_http_403", 403) == "authorization_failed"
assert source_failure_state("instagram_http_402", 402) == "rate_limited"
assert source_failure_state("tiktok_http_429", 429) == "rate_limited"
assert source_failure_state("threads_success_false", None) == "unavailable"
assert source_failure_state("weird_provider_text_402", None) == "unavailable"

conn = _FakeConn()
assert record_source_failure(conn, "cust-1", "proj-1", "instagram", "instagram_http_402", "rate_limited") == "rate_limited"
assert record_source_failure(conn, "cust-1", "proj-1", "tiktok", "tiktok_http_401", "authorization_failed") == "authorization_failed"
assert record_source_failure(conn, "cust-1", "proj-1", "threads", "threads_http_500", "unavailable") == "unavailable"
record_source_success(conn, "cust-1", "proj-1", "threads")
assert len(conn.calls) == 4
failure_sql = " ".join(conn.calls[0][0].lower().split())
assert "on conflict (customer_id, project_id, source) do update" in failure_sql
assert "last_success_at" not in failure_sql
success_sql = " ".join(conn.calls[3][0].lower().split())
assert "last_success_at = now()" in success_sql
assert "'ready'" in conn.calls[3][1]
assert "'ok'" in conn.calls[3][1]
```

Add to `apps/worker/tests/test_postgres16.py`:

```python
def test_postgres16_worker_status_success_and_failure_preserves_last_success(pg16):
    from sentiment_monitor.scheduler import record_source_failure, record_source_success

    conn = pg16
    _seed(conn)
    conn.execute("begin")
    conn.execute("set local role worker_role")
    record_source_success(conn, CUSTOMER_A, PROJECT_A, "threads")
    conn.commit()
    first = conn.execute(
        "select state, detail, last_success_at is not null from source_status where source = 'threads'"
    ).fetchone()
    assert first == ("ready", "ok", True)

    conn.execute("begin")
    conn.execute("set local role worker_role")
    record_source_failure(conn, CUSTOMER_A, PROJECT_A, "threads", "threads_http_401", "authorization_failed")
    conn.commit()
    second = conn.execute(
        "select state, detail, last_success_at is not null from source_status where source = 'threads'"
    ).fetchone()
    assert second == ("authorization_failed", "threads_http_401", True)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `apps/worker/tests/test_scheduler.py` with the unit command from Task 3/4. Expected: FAIL on missing `ScrapeCreatorsError`, `source_failure_state`, and new signatures. Real PG: FAIL on missing functions.

- [ ] **Step 3: Implement functions**

```python
def source_failure_state(detail: str, http_status: int | None = None) -> str:
    status = http_status
    if status is None:
        match = re.search(r"_http_(\d{3})$", detail or "")
        status = int(match.group(1)) if match else None
    if status in (401, 403):
        return "authorization_failed"
    if status in (402, 429):
        return "rate_limited"
    return "unavailable"


def record_source_failure(conn, customer_id, project_id, source, detail, state) -> str:
    conn.execute(
        """
        insert into source_status (customer_id, project_id, source, state, detail, updated_at)
        values (%s, %s, %s, %s, %s, now())
        on conflict (customer_id, project_id, source) do update
          set state = excluded.state,
              detail = excluded.detail,
              updated_at = excluded.updated_at
        """,
        (customer_id, project_id, source, state, detail),
    )
    return state


def record_source_success(conn, customer_id, project_id, source) -> None:
    conn.execute(
        """
        insert into source_status (customer_id, project_id, source, state, detail, last_success_at, updated_at)
        values (%s, %s, %s, 'ready', 'ok', now(), now())
        on conflict (customer_id, project_id, source) do update
          set state = 'ready',
              detail = 'ok',
              last_success_at = now(),
              updated_at = now()
        """,
        (customer_id, project_id, source),
    )
```

Extend `_failure_detail` before the generic branches:

```python
if isinstance(error, ScrapeCreatorsError):
    return f"{source}_{error.code}"
```

Import `re` and `ScrapeCreatorsError`.

- [ ] **Step 4: Run the tests to verify they pass**

Run both Step 2 commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py apps/worker/tests/test_postgres16.py
git commit -m "feat(worker): explicit source failure state and ready upsert"
```

---

### Task 7: Serve fetch guard, isolated status writes, and safe logs

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py:207-214,311-328,358-378,388-554`
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Produces: `class SourceFetchError(Exception)` with `detail`, `state`, `http_status`, `credits_charged`.
- Produces: `_unpack_fetched(result, variant) -> (mentions, next_cursor, counts)`; legacy tuple results get `returned = parsed = len(raw)` and `deduplicated = 0`.
- Produces: `source_collection` log line with `job_id`, `project_id`, `source`, `outcome`, four counts, `http_status`, `credits_charged`, `detail`.
- Produces: `source_status_write_failed` log line with job/project/source and safe error class/code.
- Produces: provider failure writes status then fails job with provider detail; storage failure writes no status; status write failure does not change job detail.

- [ ] **Step 1: Write failing serve tests**

Add to `apps/worker/tests/test_scheduler.py`:

```python
def test_serve_writes_ready_after_success_and_logs_safe_counts(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(_variant):
        return {
            "mentions": [
                {"external_id": "1", "excerpt": "aman", "url": None, "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": _variant},
                {"external_id": "1", "excerpt": "aman", "url": None, "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": _variant},
            ],
            "counts": {"returned": 3, "parsed": 2, "deduplicated": 1},
            "credits_charged": 2,
        }

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
        )

    status = [params for sql, params in world.calls if "insert into source_status" in sql.lower()]
    assert status and status[-1][3] == "threads"
    collection_line = next(line for line in lines if line.startswith("source_collection"))
    assert "job_id=job-1" in collection_line
    assert "project_id=project-1" in collection_line
    assert "source=threads" in collection_line
    assert "returned=3" in collection_line
    assert "parsed=2" in collection_line
    assert "deduplicated=1" in collection_line
    assert "saved=" in collection_line
    assert "credits_charged=2" in collection_line
    assert "geprek" not in collection_line
    assert "aman" not in collection_line


def test_provider_failure_writes_failure_and_fails_with_safe_detail(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]

    def fetch_threads(_variant):
        raise ScrapeCreatorsError("success_false", credits_charged=4)

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
        )

    status_params = [params for sql, params in world.calls if "insert into source_status" in sql.lower()]
    assert status_params == [("customer-a", "project-1", "threads", "unavailable", "threads_success_false")]
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql.lower() and "claim_expired" not in sql.lower()]
    assert failed == [("threads_success_false", "job-1")]


def test_status_write_failure_does_not_replace_provider_detail_or_rollback_mentions(tmp_path):
    from sentiment_monitor.sources.scrapecreators import ScrapeCreatorsError

    class StatusFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into source_status" in sql.lower():
                raise RuntimeError("status write failed with secret provider text")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]

    def fetch_threads(_variant):
        raise ScrapeCreatorsError("http_401", http_status=401)

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StatusFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
        )

    failed = [params for sql, params in world.calls if "status = 'failed'" in sql.lower() and "claim_expired" not in sql.lower()]
    assert failed == [("threads_http_401", "job-1")]


def test_status_write_failure_on_success_keeps_mentions_and_succeeds_the_job(tmp_path):
    class StatusFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into source_status" in sql.lower():
                raise RuntimeError("status write failed")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]
    lines = []

    def fetch_threads(_variant):
        return {
            "mentions": [{"external_id": "1", "excerpt": "aman", "url": None, "author": "a", "posted_at": "2026-11-01T00:00:00Z", "variant": _variant}],
            "counts": {"returned": 1, "parsed": 1, "deduplicated": 0},
        }

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StatusFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
            log=lines.append,
        )

    joined = "\n".join(sql for sql, _params in world.calls).lower()
    mention_at = joined.index("insert into mentions")
    cursor_at = joined.index("insert into source_cursors", mention_at)
    succeeded_at = joined.index("status = 'succeeded'", cursor_at)
    assert mention_at < cursor_at < succeeded_at
    assert any(line.startswith("source_status_write_failed") for line in lines)


def test_storage_failure_does_not_write_source_status(tmp_path):
    class StoreFailConn(_LoopConn):
        def execute(self, sql, params=None):
            if "insert into mentions" in sql.lower():
                raise RuntimeError("database unavailable")
            return super().execute(sql, params)

    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    world.sources = ["threads"]

    def fetch_threads(_variant):
        return {"mentions": [], "counts": {"returned": 0, "parsed": 0, "deduplicated": 0}}

    def stop(_seconds):
        raise SystemExit

    with pytest.raises(SystemExit):
        serve(
            lambda: StoreFailConn(world),
            stop,
            load_limits(Path("config/limits.json"), {}),
            "worker-1",
            _policy_root(tmp_path, True),
            lambda *_args, **_kwargs: ([], None),
            fetch_threads,
        )

    assert not any("insert into source_status" in sql.lower() for sql, _params in world.calls)
    failed = [params for sql, params in world.calls if "status = 'failed'" in sql.lower() and "claim_expired" not in sql.lower()]
    assert failed == [("storage_failed", "job-1")]
```

Also update the existing exact-log tests (`test_fetch_error_is_redacted...`, `test_failed_status_update_is_redacted...`) to assert absence of secrets/URL/`Traceback` and presence of safe class names instead of exact `[redacted]` strings.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_scheduler.py
```

Expected: FAIL because serve does not write status or emit structured logs.

- [ ] **Step 3: Implement guard, status writes, and logs**

Add:

```python
class SourceFetchError(Exception):
    def __init__(self, detail: str, state: str, *, http_status: int | None = None, credits_charged: int | None = None):
        super().__init__(detail)
        self.detail = detail
        self.state = state
        self.http_status = http_status
        self.credits_charged = credits_charged
```

Wrap only fetch calls:

```python
def _guarded_fetch(source: str, fetch):
    try:
        return fetch()
    except SourceFetchError:
        raise
    except ScrapeCreatorsError as error:
        raise SourceFetchError(
            f"{source}_{error.code}",
            source_failure_state(error.code, error.http_status),
            http_status=error.http_status,
            credits_charged=error.credits_charged,
        ) from None
    except Exception as error:
        detail = _failure_detail(error, source)
        raise SourceFetchError(
            detail,
            source_failure_state(detail, getattr(error, "code", None)),
            http_status=getattr(error, "code", None),
        ) from None
```

Wrap `fetch_x` inside the `fetch_page` callback, and wrap Threads/Instagram/TikTok calls directly. Do not wrap `store_source`, `_call`, or admission calls.

Change `_unpack_fetched` to return `(normalized, next_cursor, counts)`. Read `result["counts"]` when present and valid; otherwise default `returned = parsed = len(raw_mentions)`, `deduplicated = 0`.

After each successful `store_source` (which now returns `saved`):
1. Call `record_source_success` in its own `_call`.
2. Catch status errors, emit `source_status_write_failed` with a safe error label, and continue.
3. Emit `source_collection` with `outcome=success`, counts, `saved`, `http_status=-`, credits, `detail=ok`.

In the outer `except`:
1. If `SourceFetchError`: capture detail/state before bookkeeping; call `record_source_failure(..., detail, state)` in its own `_call`; catch/log status errors separately; emit `source_collection outcome=failed` with zero counts and safe detail; call `_fail(job_id, detail)`.
2. Else: emit `source_collection outcome=storage_failed detail=storage_failed`; do **not** write `source_status`; call `_fail(job_id, "storage_failed")`.

Sanitize `_log_exception`:

```python
def _safe_error_label(error: Exception) -> str:
    code = getattr(error, "detail", None) or getattr(error, "code", None)
    if not isinstance(code, str) or not re.fullmatch(r"[a-z0-9_]+", code):
        code = "unknown_error"
    return f"{type(error).__name__} {code}"
```

Print `format_log(_safe_error_label(error))`, never `str(error)`.

Add a `_log_collection` helper taking `log` and emitting the exact field order from the spec. Use `format_log` and `-` for absent HTTP/credits.

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/tests/test_scheduler.py
git commit -m "feat(worker): isolate source status writes and log safe counts"
```

---

### Task 8: Full verification and self-review

**Files:** none expected; fix valid findings only.

- [ ] **Step 1: Run the full worker suite with real PG**

With PG16 running and `POSTGRES_TEST_URL` exported:

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling POSTGRES_TEST_URL="$POSTGRES_TEST_URL" PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests
```

Expected: all tests pass, zero skipped.

- [ ] **Step 2: Run web tests**

In `apps/web`:

```bash
env -u DATABASE_URL -u WORKER_DATABASE_URL -u MIGRATION_DATABASE_URL -u SCRAPECREATORS_API_KEY -u THREADS_ACCESS_TOKEN -u TYPESAFE_API_KEY -u JEV_API_KEY -u X_BEARER_TOKEN -u OPENROUTER_API_KEY POSTGRES_TEST_URL="$POSTGRES_TEST_URL" npx -y node@24 node_modules/vitest/vitest.mjs run
```

Expected: all tests pass.

- [ ] **Step 3: Run typecheck, lint, and build**

In `apps/web`:

```bash
env -u DATABASE_URL -u WORKER_DATABASE_URL -u MIGRATION_DATABASE_URL -u SCRAPECREATORS_API_KEY -u THREADS_ACCESS_TOKEN -u TYPESAFE_API_KEY -u JEV_API_KEY -u X_BEARER_TOKEN -u OPENROUTER_API_KEY npm run typecheck
env -u DATABASE_URL -u WORKER_DATABASE_URL -u MIGRATION_DATABASE_URL -u SCRAPECREATORS_API_KEY -u THREADS_ACCESS_TOKEN -u TYPESAFE_API_KEY -u JEV_API_KEY -u X_BEARER_TOKEN -u OPENROUTER_API_KEY npm run lint
env -u DATABASE_URL -u WORKER_DATABASE_URL -u MIGRATION_DATABASE_URL -u SCRAPECREATORS_API_KEY -u THREADS_ACCESS_TOKEN -u TYPESAFE_API_KEY -u JEV_API_KEY -u X_BEARER_TOKEN -u OPENROUTER_API_KEY npm run build
```

Expected: all succeed.

- [ ] **Step 4: Self-review against the spec**

Check each spec section against the diff:
- §6.1: `untested` derived, all listed surfaces consistent, `selectedSourcesReady` still credential-based, `partial` excludes untested/ready.
- §6.2: every safe code path, no provider text, list keys, empty-vs-missing.
- §6.3: four counts distinct, saved from returning rows, log fields and redaction.
- §6.4: fetch-only guard, separate status transaction, failure preserves `last_success_at`, storage failure writes no status, ready only after commit.
- §6.5: migration exact, no delete, no app_user changes.
- §6.6: all listed tests exist and run.

Fix valid findings, rerun affected commands, then commit any fixes:

```bash
git add -A
git commit -m "fix(worker): address source status self-review findings"
```

If no findings, do not create an empty commit.

- [ ] **Step 5: Stop Postgres**

```bash
.tooling/venv/lib/python3.12/site-packages/pgserver/pginstall/bin/pg_ctl -D .pgdata stop
```

---

## Spec Assumptions Checked Against Current Code

1. **Threads outcome name:** The spec says Threads keeps `empty_unconfirmed`, but `fetch_threads_mentions` currently returns `empty_or_success`. This plan preserves `empty_or_success` to avoid changing existing callers and treats empty Threads as a successful provider response for status purposes.
2. **Settings/onboarding copy:** The real settings/onboarding UI uses `SourceChoices`, which only reports unconfigured credentials as unavailable and never shows a status row. `SourceStatusList` is used by tests, not by the current app pages. This plan adds `untested` to its labels and pins that configured sources are never called unavailable; it does not invent a status-row consumer in settings.
3. **Dashboard summary fallback:** `readProjectCollection.sourceStateSummary` has no credential data, so it cannot derive `untested`; it already avoids calling a missing row "Tidak tersedia". The main dashboard uses `sourceStatusLines(workspace.sources)`, which does derive `untested`.
4. **`credits_charged` shape:** No provider call is made. The helper reads only a numeric top-level `credits_charged`; absent means unknown (`-`), never `0`.
5. **Migration number:** `009` is the highest existing file; `010` is next and `001`–`009` remain untouched.
