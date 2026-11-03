# Sentiment Monitor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a monitor-only Indonesian web dashboard that collects brand-mention candidates from X and Threads through Harken, scores each post once with Jev, and lets the owner review results without drafting, posting, or sending any external alert.

**Architecture:** The customer app is a Next.js App Router UI and HTTP API over Postgres, with one owner account per customer and row-level isolation. A separate Python worker imports Harken as a library, calls the existing X source and a new Threads source adapter, and writes mention rows and the Harken cursor into Postgres in one transaction. It does not post candidates to the web process. Our API sends one combined Jev request per post, stores the original judgment apart from any owner correction, and renders the dashboard. Harken's `Pipeline.track`, lexicon sentiment, alerts, Jinja UI, and instance-wide accounts are not on this path.

**Tech Stack:** Recommendation, not a decision: Next.js 16.4.3, React 19.3.1, TypeScript, Tailwind CSS 4, shadcn/ui, Postgres 16 with `@electric-sql/pglite` 0.5.14 in tests, Python 3.12 worker, Harken pinned to commit `d0710a427dbbe712594ef3a6c25112e1d14cc027` (MIT), Vitest 5.0.5, pytest. **Needs review by the CTO and the user before Task 1.**

## Global Constraints

Every task includes these rules. Values are copied from the approved spec.

- The MVP ends at scoring results and owner review: no reply drafts, auto-replies, or text generation.
- v1 surfaces all results and notifications in the web dashboard only.
- External alert channels (e.g., Telegram, email, Slack, push, WhatsApp), requiring a separate future scope decision, are out of v1.
- Reply drafting is explicitly outside v1.
- Reuse Harken’s existing X source and collection engine; projects and keyword variants are stored in our own backend and passed to Harken as queries.
- Build the new Threads source as a Harken source adapter; Harken is the collection engine only.
- Do not expose Harken’s built-in Jinja dashboard or instance-wide (global) role auth to customers.
- Layout ideas may be borrowed from Harken’s MIT-licensed dashboard, but Harken’s dashboard UI is not reused.
- Harken’s English lexicon or optional LLM sentiment must not silently substitute for Jev.
- Use deterministic word combinations rather than generated text; owners can review, add, and remove variants before activation.
- For “ayam geprek pak gembus,” support the supplied example variants without requiring only an exact full-name match.
- Prefer one combined Jev request per post covering relevance, sentiment, and topics, rather than separate calls per judgment.
- Jev is called via TypeSafe AI’s direct API (`api.typesafe.ai/v1/systemone`) as primary, with OpenRouter (`typesafe/jev-1.14`) as fallback.
- Use Jev’s classification/scoring primitives and calibrated confidence, not text generation.
- Evaluate relevance before including mentions in aggregate results. Confidently irrelevant items are excluded; uncertain items enter review rather than being silently discarded.
- Preserve raw Jev judgments and confidence separately from owner corrections.
- Corrections do not imply model retraining.
- Failed scoring is never rendered as neutral.
- Never present unavailable collection as zero mentions.
- Show “No scored mentions” rather than zero for an empty denominator.
- Proposed implementation: `100 × (positive − negative) / all included mentions`, yielding −100 to +100. This formula needs validation and approval; it is not Jev confidence.
- Deduplicate a post matching multiple variants; do not multiply-count it in aggregates or in-app attention items/indicators.
- Low-confidence items must not be presented as confidently negative Needs attention items and should follow existing Not sure routing.
- “High impact” needs an agreed definition and verified source metadata; do not invent an impact score or imply unavailable reach data.
- Do not silently reclassify old data.
- The interface is Indonesian-first and mobile-friendly, with SME-friendly wording.
- Use text labels in addition to sentiment colors and support keyboard-accessible review controls.
- Keep the interface focused on monitoring, with no reply composer or publish control.
- Source status distinguishes ready, unavailable, authorization failed, and rate-limited states.
- Do not substitute unsupported scraping for Threads.
- Launch is blocked until Indonesian and informal/slang Indonesian evaluation meets predefined relevance, sentiment, topic, and confidence-routing criteria. The dataset and numeric thresholds remain open and must be agreed before evaluation.
- Launch of the stated two-source MVP is blocked until Threads access is demonstrated and X access, cost exposure, and applicable limits are understood. A reduced-source launch requires an explicit scope decision.
- Our own backend stores customers/accounts with per-customer isolation.
- Avoid copying post content or credentials into analytics events.
- Do not collect private content or unnecessary personal data.
- Configure confidence thresholds only after Indonesian evaluation.
- Collection is trigger-based. The worker is one always-on replica. It claims due rows from `jobs` with `SELECT ... FOR UPDATE SKIP LOCKED`. There is no Railway cron service.
- Harken stays at commit `d0710a427dbbe712594ef3a6c25112e1d14cc027`, unmodified and unforked. Cursors live in Postgres. A cursor advances only in the same transaction that writes the mentions.
- Credential mode is `shared_operator` with `approved` false. v1 has no per-customer source-token encryption.
- Caps and intervals ship as config and env values. Defaults: X post reads `20000` a month global and `2000` a month per customer; Threads reserve `1500` of `2200` per rolling 24 hours; scheduled collections at least `6` hours apart; manual runs at least `900` seconds apart per customer; at most `5` jobs per worker pass; poll `20` seconds (allowed range 15–30); heartbeat stale after `90` seconds.
- The web runtime role is `app_user`: not the table owner, not a superuser, `NOBYPASSRLS`. Tenant tables use `FORCE ROW LEVEL SECURITY`. Each request sets the tenant with `SET LOCAL` inside a transaction. The worker uses `worker_role`.
- Postgres image tag is `postgres:16.15`. Region is Singapore (`asia-southeast1`, Railway id `asia-southeast1-eqsg3a`).
- Secrets are Railway variables and are redacted in logs. The repo has `.env.example` and no `.env` file.

---

## Scope check

Collection, scoring, review, and the dashboard are one monitoring workflow. A plan that stopped after collection would not be the smallest usable monitor the spec asks for, so this stays one plan. Recruiting 5–10 SME owners is not a software task; it stays in Open questions.

## Repository name

Name: `sentiment-monitor`, private. Package names inside this plan use that name (`sentiment-monitor-web`, `sentiment-monitor-worker`). The GitHub owner (personal account or org) is still open. Do not publish the repository as part of implementation.

## Review gate

Do not start Task 1 until the CTO and the user have accepted the stack recommendation below, or have written a replacement. If they replace it, rewrite the file paths in every task before writing code. The approval flags committed by this plan all stay `false`. An implementer does not flip them.

## Stack recommendation

**Needs review by the CTO and the user.**

### Recommendation

Use two processes in this repository:

1. `apps/web` — Next.js 16.4.3 App Router, TypeScript, Tailwind CSS 4, shadcn/ui. This process owns accounts, projects, keyword variants, Jev calls, review state, read/unread state, and the Indonesian UI. Postgres is the customer system of record. Tests run the same SQL on PGlite.
2. `apps/worker` — Python 3.12. It installs Harken from Git at commit `d0710a427dbbe712594ef3a6c25112e1d14cc027` and imports it as a library. It does not fork Harken and it does not edit that checkout. It constructs `XSource` and our `ThreadsSource`. Cursor state is a Postgres adapter in the worker that implements Harken's cursor methods. The worker does not construct `harken.store.Store`, does not open a database file, and has no Railway volume. It writes mention rows and the cursor in one Postgres transaction. It does not run `harken serve`.

The worker service is always on, with one replica, and runs `python -m sentiment_monitor.scheduler`. That process loops over a `jobs` table. Collection runs only when triggered: the owner's "Kumpulkan sekarang" action inserts a due job, or a per-customer schedule stored on the project becomes due. There is no Railway cron service and no global cron timer. See Collection triggers and scheduling.

### Harken as a library inside the web process

The web process would import Harken in-process. That only works if the web process is Python. Next.js cannot import Harken. A FastAPI process could. Collection would then share a fate with the dashboard: a stuck X retry or a Harken crash would sit in the same process as owner sessions. Harken's `Pipeline.track` also writes lexicon or optional LLM sentiment and can send webhook or email alerts. Calling it would violate the monitor-only and Jev-only rules. In-process use is viable only as a direct call to `Source.fetch_page` and `Store`, never `Pipeline.track` and never `harken.web`.

### Harken as a separate upstream service

Run upstream `harken serve` and pull mentions from its HTTP API or its on-disk database. That service is the Jinja dashboard plus instance-wide roles. The spec forbids exposing either to customers. The same `Pipeline.track` path applies lexicon sentiment and the alert transports. Wrapping that service would mean maintaining a product boundary Harken does not have: it has no per-customer isolation. This is the wrong process boundary for v1.

### Why the recommendation is the worker

The worker gets Harken's source interface, per-query dedup, and retries without mounting its UI or auth. Customer isolation lives in our Postgres, which Harken's global roles cannot express. The dashboard stays up if a source call fails. The worker connects with `WORKER_DATABASE_URL` as `worker_role` and writes candidates itself. A cursor advances only in the same transaction that writes the mentions.

### Pinned Harken surface

Verified against commit `d0710a427dbbe712594ef3a6c25112e1d14cc027`:

- `harken.sources.base.Source.fetch(self, query: str, limit: int = 50) -> list[Mention]`
- `Source.fetch_page(self, query: str, limit: int = 50, *, cursor: str | None = None, since: datetime | None = None) -> FetchPage`
- `FetchPage(mentions: list[Mention], next_cursor: str | None = None)`
- `harken.sources.x.XSource(bearer_token: str | None = None)` calls `GET https://api.x.com/2/tweets/search/recent`. `max_results` is clamped to 10..100. Missing token raises `RuntimeError`.
- `harken.sources.REGISTRY: dict[str, type[Source]]` is a mutable dict. Our process adds `threads` there. We do not edit installed Harken files and we do not fork in v1.
- `harken.store.Store` persists cursors in its own database file after `record_source_success`. Our worker does not construct that class. Task 22's `PostgresStore` implements `source_state`, `record_source_error`, and `record_source_success` against Postgres. `record_source_success` writes the cursor on the open mention transaction and does not commit by itself. A failed mention write rolls the cursor back with the mentions.
- `Pipeline.track` always runs lexicon sentiment unless `HARKEN_SENTIMENT_ANALYZER=llm`, and it delivers webhook and email alerts when those settings exist. Both are forbidden on our path. Worker modules must not import `harken.pipeline`, `harken.analyze`, `harken.alerts`, or `harken.web`.

## Deployment on Railway

User decision, 1 Nov 2026: deploy on Railway. Team-lead decisions the same day fix the service shape, the database image, cursors, and backups. Railway docs read 1 Nov 2026 are cited inline.

- **Region:** Singapore. Every service uses Railway region `asia-southeast1-eqsg3a` (Southeast Asia, `asia-southeast1`). It is Railway's only Asia-Pacific region. There is no Indonesia region. https://docs.railway.com/reference/deployment-regions
- **Services:** one Railway project, one production environment. No cron schedule on any service (`deploy.cronSchedule` is unset).
  - `web`: root directory `apps/web`, public domain, `DATABASE_URL` logs in as `app_user`.
  - `worker`: root directory `apps/worker`, always on, `deploy.numReplicas = 1`, start command `python -m sentiment_monitor.scheduler`, `WORKER_DATABASE_URL` logs in as `worker_role`. The worker service has no volume.
  - `postgres`: Docker image `postgres:16.15` (official image, major 16, tag pinned; `postgres:16` is not used because it moves). Private networking only. https://hub.docker.com/_/postgres/ and https://docs.railway.com/guides/postgresql
  - Watch paths stop a change in one app from rebuilding the other. Railway config files in this repo use absolute paths from the repo root (`/apps/web/railway.toml`, `/apps/worker/railway.toml`). https://docs.railway.com/guides/monorepo
- **Network:** the worker reaches Postgres at the private hostname Railway injects into `WORKER_DATABASE_URL`. It does not call the web process to store mentions. https://docs.railway.com/reference/private-networking
- **Secrets:** names live in `.env.example` with empty secret values. Production values are Railway service variables. No `.env` file is committed. Logs pass through `format_log`, which replaces those values with `[redacted]`.
- **Roles:** `app_user` and `worker_role` are `NOSUPERUSER` and `NOBYPASSRLS`, and neither owns the tables. The migration owner is a third role and is not the web or worker runtime login. Tenant tables use `FORCE ROW LEVEL SECURITY`. The web request sets the tenant with `SET LOCAL` inside the transaction (`withCustomer`).
- **Cursors:** rows in `source_cursors`. Harken at `d0710a427dbbe712594ef3a6c25112e1d14cc027` stays unmodified. The worker does not open a database file and does not mount a volume.
- **Backups:** a nightly `pg_dump` to off-Railway storage is the backup plan. `BACKUP_DESTINATION` is the config value and defaults to empty. Task 22's `describe_backup` returns `built: false` and `status: not_built`. The dump command is not implemented and the scheduler does not call it. It stays that way until the user sets a destination.
- **Spending:** in-app caps in `config/limits.json` are enforced before any X or Threads call. A Railway workspace hard limit is only a backstop, set in the Railway dashboard, not in application code. Railway's minimum hard limit is $10, and hitting it takes every service offline, including the dashboard. https://docs.railway.com/reference/usage-limits
- **Plan tier:** Hobby ($5/month, includes $5 usage) and Pro ($20/month, includes $20 usage) are both unpublished choices. This plan does not select one. Usage on top of the included amount: RAM $10/GB/month, CPU $20/vCPU/month, egress $0.05/GB. https://docs.railway.com/reference/pricing/plans

## Collection triggers and scheduling

Collection runs only when a row in `jobs` is due. Nothing collects on a timer that is shared by every customer.

- **Schedules (Task 8):** `project_schedules` stores `enabled`, `interval_hours`, `time_zone` (`Asia/Jakarta`), and `next_run_at` per project. A project with `enabled = false` is collected only when the owner asks. The minimum interval is `schedule_min_interval_hours` in `config/limits.json`, default `6`. The worker inserts a `scheduled` job when `next_run_at` has passed. There is no crontab.
- **Run now (Task 8 and Task 16):** the button `Kumpulkan sekarang` calls `requestManualRun`, which inserts a `manual` job with `run_after = now()` and `status = 'queued'`. The request does not call X or Threads. The same customer cannot insert another manual job until `manual_min_interval_seconds` has passed, default `900` (15 minutes).
- **Worker (Task 22):** one replica runs a loop. Each pass writes `worker_heartbeat`, enqueues due schedules, and claims at most `max_jobs_per_tick` jobs (default `5`) with `SELECT ... FOR UPDATE SKIP LOCKED`. The sleep between passes is `worker_poll_seconds`, default `20`, and the loader rejects a value outside 15–30. A queued manual job is claimed on the next pass.
- **Heartbeat:** one row, `worker_heartbeat.id = 1`. The UI shows `Worker offline` when `last_seen_at` is missing or older than `worker_heartbeat_stale_seconds`, default `90`.
- **Guards, checked before the source call, from counters in Postgres:**
  1. Schedule interval and manual interval, as above.
  2. X post reads, default `20000` a month global and `2000` a month per customer, both under the 3 million platform cap. Task 12 reserves the count, then calls. A hit finishes the job with `x_global_cap` or `x_customer_cap`, `fetched_count` null, and the dashboard does not show zero.
  3. Threads: one shared rolling-24-hour counter. The reserve is `threads_rolling_24h_reserve`, default `1500`, against the platform `2200`. Task 12 checks it before every Threads query.
  4. `max_jobs_per_tick`, default `5`.
- **Refused jobs:** status `deferred` and a `status_detail` the owner can read. The copy is the limit sentence, never a zero count.
- **Defaults stay editable:** the numbers above are the committed defaults. The user can still change them. Open questions lists that confirmation as pending.

## File structure

| Path | Responsibility |
| --- | --- |
| `apps/web/src/domain/variants.ts` | Deterministic variants and save validation |
| `apps/web/src/domain/keyword-history.ts` | Keyword edits apply only to future collection |
| `apps/web/src/domain/routing.ts` | Policy type, Jev routing, failed-scoring result |
| `apps/web/src/domain/aggregates.ts` | Overview score, trend table, topic counts |
| `apps/web/src/domain/attention.ts` | Eligibility, dedupe, mark-as-seen |
| `apps/web/src/domain/display.ts` | Owner confirm/correct display state |
| `apps/web/src/db/sql/001_init.sql` | Tenant tables and forced RLS |
| `apps/web/src/db/migrate.ts` | Apply SQL and run a function as `app_user` |
| `apps/web/src/auth/password.ts` | scrypt password hashes |
| `apps/web/src/auth/accounts.ts` | Owner registration and session cookie |
| `apps/web/src/projects/handlers.ts` | Brand project and active variant set |
| `apps/web/src/projects/schedules.ts` | Per-project schedule and manual job insert |
| `apps/web/src/db/sql/002_schedules_jobs.sql` | Schedules, jobs, cursors, heartbeat |
| `apps/web/src/ingest/mentions.ts` | Idempotent candidate insert |
| `apps/web/src/jev/questions.ts` | One combined System One body |
| `apps/web/src/jev/client.ts` | TypeSafe primary, OpenRouter fallback |
| `apps/web/src/scoring/jobs.ts` | Claim, save, retry, correction |
| `apps/web/src/sources/status.ts` | The four source states and their copy |
| `apps/web/src/analytics/events.ts` | Allowlisted events with no post text |
| `apps/web/src/components/` | Indonesian presentational UI |
| `apps/web/src/app/` | Routes only. No reply route |
| `apps/worker/sentiment_monitor/collect.py` | X and Threads collection |
| `apps/worker/sentiment_monitor/sources/threads.py` | Harken `Source` subclass |
| `apps/worker/sentiment_monitor/x_cost.py` | Cited X price, caps, and the Threads guard |
| `apps/worker/sentiment_monitor/scheduler.py` | Poll loop, claim, heartbeat |
| `apps/worker/sentiment_monitor/pg_store.py` | Harken cursor methods on Postgres |
| `apps/worker/sentiment_monitor/limits.py` | Defaults and env overrides |
| `apps/worker/sentiment_monitor/backup.py` | Nightly dump plan, not built |
| `config/limits.json` | Cap, interval, poll, and batch defaults |
| `config/*.json` | Approval flags and limits |
| `.env.example` | Variable names only. No `.env` file |
| `eval/gate.py` | Compare a user-supplied labelled file to predictions |
| `eval/launch_gate.py` | Block launch while a required flag is false |
| `README.md` | What this repo is and how to run it |

## Out of v1

No reply composer, no publish control, no text-generation call, no Telegram, email, Slack, push, or WhatsApp delivery, no extra social source, no Harken export UI, no theme clustering, no account role other than owner, no model training on corrections, no scraping. Pricing, team features, and per-customer X accounts are out of v1. The worker does not encrypt source tokens and does not ship unused crypto for that.

## Approval file

Create this in Task 20 if a later task has not already created it. Tasks 1–19 read it only when their own step says so. Initial contents:

```json
{
  "stack_reviewed": false,
  "credential_policy": false,
  "scoring_policy": false,
  "topic_labels": false,
  "topic_counting": false,
  "overview_formula": false,
  "jev_fallback_rule": false,
  "eval_criteria": false,
  "threads_public_search_demonstrated": false,
  "x_cost_understood": false,
  "reduced_source_launch": null,
  "high_impact": false
}
```

`reduced_source_launch` may later be set by the user to `"x_only_approved"`. No other string is valid. `high_impact` must stay `false` because this plan defines no high-impact rule.

---

### Task 1: Scaffold the web app and generate keyword variants

**Files:**
- Create: `apps/web/` via the scaffold command below
- Create: `apps/web/src/domain/variants.ts`
- Test: `apps/web/src/domain/variants.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeVariant(raw: string): string` and `generateCandidates(brandName: string): string[]`. The result is lowercase Indonesian locale, internal whitespace collapsed to one space, and it always includes the normalized full name when the name is non-empty. For two or more tokens, it also includes every phrase made by deleting exactly one token when at least two tokens remain. For four or more tokens, it also includes every phrase made by deleting the first token and then exactly one more token when at least two tokens remain.

**Acceptance criteria:**
- Covers AC-1 (the example variants exist without an exact-only match). Empty and duplicate saves are Task 2.
- `generateCandidates("ayam geprek pak gembus")` contains `ayam geprek pak gembus`, `geprek pak gembus`, `geprek gembus`, and `ayam pak gembus`.
- The function does not call a network API.

- [ ] **Step 1: Scaffold the app**

Run from the repository root:

```bash
npx create-next-app@16.4.3 apps/web --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes --disable-git --no-agent-feedback
```

Expected: `apps/web/package.json` exists and `apps/web/src/app/page.tsx` exists.

Then:

```bash
npm install --prefix apps/web -D vitest@5.0.5
```

Write `apps/web/vitest.config.mts`:

```ts
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
});
```

In `apps/web/package.json`, set the scripts:

```json
{
  "dev": "next dev --hostname 0.0.0.0 --port 43123",
  "test": "vitest run",
  "typecheck": "next typegen && tsc --noEmit"
}
```

Task 1 landed on main with this Vitest file and this typecheck script. Later tasks keep `apps/web/vitest.config.mts` and `import.meta.dirname`. Do not switch the config back to `vitest.config.ts` or `__dirname`.

Keep the `build`, `start`, and `lint` scripts the scaffold wrote.

- [ ] **Step 2: Write the failing test**

Write `apps/web/src/domain/variants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateCandidates, normalizeVariant } from "./variants";

describe("generateCandidates", () => {
  it("normalizes Indonesian whitespace and case", () => {
    expect(normalizeVariant("  Ayam   Geprek ")).toBe("ayam geprek");
  });

  it("includes the spec examples for ayam geprek pak gembus", () => {
    const found = generateCandidates("ayam geprek pak gembus");
    expect(found).toContain("ayam geprek pak gembus");
    expect(found).toContain("geprek pak gembus");
    expect(found).toContain("geprek gembus");
    expect(found).toContain("ayam pak gembus");
    expect(found).not.toContain("tempe gembus");
  });

  it("returns no candidates for a blank name", () => {
    expect(generateCandidates("   ")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/domain/variants.test.ts`

Expected: FAIL. Vitest cannot resolve `./variants`.

- [ ] **Step 4: Write the minimal implementation**

Write `apps/web/src/domain/variants.ts`:

```ts
export function normalizeVariant(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
}

export function generateCandidates(brandName: string): string[] {
  const full = normalizeVariant(brandName);
  const tokens = full.split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) return [];
  const found = new Set<string>([full]);
  if (tokens.length >= 2) {
    for (let index = 0; index < tokens.length; index += 1) {
      const phrase = tokens.filter((_, tokenIndex) => tokenIndex !== index).join(" ");
      if (phrase.split(" ").length >= 2) found.add(phrase);
    }
  }
  if (tokens.length >= 4) {
    const rest = tokens.slice(1);
    for (let index = 0; index < rest.length; index += 1) {
      const phrase = rest.filter((_, tokenIndex) => tokenIndex !== index).join(" ");
      if (phrase.split(" ").length >= 2) found.add(phrase);
    }
  }
  return [...found];
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/domain/variants.test.ts`

Expected: PASS. 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: generate deterministic brand keyword variants"
```

---

### Task 2: Reject empty and duplicate variants

**Files:**
- Modify: `apps/web/src/domain/variants.ts`
- Test: `apps/web/src/domain/variants.test.ts`

**Interfaces:**
- Consumes: `normalizeVariant(raw: string): string`
- Produces: `validateVariantList(variants: string[]): { ok: true; variants: string[] } | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string }`. Success returns normalized, de-duplicated-by-rejection variants in input order. A variant longer than 512 characters fails with `too_long` because X recent search rejects a query longer than 512 characters (`https://docs.x.com/x-api/fundamentals/rate-limits.md`, row `GET /2/tweets/search/recent`).

**Acceptance criteria:**
- Covers AC-1: empty or duplicate variants cannot be saved.
- `"  "` fails with `empty`. A second `geprek gembus` fails with `duplicate`. A 513-character string fails with `too_long`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/domain/variants.test.ts` inside the file, after the existing imports add `validateVariantList`, and add:

```ts
describe("validateVariantList", () => {
  it("rejects an empty variant", () => {
    expect(validateVariantList(["geprek gembus", "   "])).toEqual({
      ok: false,
      reason: "empty",
      value: "   ",
    });
  });

  it("rejects a duplicate after normalization", () => {
    expect(validateVariantList(["Geprek Gembus", "geprek   gembus"])).toEqual({
      ok: false,
      reason: "duplicate",
      value: "geprek   gembus",
    });
  });

  it("rejects a variant longer than the X query limit", () => {
    const value = "a".repeat(513);
    expect(validateVariantList([value])).toEqual({ ok: false, reason: "too_long", value });
  });

  it("returns the normalized active set", () => {
    expect(validateVariantList(["Geprek Gembus", "Ayam Pak Gembus"])).toEqual({
      ok: true,
      variants: ["geprek gembus", "ayam pak gembus"],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/domain/variants.test.ts`

Expected: FAIL. `validateVariantList` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `apps/web/src/domain/variants.ts`:

```ts
const X_QUERY_LIMIT = 512;

export type VariantListResult =
  | { ok: true; variants: string[] }
  | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string };

export function validateVariantList(variants: string[]): VariantListResult {
  const kept: string[] = [];
  for (const value of variants) {
    const normalized = normalizeVariant(value);
    if (normalized.length === 0) return { ok: false, reason: "empty", value };
    if ([...normalized].length > X_QUERY_LIMIT) return { ok: false, reason: "too_long", value };
    if (kept.includes(normalized)) return { ok: false, reason: "duplicate", value };
    kept.push(normalized);
  }
  return { ok: true, variants: kept };
}
```

Length uses code points via the iterator spread so a long Indonesian string is counted in characters, matching the limit the owner sees. X's 512 is a character limit in the official rate-limit notes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/domain/variants.test.ts`

Expected: PASS. 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/domain/variants.ts apps/web/src/domain/variants.test.ts
git commit -m "feat: reject empty, duplicate, and over-long variants"
```

---

### Task 3: Keep keyword edits from reclassifying history

**Files:**
- Create: `apps/web/src/domain/keyword-history.ts`
- Test: `apps/web/src/domain/keyword-history.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `effectOfKeywordEdit(activeVariants: readonly string[]): { futureQueries: readonly string[]; reclassifyExisting: false }`

**Acceptance criteria:**
- Covers the spec rule "do not silently reclassify old data."
- The return value's `reclassifyExisting` is the literal `false`, not a boolean variable another task can flip.
- Historical coverage, cadence, and timezone stay open. This task does not choose them.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/domain/keyword-history.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { effectOfKeywordEdit } from "./keyword-history";

describe("effectOfKeywordEdit", () => {
  it("keeps the new queries and never reclassifies stored mentions", () => {
    const effect = effectOfKeywordEdit(["geprek gembus", "ayam pak gembus"]);
    expect(effect.futureQueries).toEqual(["geprek gembus", "ayam pak gembus"]);
    expect(effect.reclassifyExisting).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/domain/keyword-history.test.ts`

Expected: FAIL. Cannot resolve `./keyword-history`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/domain/keyword-history.ts`:

```ts
export type KeywordEditEffect = {
  futureQueries: readonly string[];
  reclassifyExisting: false;
};

export function effectOfKeywordEdit(activeVariants: readonly string[]): KeywordEditEffect {
  return { futureQueries: [...activeVariants], reclassifyExisting: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/domain/keyword-history.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/domain/keyword-history.ts apps/web/src/domain/keyword-history.test.ts
git commit -m "feat: keep keyword edits from reclassifying stored mentions"
```

---

### Task 4: Route Jev judgments without treating failure as neutral

**Files:**
- Create: `apps/web/src/domain/routing.ts`
- Test: `apps/web/src/domain/routing.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ScoringPolicy` with fields `approved: boolean`, `relevanceExcludeMax: number | null`, `relevanceIncludeMin: number | null`, `sentimentConfidenceMin: number | null`, `topicNoulMin: number | null`, `attentionNegativeConfidenceMin: number | null`, `fallbackTopicId: string | null`
  - `ParsedJudgment` with `relevanceNoul: number`, `sentiment: "positive" | "neutral" | "negative"`, `sentimentConfidence: number`, `topicNouls: { id: string; noul: number }[]`
  - `routeJudgment(judgment: ParsedJudgment, policy: ScoringPolicy): RouteDecision`
  - `failedScoring(): FailedScoring` where `FailedScoring` is `{ bucket: "failed"; sentiment: null; topics: readonly [] }`
  - `suggestedLabels(judgment: ParsedJudgment, policy: ScoringPolicy): { relevance: "relevant" | "irrelevant" | null; sentiment: "positive" | "neutral" | "negative" | null; topics: string[] }`

`RouteDecision` is:

```ts
{
  bucket: "included" | "excluded" | "not_sure" | "policy_unapproved";
  relevance: "relevant" | "irrelevant" | "uncertain" | "unapproved";
  sentiment: "positive" | "neutral" | "negative" | null;
  sentimentUncertain: boolean;
  topics: string[];
  topicsUncertain: boolean;
  topicSource: "thresholds" | "fallback" | "none";
}
```

Routing rules when `approved` is true and every numeric field is a number, with `relevanceExcludeMax < relevanceIncludeMin`:

- `relevanceNoul <= relevanceExcludeMax` → relevance `irrelevant`, bucket `excluded`, sentiment `null`, topics `[]`.
- `relevanceNoul >= relevanceIncludeMin` → relevance `relevant`. Otherwise relevance `uncertain` and bucket `not_sure`.
- A relevant row with `sentimentConfidence < sentimentConfidenceMin` has `sentimentUncertain: true` and bucket `not_sure`. Otherwise sentiment is the judgment's sentiment.
- Topic ids with `noul >= topicNoulMin` are kept. If none qualify and `fallbackTopicId` is a non-null string, topics are `[fallbackTopicId]` and `topicSource` is `fallback`. If none qualify and `fallbackTopicId` is null, `topicsUncertain` is true and bucket is `not_sure`.
- Bucket `included` only when relevance is `relevant`, sentiment is not uncertain, and topics are not uncertain.
- `approved: false` returns bucket `policy_unapproved` and does not read the numbers.
- `failedScoring()` returns sentiment `null`. It has no path that returns `"neutral"`.

The numbers used in tests are fixture inputs. They are not launch thresholds.

**Acceptance criteria:**
- Covers AC-2 and AC-3 and AC-5's routing half.
- A judgment with `relevanceNoul: 0.05` and `relevanceExcludeMax: 0.2` is `excluded`, so an unrelated "tempe gembus" post is not a confirmed mention.
- A judgment with `relevanceNoul: 0.5` is `not_sure`, not included and not discarded.
- `failedScoring().sentiment` is `null` and `failedScoring().bucket` is `"failed"`.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/domain/routing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { failedScoring, routeJudgment, suggestedLabels, type ScoringPolicy } from "./routing";

const policy: ScoringPolicy = {
  approved: true,
  relevanceExcludeMax: 0.2,
  relevanceIncludeMin: 0.8,
  sentimentConfidenceMin: 0.75,
  topicNoulMin: 0.7,
  attentionNegativeConfidenceMin: 0.8,
  fallbackTopicId: null,
};

describe("routeJudgment", () => {
  it("excludes a confidently irrelevant post", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.05, sentiment: "negative", sentimentConfidence: 0.99, topicNouls: [] },
      policy,
    );
    expect(route.bucket).toBe("excluded");
    expect(route.relevance).toBe("irrelevant");
    expect(route.sentiment).toBeNull();
  });

  it("routes an uncertain relevance score to review", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.5, sentiment: "neutral", sentimentConfidence: 0.99, topicNouls: [] },
      policy,
    );
    expect(route.bucket).toBe("not_sure");
    expect(route.relevance).toBe("uncertain");
  });

  it("holds a relevant post with a low sentiment confidence", () => {
    const route = routeJudgment(
      {
        relevanceNoul: 0.91,
        sentiment: "negative",
        sentimentConfidence: 0.4,
        topicNouls: [{ id: "harga", noul: 0.9 }],
      },
      policy,
    );
    expect(route.bucket).toBe("not_sure");
    expect(route.sentimentUncertain).toBe(true);
  });

  it("includes a relevant post when sentiment and topics clear the fixture thresholds", () => {
    const route = routeJudgment(
      {
        relevanceNoul: 0.95,
        sentiment: "positive",
        sentimentConfidence: 0.9,
        topicNouls: [{ id: "harga", noul: 0.91 }, { id: "rasa", noul: 0.2 }],
      },
      policy,
    );
    expect(route.bucket).toBe("included");
    expect(route.sentiment).toBe("positive");
    expect(route.topics).toEqual(["harga"]);
  });

  it("does not treat an unapproved policy as a final score", () => {
    const route = routeJudgment(
      { relevanceNoul: 0.99, sentiment: "positive", sentimentConfidence: 0.99, topicNouls: [] },
      { ...policy, approved: false },
    );
    expect(route.bucket).toBe("policy_unapproved");
  });
});

describe("failedScoring", () => {
  it("has no sentiment label", () => {
    expect(failedScoring()).toEqual({ bucket: "failed", sentiment: null, topics: [] });
  });
});

describe("suggestedLabels", () => {
  it("offers no sentiment suggestion when confidence is below the fixture minimum", () => {
    const suggestion = suggestedLabels(
      { relevanceNoul: 0.95, sentiment: "negative", sentimentConfidence: 0.4, topicNouls: [] },
      policy,
    );
    expect(suggestion.sentiment).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/domain/routing.test.ts`

Expected: FAIL. Cannot resolve `./routing`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/domain/routing.ts`:

```ts
export type ScoringPolicy = {
  approved: boolean;
  relevanceExcludeMax: number | null;
  relevanceIncludeMin: number | null;
  sentimentConfidenceMin: number | null;
  topicNoulMin: number | null;
  attentionNegativeConfidenceMin: number | null;
  fallbackTopicId: string | null;
};

export type ParsedJudgment = {
  relevanceNoul: number;
  sentiment: "positive" | "neutral" | "negative";
  sentimentConfidence: number;
  topicNouls: { id: string; noul: number }[];
};

export type RouteDecision = {
  bucket: "included" | "excluded" | "not_sure" | "policy_unapproved";
  relevance: "relevant" | "irrelevant" | "uncertain" | "unapproved";
  sentiment: "positive" | "neutral" | "negative" | null;
  sentimentUncertain: boolean;
  topics: string[];
  topicsUncertain: boolean;
  topicSource: "thresholds" | "fallback" | "none";
};

export type FailedScoring = { bucket: "failed"; sentiment: null; topics: readonly [] };

export type SuggestedLabels = {
  relevance: "relevant" | "irrelevant" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
};

function requireApprovedNumbers(policy: ScoringPolicy): {
  relevanceExcludeMax: number;
  relevanceIncludeMin: number;
  sentimentConfidenceMin: number;
  topicNoulMin: number;
} {
  const { relevanceExcludeMax, relevanceIncludeMin, sentimentConfidenceMin, topicNoulMin } = policy;
  if (
    relevanceExcludeMax === null ||
    relevanceIncludeMin === null ||
    sentimentConfidenceMin === null ||
    topicNoulMin === null ||
    !(relevanceExcludeMax < relevanceIncludeMin)
  ) {
    throw new Error("policy_incomplete");
  }
  return { relevanceExcludeMax, relevanceIncludeMin, sentimentConfidenceMin, topicNoulMin };
}

export function failedScoring(): FailedScoring {
  return { bucket: "failed", sentiment: null, topics: [] };
}

export function routeJudgment(judgment: ParsedJudgment, policy: ScoringPolicy): RouteDecision {
  if (!policy.approved) {
    return {
      bucket: "policy_unapproved",
      relevance: "unapproved",
      sentiment: null,
      sentimentUncertain: false,
      topics: [],
      topicsUncertain: false,
      topicSource: "none",
    };
  }
  const numbers = requireApprovedNumbers(policy);
  const base: RouteDecision = {
    bucket: "not_sure",
    relevance: "uncertain",
    sentiment: null,
    sentimentUncertain: false,
    topics: [],
    topicsUncertain: false,
    topicSource: "none",
  };
  if (judgment.relevanceNoul <= numbers.relevanceExcludeMax) {
    return { ...base, bucket: "excluded", relevance: "irrelevant" };
  }
  if (judgment.relevanceNoul < numbers.relevanceIncludeMin) return base;
  base.relevance = "relevant";
  if (judgment.sentimentConfidence < numbers.sentimentConfidenceMin) {
    return { ...base, sentiment: judgment.sentiment, sentimentUncertain: true };
  }
  base.sentiment = judgment.sentiment;
  const topics = judgment.topicNouls
    .filter((topic) => topic.noul >= numbers.topicNoulMin)
    .map((topic) => topic.id);
  if (topics.length > 0) {
    return { ...base, bucket: "included", topics, topicSource: "thresholds" };
  }
  if (policy.fallbackTopicId) {
    return {
      ...base,
      bucket: "included",
      topics: [policy.fallbackTopicId],
      topicSource: "fallback",
    };
  }
  return { ...base, topicsUncertain: true };
}

export function suggestedLabels(judgment: ParsedJudgment, policy: ScoringPolicy): SuggestedLabels {
  if (!policy.approved) return { relevance: null, sentiment: null, topics: [] };
  const route = routeJudgment(judgment, policy);
  return {
    relevance:
      route.relevance === "relevant" || route.relevance === "irrelevant" ? route.relevance : null,
    sentiment: route.sentimentUncertain ? null : route.sentiment,
    topics: route.topicsUncertain ? [] : route.topics,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/domain/routing.test.ts`

Expected: PASS. 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/domain/routing.ts apps/web/src/domain/routing.test.ts
git commit -m "feat: route Jev relevance, sentiment, and topics"
```

---

### Task 5: Calculate overview, trend, and topic aggregates

**Files:**
- Create: `apps/web/src/domain/aggregates.ts`
- Test: `apps/web/src/domain/aggregates.test.ts`

**Interfaces:**
- Consumes: sentiment union `"positive" | "neutral" | "negative"` from Task 4
- Produces:
  - `overviewScore(counts: { positive: number; negative: number; neutral: number }): { kind: "empty" } | { kind: "score"; value: number; included: number }`
  - `trendTable(rows: { createdAt: Date; sentiment: "positive" | "neutral" | "negative" }[], bucket: "day" | "week", timeZone: string): { bucketStart: string; positive: number; neutral: number; negative: number }[]`
  - `topicCounts(rows: { topics: readonly string[] }[]): { label: string; count: number }[]` sorted by count descending, then label ascending. A row with two topics increments both labels.

`overviewScore` uses `100 * (positive - negative) / (positive + negative + neutral)`. A zero denominator returns `{ kind: "empty" }`, never `{ kind: "score", value: 0 }`.

`trendTable` groups with `Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })` for `day`. For `week`, it floors that civil date to the Monday of that week in the same timezone and emits `YYYY-MM-DD` of that Monday. It does not choose a timezone. Callers must pass one.

**Acceptance criteria:**
- Covers AC-4's overview, trend, and topic calculations, and AC-5's aggregate update input.
- Empty counts return `kind: "empty"`.
- One positive and one negative return `value: 0` and `included: 2` because the denominator is non-empty. That zero is a real balance, not the empty state.
- A mention tagged `harga` and `rasa` adds one to each count. The multi-label rule still needs the user's approval flag in Task 20; this function implements the rule the UI will explain.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/domain/aggregates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { overviewScore, topicCounts, trendTable } from "./aggregates";

describe("overviewScore", () => {
  it("returns empty when nothing is included", () => {
    expect(overviewScore({ positive: 0, negative: 0, neutral: 0 })).toEqual({ kind: "empty" });
  });

  it("uses the proposed formula when the denominator is non-empty", () => {
    expect(overviewScore({ positive: 3, negative: 1, neutral: 0 })).toEqual({
      kind: "score",
      value: 50,
      included: 4,
    });
  });
});

describe("trendTable", () => {
  it("counts a Jakarta civil day", () => {
    const rows = trendTable(
      [{ createdAt: new Date("2026-11-01T17:30:00.000Z"), sentiment: "negative" }],
      "day",
      "Asia/Jakarta",
    );
    expect(rows).toEqual([{ bucketStart: "2026-11-02", positive: 0, neutral: 0, negative: 1 }]);
  });
});

describe("topicCounts", () => {
  it("counts a mention once per label", () => {
    expect(topicCounts([{ topics: ["rasa", "harga"] }, { topics: ["harga"] }])).toEqual([
      { label: "harga", count: 2 },
      { label: "rasa", count: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/domain/aggregates.test.ts`

Expected: FAIL. Cannot resolve `./aggregates`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/domain/aggregates.ts`:

```ts
export type SentimentCounts = { positive: number; negative: number; neutral: number };
export type OverviewScore = { kind: "empty" } | { kind: "score"; value: number; included: number };
export type TrendRow = { createdAt: Date; sentiment: "positive" | "neutral" | "negative" };
export type TrendBucket = { bucketStart: string; positive: number; neutral: number; negative: number };

export function overviewScore(counts: SentimentCounts): OverviewScore {
  const included = counts.positive + counts.negative + counts.neutral;
  if (included === 0) return { kind: "empty" };
  return { kind: "score", value: (100 * (counts.positive - counts.negative)) / included, included };
}

function civilDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function mondayOf(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay();
  const offset = weekday === 0 ? 6 : weekday - 1;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}

export function trendTable(rows: readonly TrendRow[], bucket: "day" | "week", timeZone: string): TrendBucket[] {
  const groups = new Map<string, TrendBucket>();
  for (const row of rows) {
    const day = civilDate(row.createdAt, timeZone);
    const bucketStart = bucket === "week" ? mondayOf(day) : day;
    const current = groups.get(bucketStart) ?? { bucketStart, positive: 0, neutral: 0, negative: 0 };
    current[row.sentiment] += 1;
    groups.set(bucketStart, current);
  }
  return [...groups.values()].sort((left, right) => left.bucketStart.localeCompare(right.bucketStart));
}

export function topicCounts(rows: readonly { topics: readonly string[] }[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const label of row.topics) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/domain/aggregates.test.ts`

Expected: PASS. 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/domain/aggregates.ts apps/web/src/domain/aggregates.test.ts
git commit -m "feat: calculate overview, trend, and topic aggregates"
```

---

### Task 6: Decide Needs attention once, including mark-as-seen failures

**Files:**
- Create: `apps/web/src/domain/attention.ts`
- Test: `apps/web/src/domain/attention.test.ts`

**Interfaces:**
- Consumes: `ScoringPolicy` and `RouteDecision` from `apps/web/src/domain/routing.ts`
- Produces:
  - `AttentionItem = { id: string; mentionId: string; customerId: string; reason: "negative"; unread: boolean }`
  - `attentionDecision(input: { mentionId: string; route: RouteDecision; sentimentConfidence: number | null }, policy: ScoringPolicy): { eligible: false; route: "not_sure" | "none" } | { eligible: true; reason: "negative" }`
  - `dedupeAttention(items: readonly AttentionItem[]): { items: AttentionItem[]; droppedMentionIds: string[] }`
  - `markSeen(item: AttentionItem, persist: (next: AttentionItem) => void): { ok: true; item: AttentionItem } | { ok: false; error: string; item: AttentionItem }`
  - `highImpactReason(): null`

Eligibility requires `policy.approved`, route bucket `included`, route sentiment `negative`, and `sentimentConfidence >= policy.attentionNegativeConfidenceMin`. Any `not_sure`, `policy_unapproved`, `excluded`, low confidence, or null confidence returns `{ eligible: false, route: "not_sure" }` when the route bucket is `not_sure` or sentiment is uncertain, otherwise `{ eligible: false, route: "none" }`. `highImpactReason` always returns `null`.

**Acceptance criteria:**
- Covers AC-6.
- A low-confidence negative route (`sentimentUncertain: true`) is not eligible.
- Two items with the same `mentionId` produce one kept item and one dropped id.
- A throwing `persist` returns `ok: false` and the original `unread: true` item.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/domain/attention.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attentionDecision, dedupeAttention, highImpactReason, markSeen } from "./attention";
import type { RouteDecision, ScoringPolicy } from "./routing";

const policy: ScoringPolicy = {
  approved: true,
  relevanceExcludeMax: 0.2,
  relevanceIncludeMin: 0.8,
  sentimentConfidenceMin: 0.75,
  topicNoulMin: 0.7,
  attentionNegativeConfidenceMin: 0.8,
  fallbackTopicId: null,
};

const includedNegative: RouteDecision = {
  bucket: "included",
  relevance: "relevant",
  sentiment: "negative",
  sentimentUncertain: false,
  topics: ["harga"],
  topicsUncertain: false,
  topicSource: "thresholds",
};

describe("attentionDecision", () => {
  it("accepts one confident negative mention", () => {
    expect(attentionDecision({ mentionId: "m1", route: includedNegative, sentimentConfidence: 0.91 }, policy)).toEqual({
      eligible: true,
      reason: "negative",
    });
  });

  it("sends a low-confidence negative mention to review", () => {
    const route: RouteDecision = { ...includedNegative, bucket: "not_sure", sentimentUncertain: true };
    expect(attentionDecision({ mentionId: "m1", route, sentimentConfidence: 0.4 }, policy)).toEqual({
      eligible: false,
      route: "not_sure",
    });
  });

  it("does not invent a high-impact reason", () => {
    expect(highImpactReason()).toBeNull();
  });
});

describe("dedupeAttention", () => {
  it("keeps the first item for a mention", () => {
    const item = { id: "a", mentionId: "m1", customerId: "c1", reason: "negative" as const, unread: true };
    const duplicate = { ...item, id: "b" };
    expect(dedupeAttention([item, duplicate])).toEqual({ items: [item], droppedMentionIds: ["m1"] });
  });
});

describe("markSeen", () => {
  it("reports a persist failure without clearing unread", () => {
    const item = { id: "a", mentionId: "m1", customerId: "c1", reason: "negative" as const, unread: true };
    const result = markSeen(item, () => {
      throw new Error("db_down");
    });
    expect(result).toEqual({ ok: false, error: "db_down", item });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/domain/attention.test.ts`

Expected: FAIL. Cannot resolve `./attention`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/domain/attention.ts`:

```ts
import type { RouteDecision, ScoringPolicy } from "./routing";

export type AttentionItem = {
  id: string;
  mentionId: string;
  customerId: string;
  reason: "negative";
  unread: boolean;
};

export type AttentionDecision =
  | { eligible: false; route: "not_sure" | "none" }
  | { eligible: true; reason: "negative" };

export function highImpactReason(): null {
  return null;
}

export function attentionDecision(
  input: { mentionId: string; route: RouteDecision; sentimentConfidence: number | null },
  policy: ScoringPolicy,
): AttentionDecision {
  if (
    !policy.approved ||
    policy.attentionNegativeConfidenceMin === null ||
    input.route.bucket === "not_sure" ||
    input.route.bucket === "policy_unapproved" ||
    input.route.sentimentUncertain
  ) {
    return { eligible: false, route: "not_sure" };
  }
  const confident =
    input.route.bucket === "included" &&
    input.route.sentiment === "negative" &&
    input.sentimentConfidence !== null &&
    input.sentimentConfidence >= policy.attentionNegativeConfidenceMin;
  if (!confident) return { eligible: false, route: "none" };
  return { eligible: true, reason: "negative" };
}

export function dedupeAttention(items: readonly AttentionItem[]): {
  items: AttentionItem[];
  droppedMentionIds: string[];
} {
  const seen = new Set<string>();
  const kept: AttentionItem[] = [];
  const droppedMentionIds: string[] = [];
  for (const item of items) {
    if (seen.has(item.mentionId)) {
      droppedMentionIds.push(item.mentionId);
      continue;
    }
    seen.add(item.mentionId);
    kept.push(item);
  }
  return { items: kept, droppedMentionIds };
}

export function markSeen(
  item: AttentionItem,
  persist: (next: AttentionItem) => void,
): { ok: true; item: AttentionItem } | { ok: false; error: string; item: AttentionItem } {
  const next = { ...item, unread: false };
  try {
    persist(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : "persist_failed";
    return { ok: false, error: message, item };
  }
  return { ok: true, item: next };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/domain/attention.test.ts`

Expected: PASS. 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/domain/attention.ts apps/web/src/domain/attention.test.ts
git commit -m "feat: dedupe Needs attention and surface mark-as-seen failures"
```

---

### Task 7: Store customers with isolated owner accounts

**Files:**
- Create: `apps/web/src/db/sql/001_init.sql`
- Create: `apps/web/src/db/migrate.ts`
- Create: `apps/web/src/auth/password.ts`
- Create: `apps/web/src/auth/accounts.ts`
- Test: `apps/web/src/auth/accounts.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `hashPassword(plain: string): Promise<string>` and `verifyPassword(plain: string, stored: string): Promise<boolean>` using scrypt. Stored form is `scrypt$<salt hex>$<hash hex>`.
  - `registerOwner(db: Queryable, input: { email: string; password: string }): Promise<{ customerId: string; userId: string }>`
  - `openSession(db: Queryable, userId: string, customerId: string): Promise<{ token: string; cookie: string }>` where `cookie` is `sm_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`
  - `withCustomer<T>(db: Queryable, customerId: string, fn: () => Promise<T>): Promise<T>` which runs `select set_config('app.customer_id', $1, true)` and `set local role app_user` inside a transaction
  - SQL tables `customers`, `users`, `sessions`, `projects`, `keyword_variants`, `mentions`, `jev_results`, `owner_corrections`, `attention_items`, `source_status`, `collection_runs`, `x_usage`, `analytics_events`, `project_settings`. Every tenant table has `customer_id uuid not null` and `FORCE ROW LEVEL SECURITY`.
  - Roles `app_user` and `worker_role`, both `NOSUPERUSER`, `NOBYPASSRLS`, and neither is the table owner. `withCustomer` sets `app.customer_id` and `ROLE app_user` with `SET LOCAL` inside the transaction. The worker connects as `worker_role` and is a different role from the web app.

`Queryable` is `{ query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }; exec(sql: string): Promise<void> }`. `migrate.ts` exports `applyMigration(db: Queryable): Promise<void>` and `pgliteQueryable(db: PGlite): Queryable`.

**Acceptance criteria:**
- Covers the isolation clause of the technical needs, which AC-7 and the launch gate re-check.
- After two owners are registered, `withCustomer` for owner A cannot `select` owner B's project.
- `app_user` and `worker_role` are not superusers, do not have `BYPASSRLS`, and do not own `projects`. `projects` has `FORCE ROW LEVEL SECURITY`.
- Password hashes do not contain the plain password.

- [ ] **Step 1: Install the test database and write the failing test**

Run:

```bash
npm install --prefix apps/web @electric-sql/pglite@0.5.14
```

Write `apps/web/src/auth/accounts.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "../db/migrate";
import { registerOwner, verifyPassword, withCustomer } from "./accounts";

describe("owner isolation", () => {
  it("hides one customer's project from the other customer", async () => {
    const pg = new PGlite();
    const db = pgliteQueryable(pg);
    await applyMigration(db);
    const first = await registerOwner(db, { email: "a@example.com", password: "sangat-rahasia" });
    const second = await registerOwner(db, { email: "b@example.com", password: "sandi-lain" });
    await withCustomer(db, first.customerId, async () => {
      await db.query(
        "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, $3, now())",
        ["00000000-0000-4000-8000-000000000001", first.customerId, "ayam geprek pak gembus"],
      );
    });
    const seen = await withCustomer(db, second.customerId, async () => {
      return db.query<{ id: string }>("select id from projects");
    });
    expect(seen.rows).toEqual([]);
    const stored = await db.query<{ password_hash: string }>("select password_hash from users where id = $1", [
      first.userId,
    ]);
    expect(stored.rows[0].password_hash).not.toContain("sangat-rahasia");
    expect(await verifyPassword("sangat-rahasia", stored.rows[0].password_hash)).toBe(true);
    expect(second.customerId).not.toBe(first.customerId);
    const roles = await db.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('app_user', 'worker_role') order by rolname",
    );
    expect(roles.rows).toEqual([
      { rolname: "app_user", rolsuper: false, rolbypassrls: false },
      { rolname: "worker_role", rolsuper: false, rolbypassrls: false },
    ]);
    const forced = await db.query<{ relforcerowsecurity: boolean; owner: string }>(
      `select c.relforcerowsecurity, r.rolname as owner
       from pg_class c
       join pg_roles r on r.oid = c.relowner
       where c.relname = 'projects'`,
    );
    expect(forced.rows[0].relforcerowsecurity).toBe(true);
    expect(forced.rows[0].owner).not.toBe("app_user");
    expect(forced.rows[0].owner).not.toBe("worker_role");
  });
});
```

The `users` select in the test runs as the migration superuser, before `set local role`, because `registerOwner` inserts as the table owner and the assertion reads the hash through the same admin connection. `withCustomer` is what switches to `app_user`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/auth/accounts.test.ts`

Expected: FAIL. Cannot resolve `../db/migrate`.

- [ ] **Step 3: Write the migration, password hasher, and account functions**

Write `apps/web/src/db/sql/001_init.sql`:

```sql
create role app_user nologin nosuperuser nobypassrls;
create role worker_role nologin nosuperuser nobypassrls;
grant usage on schema public to app_user;
grant usage on schema public to worker_role;

create table customers (
  id uuid primary key,
  customer_id uuid not null unique,
  created_at timestamptz not null,
  check (id = customer_id)
);
create table users (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null
);
create table sessions (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  user_id uuid not null references users (id),
  token_hash text not null unique,
  expires_at timestamptz not null
);
create table projects (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  brand_name text not null,
  created_at timestamptz not null
);
create table project_settings (
  project_id uuid primary key references projects (id),
  customer_id uuid not null references customers (id),
  trend_bucket text,
  trend_time_zone text,
  date_from date,
  date_to date,
  source_filter text not null default 'all'
);
create table keyword_variants (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  text text not null,
  active boolean not null,
  created_at timestamptz not null,
  unique (project_id, text)
);
create table mentions (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  source text not null check (source in ('x', 'threads')),
  external_id text not null,
  excerpt text not null,
  url text,
  author text,
  posted_at timestamptz not null,
  collected_at timestamptz not null,
  matched_variants text[] not null,
  scoring_status text not null check (scoring_status in ('pending', 'scoring', 'succeeded', 'failed')),
  source_post_unavailable boolean not null default false,
  unique (customer_id, source, external_id)
);
create table jev_results (
  mention_id uuid primary key references mentions (id),
  customer_id uuid not null references customers (id),
  provider text not null check (provider in ('typesafe', 'openrouter')),
  model text not null,
  raw_response jsonb not null,
  relevance_noul double precision,
  sentiment text,
  sentiment_confidence double precision,
  topic_nouls jsonb not null,
  created_at timestamptz not null
);
create table owner_corrections (
  mention_id uuid primary key references mentions (id),
  customer_id uuid not null references customers (id),
  action text not null check (action in ('confirm', 'correct')),
  relevance text not null check (relevance in ('relevant', 'irrelevant')),
  sentiment text,
  topics text[] not null,
  created_at timestamptz not null
);
create table attention_items (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  mention_id uuid not null unique references mentions (id),
  reason text not null check (reason = 'negative'),
  unread boolean not null,
  seen_at timestamptz,
  created_at timestamptz not null
);
create table source_status (
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  source text not null check (source in ('x', 'threads')),
  state text not null check (state in ('ready', 'unavailable', 'authorization_failed', 'rate_limited')),
  detail text not null,
  last_success_at timestamptz,
  updated_at timestamptz not null,
  primary key (customer_id, project_id, source)
);
create table collection_runs (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  source text not null,
  outcome text not null check (outcome in ('success', 'failed', 'empty_unconfirmed')),
  fetched_count integer,
  truncated boolean not null,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null
);
create table x_usage (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  account_key text not null,
  posts_returned integer not null,
  estimated_usd numeric not null,
  recorded_at timestamptz not null
);
create table analytics_events (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  name text not null,
  properties jsonb not null,
  created_at timestamptz not null
);

grant select, insert, update, delete on all tables in schema public to app_user;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'customers', 'users', 'sessions', 'projects', 'project_settings', 'keyword_variants',
    'mentions', 'jev_results', 'owner_corrections', 'attention_items', 'source_status',
    'collection_runs', 'x_usage', 'analytics_events'
  ]
  loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy %I on %I using (customer_id = current_setting(''app.customer_id'', true)::uuid) with check (customer_id = current_setting(''app.customer_id'', true)::uuid)',
      table_name || '_tenant',
      table_name
    );
  end loop;
end $$;
```

Write `apps/web/src/db/migrate.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

export type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
};

export function pgliteQueryable(db: PGlite): Queryable {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await db.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}

export async function applyMigration(db: Queryable): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    await db.exec(readFileSync(path.join(dir, name), "utf8"));
  }
}

export async function withCustomer<T>(db: Queryable, customerId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.exec("set local role app_user");
    const value = await fn();
    await db.exec("commit");
    return value;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
```

Write `apps/web/src/auth/password.ts`:

```ts
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(plain, salt, 32)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = (await scrypt(plain, Buffer.from(saltHex, "hex"), 32)) as Buffer;
  const expected = Buffer.from(hashHex, "hex");
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}
```

Write `apps/web/src/auth/accounts.ts`:

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import { hashPassword, verifyPassword } from "./password";

export { verifyPassword, withCustomer };

export async function registerOwner(
  db: Queryable,
  input: { email: string; password: string },
): Promise<{ customerId: string; userId: string }> {
  const customerId = randomUUID();
  const userId = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await db.exec("begin");
  try {
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.query(
      "insert into customers (id, customer_id, created_at) values ($1, $1, now())",
      [customerId],
    );
    await db.query(
      "insert into users (id, customer_id, email, password_hash, created_at) values ($1, $2, $3, $4, now())",
      [userId, customerId, input.email.toLocaleLowerCase("id-ID"), passwordHash],
    );
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { customerId, userId };
}

export async function openSession(
  db: Queryable,
  userId: string,
  customerId: string,
): Promise<{ token: string; cookie: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.exec("begin");
  try {
    await db.query("select set_config('app.customer_id', $1, true)", [customerId]);
    await db.query(
      "insert into sessions (id, customer_id, user_id, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '14 days')",
      [randomUUID(), customerId, userId, tokenHash],
    );
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return {
    token,
    cookie: `sm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`,
  };
}
```

`registerOwner` inserts as the migration connection because a new customer has no `app.customer_id` yet. That connection is the table owner. It is not `app_user` and it is not `worker_role`. All later tenant reads and writes from the web app go through `withCustomer`, which runs `SET LOCAL` inside the transaction. In production the web `DATABASE_URL` logs in as `app_user` (`LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, not the table owner) and the worker `WORKER_DATABASE_URL` logs in as `worker_role` with those same restrictions. The migration password and the two runtime passwords are Railway variables. The SQL above leaves both roles `NOLOGIN` so the test database has no password in the repo; provisioning on Railway runs `ALTER ROLE ... LOGIN` outside this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/auth/accounts.test.ts`

Expected: PASS. 1 test.

If PGlite rejects `create role` or `set local role`, stop and fix the migration runner. Do not weaken the test to a filter in application code only. Application queries still pass `customer_id`, and RLS is the second barrier the spec requires before deployment.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src/db apps/web/src/auth
git commit -m "feat: isolate owner accounts with forced row-level security"
```

---

### Task 8: Save brand projects and the active query set

**Files:**
- Create: `apps/web/src/projects/handlers.ts`
- Create: `apps/web/src/db/sql/002_schedules_jobs.sql`
- Create: `apps/web/src/projects/schedules.ts`
- Create: `config/limits.json`
- Test: `apps/web/src/projects/handlers.test.ts`
- Test: `apps/web/src/projects/schedules.test.ts`

**Interfaces:**
- Consumes: `validateVariantList` from Task 2, `effectOfKeywordEdit` from Task 3, `registerOwner` and `withCustomer` from Task 7
- Produces:
  - `createProject(db: Queryable, customerId: string, brandName: string): Promise<{ projectId: string; candidates: string[] }>` and `saveActiveVariants(db: Queryable, customerId: string, projectId: string, variants: string[], rescore: (mentionIds: string[]) => Promise<void>): Promise<{ ok: true; active: string[] } | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string }>`. `saveActiveVariants` calls `effectOfKeywordEdit` and does not call `rescore`.
  - `readLimits(file?: string): { scheduleMinIntervalHours: number; manualMinIntervalSeconds: number; workerHeartbeatStaleSeconds: number }`
  - `saveSchedule(db, customerId, projectId, input: { enabled: boolean; intervalHours: number }, limits?): Promise<{ ok: true; nextRunAt: string | null } | { ok: false; reason: "interval_too_short" }>`
  - `requestManualRun(db, customerId, projectId, now: Date, limits?): Promise<{ ok: true; jobId: string } | { ok: false; reason: "manual_rate_limited"; retryAt: string }>`
  - `collectionControlState(db, customerId, now: Date, limits?): Promise<{ manualBlocked: boolean; retryAt: string | null; lastSeenAt: string | null }>`

`saveSchedule` writes `time_zone = 'Asia/Jakarta'`. `requestManualRun` inserts one `jobs` row (`kind = 'manual'`, `status = 'queued'`, `run_after` equal to `now`) and does not call X or Threads. A second manual insert for the same customer inside `manualMinIntervalSeconds` returns `manual_rate_limited` and writes no row. The rate limit is per customer, across that customer's projects.

**Acceptance criteria:**
- Covers AC-1's save rule and the keyword-history rule.
- Saving `["geprek gembus", "geprek gembus"]` returns `duplicate` and writes no row.
- Saving a new active set leaves an existing mention's `scoring_status` unchanged and calls `rescore` zero times.
- An interval below the configured minimum is rejected. The default minimum is 6 hours.
- Two manual runs 14 minutes apart for one customer produce one job. The second result is `manual_rate_limited`.
- Customer A's session cannot `select` customer B's job.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/projects/handlers.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject, saveActiveVariants } from "./handlers";

describe("saveActiveVariants", () => {
  it("rejects a duplicate and does not rescore history", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    expect(project.candidates).toContain("geprek gembus");
    const mentionId = randomUUID();
    await withCustomer(db, owner.customerId, async () => {
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'x', '100', 'geprek gembus enak', 'https://x.com/a/status/100', 'ani', now(), now(), array['geprek gembus'], 'succeeded')`,
        [mentionId, owner.customerId, project.projectId],
      );
    });
    const rescore = vi.fn(async () => undefined);
    const duplicate = await saveActiveVariants(
      db,
      owner.customerId,
      project.projectId,
      ["geprek gembus", "geprek gembus"],
      rescore,
    );
    expect(duplicate).toMatchObject({ ok: false, reason: "duplicate" });
    const saved = await saveActiveVariants(
      db,
      owner.customerId,
      project.projectId,
      ["geprek gembus", "ayam pak gembus"],
      rescore,
    );
    expect(saved).toEqual({ ok: true, active: ["geprek gembus", "ayam pak gembus"] });
    expect(rescore).not.toHaveBeenCalled();
    const status = await withCustomer(db, owner.customerId, () =>
      db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [mentionId]),
    );
    expect(status.rows[0].scoring_status).toBe("succeeded");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/projects/handlers.test.ts`

Expected: FAIL. Cannot resolve `./handlers`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/projects/handlers.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import { effectOfKeywordEdit } from "../domain/keyword-history";
import { generateCandidates, validateVariantList } from "../domain/variants";

export async function createProject(
  db: Queryable,
  customerId: string,
  brandName: string,
): Promise<{ projectId: string; candidates: string[] }> {
  const projectId = randomUUID();
  await withCustomer(db, customerId, async () => {
    await db.query(
      "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, $3, now())",
      [projectId, customerId, brandName.trim()],
    );
    await db.query(
      "insert into project_settings (project_id, customer_id, source_filter) values ($1, $2, 'all')",
      [projectId, customerId],
    );
  });
  return { projectId, candidates: generateCandidates(brandName) };
}

export async function saveActiveVariants(
  db: Queryable,
  customerId: string,
  projectId: string,
  variants: string[],
  rescore: (mentionIds: string[]) => Promise<void>,
): Promise<
  | { ok: true; active: string[] }
  | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string }
> {
  const validated = validateVariantList(variants);
  if (!validated.ok) return validated;
  const effect = effectOfKeywordEdit(validated.variants);
  if (effect.reclassifyExisting) {
    await rescore([]);
  }
  await withCustomer(db, customerId, async () => {
    await db.query("update keyword_variants set active = false where project_id = $1 and customer_id = $2", [
      projectId,
      customerId,
    ]);
    for (const text of effect.futureQueries) {
      await db.query(
        `insert into keyword_variants (id, customer_id, project_id, text, active, created_at)
         values ($1, $2, $3, $4, true, now())
         on conflict (project_id, text) do update set active = true`,
        [randomUUID(), customerId, projectId, text],
      );
    }
  });
  return { ok: true, active: [...effect.futureQueries] };
}
```

`reclassifyExisting` is the literal `false`, so `rescore` is not called. The branch is there so a future change that flipped the type would still have to pass the test in Task 3.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/projects/handlers.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/projects
git commit -m "feat: save an active keyword set without rescoring history"
```

- [ ] **Step 6: Write the failing schedule and jobs test**

Write `config/limits.json`:

```json
{
  "x_monthly_global_post_reads": 20000,
  "x_monthly_per_customer_post_reads": 2000,
  "threads_rolling_24h_reserve": 1500,
  "threads_rolling_24h_platform": 2200,
  "schedule_min_interval_hours": 6,
  "manual_min_interval_seconds": 900,
  "max_jobs_per_tick": 5,
  "worker_poll_seconds": 20,
  "worker_heartbeat_stale_seconds": 90
}
```

Write `apps/web/src/projects/schedules.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject } from "./handlers";
import { collectionControlState, readLimits, requestManualRun, saveSchedule } from "./schedules";

describe("project schedules and manual jobs", () => {
  it("stores a WIB schedule and rate-limits a second manual run", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const limits = readLimits();
    expect(limits).toMatchObject({ scheduleMinIntervalHours: 6, manualMinIntervalSeconds: 900 });
    const owner = await registerOwner(db, { email: "a@example.com", password: "sandi-panjang" });
    const other = await registerOwner(db, { email: "b@example.com", password: "sandi-lain-sekali" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const tooSoon = await saveSchedule(db, owner.customerId, project.projectId, { enabled: true, intervalHours: 5 }, limits);
    expect(tooSoon).toEqual({ ok: false, reason: "interval_too_short" });
    const saved = await saveSchedule(db, owner.customerId, project.projectId, { enabled: true, intervalHours: 6 }, limits);
    expect(saved.ok).toBe(true);
    const row = await withCustomer(db, owner.customerId, () =>
      db.query<{ time_zone: string; interval_hours: number }>(
        "select time_zone, interval_hours from project_schedules where project_id = $1",
        [project.projectId],
      ),
    );
    expect(row.rows[0]).toEqual({ time_zone: "Asia/Jakarta", interval_hours: 6 });
    const now = new Date("2026-11-01T03:00:00.000Z");
    const first = await requestManualRun(db, owner.customerId, project.projectId, now, limits);
    expect(first.ok).toBe(true);
    const blocked = await requestManualRun(
      db,
      owner.customerId,
      project.projectId,
      new Date(now.getTime() + 14 * 60 * 1000),
      limits,
    );
    expect(blocked).toMatchObject({ ok: false, reason: "manual_rate_limited" });
    await db.query(
      "insert into worker_heartbeat (id, worker_id, last_seen_at) values (1, 'worker-1', $1)",
      [now.toISOString()],
    );
    const state = await collectionControlState(
      db,
      owner.customerId,
      new Date(now.getTime() + 14 * 60 * 1000),
      limits,
    );
    expect(state.manualBlocked).toBe(true);
    expect(state.retryAt).toEqual(expect.any(String));
    expect(state.lastSeenAt).toEqual(expect.any(String));
    const jobs = await withCustomer(db, owner.customerId, () =>
      db.query<{ kind: string; status: string }>("select kind, status from jobs"),
    );
    expect(jobs.rows).toEqual([{ kind: "manual", status: "queued" }]);
    const hidden = await withCustomer(db, other.customerId, () => db.query("select id from jobs"));
    expect(hidden.rows).toEqual([]);
    const later = await requestManualRun(
      db,
      owner.customerId,
      project.projectId,
      new Date(now.getTime() + 15 * 60 * 1000),
      limits,
    );
    expect(later.ok).toBe(true);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/projects/schedules.test.ts`

Expected: FAIL. Cannot resolve `./schedules`.

- [ ] **Step 8: Write the migration and the schedule functions**

Write `apps/web/src/db/sql/002_schedules_jobs.sql`:

```sql
create table project_schedules (
  project_id uuid primary key references projects (id),
  customer_id uuid not null references customers (id),
  enabled boolean not null default false,
  interval_hours integer not null check (interval_hours >= 1),
  time_zone text not null default 'Asia/Jakarta',
  next_run_at timestamptz,
  last_collected_at timestamptz
);

create table jobs (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  kind text not null check (kind in ('scheduled', 'manual')),
  status text not null check (status in ('queued', 'claimed', 'succeeded', 'deferred', 'failed')),
  run_after timestamptz not null,
  claimed_by text,
  claimed_at timestamptz,
  status_detail text,
  created_at timestamptz not null
);

create table source_cursors (
  customer_id uuid not null references customers (id),
  query_key text not null,
  source text not null check (source in ('x', 'threads')),
  incremental_cursor text,
  incremental_since timestamptz,
  backfill_cursor text,
  backfill_complete boolean not null default false,
  last_success_at timestamptz,
  last_error text,
  primary key (query_key, source)
);

create table worker_heartbeat (
  id integer primary key check (id = 1),
  worker_id text not null,
  last_seen_at timestamptz not null
);

grant select, insert, update, delete on project_schedules, jobs, source_cursors to app_user;
grant select on worker_heartbeat to app_user;
grant select, insert, update, delete on project_schedules, jobs, source_cursors to worker_role;
grant select, insert, update on mentions, worker_heartbeat to worker_role;
grant select on keyword_variants to worker_role;

alter table project_schedules enable row level security;
alter table project_schedules force row level security;
alter table jobs enable row level security;
alter table jobs force row level security;
alter table source_cursors enable row level security;
alter table source_cursors force row level security;
alter table worker_heartbeat enable row level security;
alter table worker_heartbeat force row level security;

create policy project_schedules_tenant on project_schedules
  for all to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy jobs_tenant on jobs
  for all to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy source_cursors_tenant on source_cursors
  for all to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
create policy worker_heartbeat_read on worker_heartbeat
  for select to app_user
  using (true);

create policy project_schedules_worker on project_schedules
  for all to worker_role using (true) with check (true);
create policy jobs_worker on jobs
  for all to worker_role using (true) with check (true);
create policy source_cursors_worker on source_cursors
  for all to worker_role using (true) with check (true);
create policy worker_heartbeat_worker on worker_heartbeat
  for all to worker_role using (true) with check (true);
create policy keyword_variants_worker on keyword_variants
  for select to worker_role using (true);
```

`worker_role` can see every customer's jobs so one worker can claim them. `app_user` cannot. `worker_heartbeat` has no `customer_id`. Owners can read it and cannot write it. `keyword_variants_worker` lets the worker read every project's active variants. `app_user` still sees only its own rows through the tenant policy from Task 7.

Write `apps/web/src/projects/schedules.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";

export type ScheduleLimits = {
  scheduleMinIntervalHours: number;
  manualMinIntervalSeconds: number;
  workerHeartbeatStaleSeconds: number;
};

export function readLimits(file?: string): ScheduleLimits {
  const resolved =
    file ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../config/limits.json");
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as {
    schedule_min_interval_hours: number;
    manual_min_interval_seconds: number;
    worker_heartbeat_stale_seconds: number;
  };
  return {
    scheduleMinIntervalHours: parsed.schedule_min_interval_hours,
    manualMinIntervalSeconds: parsed.manual_min_interval_seconds,
    workerHeartbeatStaleSeconds: parsed.worker_heartbeat_stale_seconds,
  };
}

export async function saveSchedule(
  db: Queryable,
  customerId: string,
  projectId: string,
  input: { enabled: boolean; intervalHours: number },
  limits: ScheduleLimits = readLimits(),
): Promise<{ ok: true; nextRunAt: string | null } | { ok: false; reason: "interval_too_short" }> {
  if (input.intervalHours < limits.scheduleMinIntervalHours) {
    return { ok: false, reason: "interval_too_short" };
  }
  return withCustomer(db, customerId, async () => {
    const existing = await db.query<{ last_collected_at: string | null }>(
      "select last_collected_at from project_schedules where project_id = $1 and customer_id = $2",
      [projectId, customerId],
    );
    const last = existing.rows[0]?.last_collected_at ?? null;
    let nextRunAt: string | null = null;
    if (input.enabled) {
      const base = last ? new Date(last) : new Date();
      if (last) base.setTime(base.getTime() + input.intervalHours * 60 * 60 * 1000);
      nextRunAt = base.toISOString();
    }
    await db.query(
      `insert into project_schedules (project_id, customer_id, enabled, interval_hours, time_zone, next_run_at)
       values ($1, $2, $3, $4, 'Asia/Jakarta', $5)
       on conflict (project_id) do update
         set enabled = excluded.enabled,
             interval_hours = excluded.interval_hours,
             time_zone = 'Asia/Jakarta',
             next_run_at = excluded.next_run_at`,
      [projectId, customerId, input.enabled, input.intervalHours, nextRunAt],
    );
    return { ok: true as const, nextRunAt };
  });
}

export async function requestManualRun(
  db: Queryable,
  customerId: string,
  projectId: string,
  now: Date,
  limits: ScheduleLimits = readLimits(),
): Promise<{ ok: true; jobId: string } | { ok: false; reason: "manual_rate_limited"; retryAt: string }> {
  return withCustomer(db, customerId, async () => {
    const recent = await db.query<{ created_at: string }>(
      `select created_at from jobs
       where customer_id = $1 and kind = 'manual' and status <> 'deferred'
       order by created_at desc
       limit 1`,
      [customerId],
    );
    const last = recent.rows[0]?.created_at;
    if (last) {
      const retryAt = new Date(new Date(last).getTime() + limits.manualMinIntervalSeconds * 1000);
      if (retryAt > now) return { ok: false as const, reason: "manual_rate_limited" as const, retryAt: retryAt.toISOString() };
    }
    const jobId = randomUUID();
    await db.query(
      `insert into jobs (id, customer_id, project_id, kind, status, run_after, status_detail, created_at)
       values ($1, $2, $3, 'manual', 'queued', $4, null, $4)`,
      [jobId, customerId, projectId, now.toISOString()],
    );
    return { ok: true as const, jobId };
  });
}

export async function collectionControlState(
  db: Queryable,
  customerId: string,
  now: Date,
  limits: ScheduleLimits = readLimits(),
): Promise<{ manualBlocked: boolean; retryAt: string | null; lastSeenAt: string | null }> {
  return withCustomer(db, customerId, async () => {
    const recent = await db.query<{ created_at: string }>(
      `select created_at from jobs
       where customer_id = $1 and kind = 'manual' and status <> 'deferred'
       order by created_at desc
       limit 1`,
      [customerId],
    );
    const beat = await db.query<{ last_seen_at: string | Date }>(
      "select last_seen_at from worker_heartbeat where id = 1",
    );
    const last = recent.rows[0]?.created_at;
    const rawSeen = beat.rows[0]?.last_seen_at ?? null;
    const lastSeenAt = rawSeen instanceof Date ? rawSeen.toISOString() : rawSeen;
    if (!last) return { manualBlocked: false, retryAt: null, lastSeenAt };
    const retryAt = new Date(new Date(last).getTime() + limits.manualMinIntervalSeconds * 1000);
    if (retryAt > now) {
      return { manualBlocked: true, retryAt: retryAt.toISOString(), lastSeenAt };
    }
    return { manualBlocked: false, retryAt: null, lastSeenAt };
  });
}
```

The read of the previous manual job and the insert share one `withCustomer` transaction, so two overlapping requests cannot both pass the interval check. `collectionControlState` uses that same predicate and does not insert a job. It also reads `worker_heartbeat`, which `app_user` can select and cannot update. Neither function imports from `sentiment_monitor` or names an X or Threads URL.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/projects/schedules.test.ts`

Expected: PASS. 1 test.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/db/sql/002_schedules_jobs.sql apps/web/src/projects/schedules.ts apps/web/src/projects/schedules.test.ts config/limits.json
git commit -m "feat: store per-project schedules and manual collection jobs"
```

---

### Task 9: Collect from Harken's X source without its pipeline

**Files:**
- Create: `apps/worker/pyproject.toml`
- Create: `apps/worker/sentiment_monitor/__init__.py`
- Create: `apps/worker/sentiment_monitor/collect.py`
- Test: `apps/worker/tests/test_collect_x.py`

**Interfaces:**
- Consumes: Harken `XSource.fetch_page(query: str, limit: int = 50, *, cursor: str | None = None, since: datetime | None = None) -> FetchPage` and `Mention`
- Produces: `Candidate` and `fetch_x_page(query: str, bearer_token: str, *, cursor: str | None, since: datetime | None, limit: int) -> list[Candidate]` and `external_id_for(mention: Mention) -> str`. A `Candidate` is a frozen dataclass with `source: str`, `external_id: str`, `variant: str`, `text: str`, `url: str | None`, `author: str | None`, `created_at: str`. `created_at` is ISO 8601 with a timezone. For X, `external_id` is the status id after `/status/` in the URL.

**Acceptance criteria:**
- Covers AC-1's collection half: a page requested with variant `geprek gembus` sends that string as X's `query` parameter and does not require the full brand name.
- The worker file does not reference `Pipeline`, `LexiconSentiment`, `harken.web`, or `harken.alerts`.
- No live call to `api.x.com`. The test uses `respx`.

- [ ] **Step 1: Write the failing test and the package manifest**

Write `apps/worker/pyproject.toml`:

```toml
[project]
name = "sentiment-monitor-worker"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "harken @ git+https://github.com/VladUZH/harken.git@d0710a427dbbe712594ef3a6c25112e1d14cc027",
  "httpx>=0.27",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "respx>=0.21"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["sentiment_monitor*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Write an empty `apps/worker/sentiment_monitor/__init__.py`.

Write `apps/worker/tests/test_collect_x.py`:

```python
from pathlib import Path

import httpx
import respx

from sentiment_monitor.collect import fetch_x_page


@respx.mock
def test_variant_is_the_x_query_without_the_full_brand_name():
    route = respx.get("https://api.x.com/2/tweets/search/recent").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "100",
                        "text": "geprek gembus enak",
                        "author_id": "7",
                        "created_at": "2026-11-01T00:00:00.000Z",
                    }
                ],
                "includes": {"users": [{"id": "7", "username": "ani", "name": "Ani"}]},
                "meta": {},
            },
        )
    )
    page = fetch_x_page("geprek gembus", "test-token", cursor=None, since=None, limit=10)
    assert route.calls[0].request.url.params["query"] == "geprek gembus"
    assert page[0].source == "x"
    assert page[0].external_id == "100"
    assert page[0].variant == "geprek gembus"
    assert page[0].url == "https://x.com/ani/status/100"
    source = (Path(__file__).resolve().parents[1] / "sentiment_monitor" / "collect.py").read_text()
    for forbidden in ("Pipeline", "LexiconSentiment", "harken.web", "harken.alerts"):
        assert forbidden not in source
```

Install and run from `apps/worker`:

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_collect_x.py -v`

Expected: FAIL with `ModuleNotFoundError` or import error for `sentiment_monitor.collect`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/worker/sentiment_monitor/collect.py`:

```python
from dataclasses import dataclass
from datetime import datetime

from harken.models import Mention
from harken.sources.x import XSource


@dataclass(frozen=True)
class Candidate:
    source: str
    external_id: str
    variant: str
    text: str
    url: str | None
    author: str | None
    created_at: str


def external_id_for(mention: Mention) -> str:
    if mention.source == "x" and mention.url and "/status/" in mention.url:
        return mention.url.rsplit("/status/", 1)[1].split("?")[0]
    return mention.id


def fetch_x_page(
    query: str,
    bearer_token: str,
    *,
    cursor: str | None,
    since: datetime | None,
    limit: int,
) -> list[Candidate]:
    page = XSource(bearer_token=bearer_token).fetch_page(query, limit=limit, cursor=cursor, since=since)
    return [
        Candidate(
            source="x",
            external_id=external_id_for(mention),
            variant=query,
            text=mention.text,
            url=mention.url,
            author=mention.author,
            created_at=mention.created_at.isoformat(),
        )
        for mention in page.mentions
    ]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_collect_x.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat: collect X candidates through Harken's source adapter"
```

---

### Task 10: Add the Threads source adapter

**Files:**
- Create: `apps/worker/sentiment_monitor/sources/__init__.py`
- Create: `apps/worker/sentiment_monitor/sources/threads.py`
- Modify: `apps/worker/sentiment_monitor/collect.py`
- Test: `apps/worker/tests/test_threads_source.py`

**Interfaces:**
- Consumes: Harken `Source` and `FetchPage`; `Candidate` from Task 9
- Produces: `ThreadsSource` with `name = "threads"`, constructor `(access_token: str | None = None, **options)`, and `fetch_page` matching `Source.fetch_page`. `register_threads() -> None` sets `harken.sources.REGISTRY["threads"] = ThreadsSource`. `fetch_threads_page(query: str, access_token: str, *, since: datetime | None, limit: int) -> tuple[list[Candidate], bool]` returns candidates and `truncated`. `truncated` is true when the response `data` length equals the requested limit.

The request is `GET https://graph.threads.com/v1.0/keyword_search` with `search_type=RECENT`, `search_mode=KEYWORD`, `fields=id,text,media_type,permalink,timestamp,username`, `limit` clamped to 1..100, and `access_token`. `since` is a Unix timestamp string when provided. The official keyword-search page does not document a paging cursor, so `cursor` is ignored and `FetchPage.next_cursor` is `None`. The adapter sets `Mention.id` to the API media id.

**Acceptance criteria:**
- Covers AC-9's adapter half. The live approval gate is Task 20.
- A mocked post becomes `source="threads"` and `external_id` equal to the API `id`.
- `REGISTRY["threads"]` is `ThreadsSource` and is a subclass of `Source`.
- The test does not call `graph.threads.com`.

- [ ] **Step 1: Write the failing test**

Write `apps/worker/tests/test_threads_source.py`:

```python
import httpx
import respx
from harken.sources import REGISTRY
from harken.sources.base import Source

from sentiment_monitor.sources.threads import ThreadsSource, register_threads
from sentiment_monitor.collect import fetch_threads_page


@respx.mock
def test_threads_adapter_parses_a_keyword_hit_and_registers():
    route = respx.get("https://graph.threads.com/v1.0/keyword_search").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "1234567890",
                        "text": "geprek gembus enak",
                        "media_type": "TEXT",
                        "permalink": "https://www.threads.com/@ani/post/abcdefg",
                        "timestamp": "2026-11-01T05:42:03+0000",
                        "username": "ani",
                    }
                ]
            },
        )
    )
    candidates, truncated = fetch_threads_page("geprek gembus", "token", since=None, limit=25)
    sent = route.calls[0].request.url.params
    assert sent["q"] == "geprek gembus"
    assert sent["search_type"] == "RECENT"
    assert sent["search_mode"] == "KEYWORD"
    assert candidates[0].external_id == "1234567890"
    assert candidates[0].url == "https://www.threads.com/@ani/post/abcdefg"
    assert truncated is False
    register_threads()
    assert REGISTRY["threads"] is ThreadsSource
    assert issubclass(ThreadsSource, Source)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_threads_source.py -v`

Expected: FAIL. `sentiment_monitor.sources.threads` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/worker/sentiment_monitor/sources/__init__.py` as an empty file.

Write `apps/worker/sentiment_monitor/sources/threads.py`:

```python
from datetime import datetime, timezone

from harken.models import Mention
from harken.sources import REGISTRY
from harken.sources.base import FetchPage, Source

_API = "https://graph.threads.com/v1.0/keyword_search"


class ThreadsSource(Source):
    name = "threads"
    label = "Threads"
    needs_config = True

    def __init__(self, access_token: str | None = None, **options):
        super().__init__(**options)
        self.access_token = access_token

    def fetch(self, query: str, limit: int = 25) -> list[Mention]:
        return self.fetch_page(query, limit=limit).mentions

    def fetch_page(
        self,
        query: str,
        limit: int = 25,
        *,
        cursor: str | None = None,
        since: datetime | None = None,
    ) -> FetchPage:
        del cursor
        if not self.access_token:
            raise RuntimeError("Threads requires an access token")
        params = {
            "q": query,
            "search_type": "RECENT",
            "search_mode": "KEYWORD",
            "fields": "id,text,media_type,permalink,timestamp,username",
            "limit": str(max(1, min(limit, 100))),
            "access_token": self.access_token,
        }
        if since is not None:
            params["since"] = str(int(since.timestamp()))
        with self._client() as client:
            response = client.get(_API, params=params)
            response.raise_for_status()
            data = response.json()
        mentions: list[Mention] = []
        for post in data.get("data", []):
            post_id = post.get("id")
            if not post_id:
                continue
            mentions.append(
                Mention(
                    id=str(post_id),
                    source=self.name,
                    query=query,
                    author=post.get("username"),
                    text=post.get("text") or "",
                    url=post.get("permalink"),
                    created_at=_parse_timestamp(post.get("timestamp")),
                )
            )
        return FetchPage(mentions, None)


def register_threads() -> None:
    REGISTRY["threads"] = ThreadsSource


def _parse_timestamp(value: str | None) -> datetime:
    if value:
        try:
            return datetime.fromisoformat(value.replace("+0000", "+00:00"))
        except ValueError:
            pass
    return datetime.now(timezone.utc)
```

Append to `apps/worker/sentiment_monitor/collect.py`:

```python
from sentiment_monitor.sources.threads import ThreadsSource


def fetch_threads_page(
    query: str,
    access_token: str,
    *,
    since: datetime | None,
    limit: int,
) -> tuple[list[Candidate], bool]:
    page = ThreadsSource(access_token=access_token).fetch_page(query, limit=limit, since=since)
    candidates = [
        Candidate(
            source="threads",
            external_id=mention.id,
            variant=query,
            text=mention.text,
            url=mention.url,
            author=mention.author,
            created_at=mention.created_at.isoformat(),
        )
        for mention in page.mentions
    ]
    return candidates, len(page.mentions) == max(1, min(limit, 100))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_threads_source.py apps/worker/tests/test_collect_x.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor apps/worker/tests/test_threads_source.py
git commit -m "feat: add a Threads keyword-search source adapter"
```

---

### Task 11: Record source status so a failure is not zero mentions

**Files:**
- Create: `apps/worker/sentiment_monitor/status.py`
- Create: `apps/worker/sentiment_monitor/cursors.py`
- Create: `config/credential-policy.json`
- Test: `apps/worker/tests/test_status.py`

**Interfaces:**
- Consumes: a cursor protocol with `record_source_success(query, source, mentions, *, mode, next_cursor, incremental_since=None)`, `record_source_error(query, source, error)`, and `source_state(query, source) -> dict`. Task 22's `PostgresStore` is that protocol. This task does not construct `harken.store.Store` and does not open a database file.
- Produces:
  - `classify_http_failure(status_code: int | None) -> "unavailable" | "authorization_failed" | "rate_limited"`
  - `CollectionReport` with fields `source: str`, `outcome: "success" | "failed" | "empty_unconfirmed"`, `fetched_count: int | None`, `state: "ready" | "unavailable" | "authorization_failed" | "rate_limited"`, `detail: str`, `truncated: bool`
  - `report_success(source: str, fetched_count: int, truncated: bool) -> CollectionReport`
  - `report_threads_empty() -> CollectionReport` with `outcome="empty_unconfirmed"`, `fetched_count=None`, `state="ready"`, `detail="threads_empty_array"`
  - `report_failure(source: str, state: str, detail: str) -> CollectionReport` with `outcome="failed"` and `fetched_count=None`
  - `commit_cursor(store, query_key: str, source: str, mentions: list, next_cursor: str | None, handoff_ok: bool) -> None`
  - `query_key(customer_id: str, project_id: str, variant: str) -> str` equal to `"{customer_id}:{project_id}:{variant}"`

**Acceptance criteria:**
- Covers AC-4's error state and the rule "never present unavailable collection as zero mentions."
- A 429 is `rate_limited`. A 401 or 403 is `authorization_failed`. A network failure or 5xx is `unavailable`. All three have `fetched_count is None`.
- An X success with zero posts has `fetched_count == 0`. A Threads success with an empty `data` array uses `empty_unconfirmed` and `fetched_count is None`.
- `commit_cursor` does not call `record_source_success` when `handoff_ok` is false.
- Two customers using the same variant get different `query_key` values.
- No scraping function exists. The status module does not contain `playwright`, `selenium`, or `bs4`.
- `cursors.py` does not import `sqlite3` or `harken.store`. There is no `apps/web/src/auth/secrets.ts`.

- [ ] **Step 1: Write the failing tests**

Write `apps/worker/tests/test_status.py`:

```python
import inspect

from sentiment_monitor import cursors
from sentiment_monitor.cursors import commit_cursor, query_key
from sentiment_monitor.status import (
    classify_http_failure,
    report_failure,
    report_success,
    report_threads_empty,
)


def test_failures_are_not_zero_mentions():
    assert classify_http_failure(429) == "rate_limited"
    assert classify_http_failure(401) == "authorization_failed"
    assert classify_http_failure(403) == "authorization_failed"
    assert classify_http_failure(503) == "unavailable"
    assert classify_http_failure(None) == "unavailable"
    failed = report_failure("x", "rate_limited", "429")
    assert failed.outcome == "failed"
    assert failed.fetched_count is None


def test_threads_empty_array_is_not_a_zero_count():
    report = report_threads_empty()
    assert report.outcome == "empty_unconfirmed"
    assert report.fetched_count is None
    assert report.detail == "threads_empty_array"


def test_x_success_can_be_a_real_zero():
    report = report_success("x", 0, False)
    assert report.outcome == "success"
    assert report.fetched_count == 0
    assert report.state == "ready"


class FakeStore:
    def __init__(self):
        self.success = 0
        self.state = {}

    def record_source_success(self, query, source, mentions, *, mode, next_cursor, incremental_since=None):
        self.success += 1
        self.state["last_success_at"] = "set"

    def record_source_error(self, query, source, error):
        self.state["last_error"] = error

    def source_state(self, query, source):
        return self.state


def test_cursor_waits_for_handoff():
    store = FakeStore()
    key = query_key("customer-a", "project-1", "geprek gembus")
    other = query_key("customer-b", "project-1", "geprek gembus")
    assert key != other
    commit_cursor(store, key, "x", [], None, False)
    assert store.success == 0
    assert store.source_state(key, "x").get("last_success_at") is None
    commit_cursor(store, key, "x", [], None, True)
    assert store.success == 1
    assert "sqlite3" not in inspect.getsource(cursors)
    assert "harken.store" not in inspect.getsource(cursors)
```

Write `config/credential-policy.json`:

```json
{ "approved": false, "mode": "shared_operator" }
```

The user chose `shared_operator` on 1 Nov 2026: one X account and one Threads app that we manage. Their tokens are Railway service variables. `approved` stays `false` until the user also approves the X budget. Customers do not enter source tokens. Do not add `apps/web/src/auth/secrets.ts` or any other token-encryption module.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_status.py -v`

Expected: FAIL. `sentiment_monitor.status` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/worker/sentiment_monitor/status.py`:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class CollectionReport:
    source: str
    outcome: str
    fetched_count: int | None
    state: str
    detail: str
    truncated: bool


def classify_http_failure(status_code: int | None) -> str:
    if status_code == 429:
        return "rate_limited"
    if status_code in (401, 403):
        return "authorization_failed"
    return "unavailable"


def report_failure(source: str, state: str, detail: str) -> CollectionReport:
    return CollectionReport(source, "failed", None, state, detail, False)


def report_success(source: str, fetched_count: int, truncated: bool) -> CollectionReport:
    return CollectionReport(source, "success", fetched_count, "ready", "ok", truncated)


def report_threads_empty() -> CollectionReport:
    return CollectionReport("threads", "empty_unconfirmed", None, "ready", "threads_empty_array", False)
```

Write `apps/worker/sentiment_monitor/cursors.py`:

```python
def query_key(customer_id: str, project_id: str, variant: str) -> str:
    return f"{customer_id}:{project_id}:{variant}"


def commit_cursor(store, query_key: str, source: str, mentions: list, next_cursor: str | None, handoff_ok: bool) -> None:
    if not handoff_ok:
        store.record_source_error(query_key, source, "handoff_failed")
        return
    store.record_source_success(
        query_key,
        source,
        mentions,
        mode="incremental",
        next_cursor=next_cursor,
    )
```

`config/credential-policy.json` is the committed policy. `approved: false` means the worker must not read a live token. Tests of fetch functions keep taking the token as an argument. `mode` is `shared_operator` only. Do not add a `per_customer` branch and do not add encryption helpers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_status.py -v`

Expected: PASS. 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/status.py apps/worker/sentiment_monitor/cursors.py apps/worker/tests/test_status.py config/credential-policy.json
git commit -m "feat: record source failures separately from zero mentions"
```

---

### Task 12: Meter and cap X post reads before a fetch

**Files:**
- Create: `apps/worker/sentiment_monitor/x_cost.py`
- Create: `apps/worker/sentiment_monitor/limits.py`
- Create: `apps/web/src/db/sql/003_usage_caps.sql`
- Create: `config/x-budget.json`
- Test: `apps/worker/tests/test_x_cost.py`

**Interfaces:**
- Consumes: `CollectionReport` from Task 11 and `config/limits.json` from Task 8
- Produces:
  - `POSTS_READ_USD = Decimal("0.005")`
  - `PLATFORM_POST_READ_CAP = 3_000_000`
  - `GLOBAL_CUSTOMER_ID = "00000000-0000-0000-0000-000000000000"`
  - `estimated_usd(posts_returned: int) -> Decimal`
  - `max_results_within_budget(posts_already_customer: int, posts_already_global: int, customer_cap: int, global_cap: int, requested: int) -> int | None`
  - `budget_block_report(detail: str) -> CollectionReport` with `detail` of `x_customer_cap` or `x_global_cap`, state `rate_limited`, `fetched_count is None`
  - `threads_block_report() -> CollectionReport` for source `threads`, detail `threads_budget`, `fetched_count is None`
  - `load_limits(path: Path, env: Mapping[str, str]) -> Limits`
  - `admit_x_read(conn, customer_id: str, requested: int, limits: Limits) -> int | CollectionReport`
  - `admit_threads_query(conn, limits: Limits) -> CollectionReport | None`
  - `run_threads(conn, limits: Limits, fetch) -> CollectionReport`

`max_results_within_budget` returns `None` when `requested` is below 10 or the tighter remaining of the customer cap, the global cap, and `PLATFORM_POST_READ_CAP` is below 10. Otherwise it returns `min(requested, 100, remaining)`. X recent search rejects `max_results` below 10 or above 100. `config/x-budget.json` is `{ "approved": false }`. The numeric caps are the defaults in `config/limits.json`: global `20000`, per customer `2000`. `gate` still returns 2 while `approved` is false, and that is separate from the cap check. `admit_x_read` and `admit_threads_query` run even in tests with no network.

**Acceptance criteria:**
- Covers AC-9's cost-exposure half. The launch flag is Task 20.
- The rate `0.005` appears only next to the comment that cites `https://docs.x.com/x-api/getting-started/pricing.md` (Posts: Read, per resource, observed 1 Nov 2026). The platform cap `3000000` cites the same page's monthly Post-read cap.
- No test calls `api.x.com` or `graph.threads.com`.
- A customer at 2000 reserved reads, or a global total at 20000, returns a block report and does not call the fetch.
- A Threads count of 1500 in the rolling 24 hours returns `threads_budget` and does not call the fetch. 1499 inserts a `threads_query_log` row, then calls the fetch.

- [ ] **Step 1: Write the failing test**

Write `apps/worker/tests/test_x_cost.py`:

```python
from decimal import Decimal

from sentiment_monitor.x_cost import (
    PLATFORM_POST_READ_CAP,
    estimated_usd,
    max_results_within_budget,
    budget_block_report,
)


def test_estimate_uses_the_cited_per_post_rate():
    assert estimated_usd(2) == Decimal("0.010")
    assert PLATFORM_POST_READ_CAP == 3_000_000


def test_customer_and_global_caps_block_the_page():
    assert max_results_within_budget(2_000, 0, 2_000, 20_000, 100) is None
    customer = budget_block_report("x_customer_cap")
    assert customer.fetched_count is None
    assert customer.state == "rate_limited"
    assert customer.detail == "x_customer_cap"
    assert max_results_within_budget(0, 20_000, 2_000, 20_000, 100) is None
    assert budget_block_report("x_global_cap").detail == "x_global_cap"


def test_page_size_stays_inside_x_limits_and_the_platform_cap():
    assert max_results_within_budget(0, 0, 50, 20_000, 100) == 50
    assert max_results_within_budget(0, 2_999_995, 2_000, 9_000_000, 100) is None


def test_unapproved_files_block_collection(tmp_path):
    from sentiment_monitor.collect_once import gate

    config = tmp_path / "config"
    config.mkdir()
    (config / "credential-policy.json").write_text(
        '{"approved": false, "mode": "shared_operator"}', encoding="utf-8"
    )
    (config / "x-budget.json").write_text('{"approved": false}', encoding="utf-8")
    assert gate(tmp_path) == 2
```

Write `config/x-budget.json`:

```json
{ "approved": false }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_x_cost.py -v`

Expected: FAIL. `sentiment_monitor.x_cost` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/worker/sentiment_monitor/x_cost.py`:

```python
from decimal import Decimal

from sentiment_monitor.status import CollectionReport

# Posts: Read, $0.005 per resource.
# https://docs.x.com/x-api/getting-started/pricing.md observed 2026-11-01.
# Prices on that page are subject to change.
POSTS_READ_USD = Decimal("0.005")

# Pay-per-usage plans are capped at 3 million Post reads per monthly billing cycle.
# Same official page, observed 2026-11-01.
PLATFORM_POST_READ_CAP = 3_000_000


def estimated_usd(posts_returned: int) -> Decimal:
    return POSTS_READ_USD * posts_returned


def max_results_within_budget(
    posts_already_customer: int,
    posts_already_global: int,
    customer_cap: int,
    global_cap: int,
    requested: int,
) -> int | None:
    if requested < 10:
        return None
    remaining = min(
        customer_cap - posts_already_customer,
        min(global_cap, PLATFORM_POST_READ_CAP) - posts_already_global,
    )
    if remaining < 10:
        return None
    return min(requested, 100, remaining)


def budget_block_report(detail: str) -> CollectionReport:
    if detail not in ("x_customer_cap", "x_global_cap"):
        raise ValueError(detail)
    return CollectionReport("x", "failed", None, "rate_limited", detail, False)
```

Write `apps/worker/sentiment_monitor/collect_once.py`:

```python
import json
from pathlib import Path


def gate(root: Path) -> int:
    policy = json.loads((root / "config" / "credential-policy.json").read_text(encoding="utf-8"))
    budget = json.loads((root / "config" / "x-budget.json").read_text(encoding="utf-8"))
    if policy.get("approved") is not True or budget.get("approved") is not True:
        return 2
    if policy.get("mode") != "shared_operator":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(gate(Path(__file__).resolve().parents[3]))
```

`parents[3]` is the repository root when this file lives at `apps/worker/sentiment_monitor/collect_once.py`. `python -m sentiment_monitor.collect_once` uses this module. While `gate` returns 2 it must not construct `XSource` or `ThreadsSource`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_x_cost.py -v`

Expected: PASS. 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/sentiment_monitor/x_cost.py apps/worker/sentiment_monitor/collect_once.py apps/worker/tests/test_x_cost.py config/x-budget.json
git commit -m "feat: cap X recent-search reads before the request"
```

- [ ] **Step 6: Write the failing database-cap tests**

Add the import lines at the top of `apps/worker/tests/test_x_cost.py`. Append the class and tests after the tests from Step 1. Run pytest from the repository root so `Path("config/limits.json")` resolves.

```python
from pathlib import Path

from sentiment_monitor.limits import load_limits
from sentiment_monitor.x_cost import (
    GLOBAL_CUSTOMER_ID,
    admit_threads_query,
    admit_x_read,
    run_threads,
    threads_block_report,
)


class ScriptedConn:
    def __init__(self, customer_posts=0, global_posts=0, threads_used=0):
        self.customer_posts = customer_posts
        self.global_posts = global_posts
        self.threads_used = threads_used
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        lowered = " ".join(sql.lower().split())
        if "from threads_query_log" in lowered and "count" in lowered:
            return self.threads_used
        if "from x_read_counters" in lowered and "for update" in lowered:
            if params[0] == GLOBAL_CUSTOMER_ID:
                return self.global_posts
            return self.customer_posts
        return None


def test_limits_file_has_the_conservative_defaults():
    limits = load_limits(Path("config/limits.json"), {})
    assert limits.x_monthly_global_post_reads == 20_000
    assert limits.x_monthly_per_customer_post_reads == 2_000
    assert limits.threads_rolling_24h_reserve == 1_500
    assert limits.threads_rolling_24h_platform == 2_200
    assert limits.threads_rolling_24h_reserve < limits.threads_rolling_24h_platform
    overridden = load_limits(Path("config/limits.json"), {"X_MONTHLY_GLOBAL_POST_READS": "100"})
    assert overridden.x_monthly_global_post_reads == 100


def test_x_customer_cap_reads_postgres_and_does_not_fetch():
    conn = ScriptedConn(customer_posts=2_000, global_posts=10)
    limits = load_limits(Path("config/limits.json"), {})
    result = admit_x_read(conn, "11111111-1111-4111-8111-111111111111", 10, limits)
    assert result.detail == "x_customer_cap"
    assert result.fetched_count is None
    assert "for update" in conn.statements[0].lower()
    assert "x_read_counters" in conn.statements[0]
    assert "api.x.com" not in "\n".join(conn.statements)


def test_x_global_cap_reads_postgres_and_does_not_fetch():
    conn = ScriptedConn(customer_posts=0, global_posts=20_000)
    limits = load_limits(Path("config/limits.json"), {})
    result = admit_x_read(conn, "11111111-1111-4111-8111-111111111111", 10, limits)
    assert result.detail == "x_global_cap"
    joined = "\n".join(conn.statements).lower()
    assert "date_trunc('month'" in joined
    assert "for update" in joined


def test_threads_guard_stops_at_the_reserve_before_the_query():
    limits = load_limits(Path("config/limits.json"), {})
    blocked = ScriptedConn(threads_used=1_500)
    calls = []
    result = run_threads(blocked, limits, fetch=lambda: calls.append("threads"))
    assert result.detail == "threads_budget"
    assert result.fetched_count is None
    assert calls == []
    assert "interval '24 hours'" in blocked.statements[0]
    assert not any("insert into threads_query_log" in sql.lower() for sql in blocked.statements)
    allowed = ScriptedConn(threads_used=1_499)
    ran = run_threads(allowed, limits, fetch=lambda: calls.append("threads") or "sent")
    assert calls == ["threads"]
    assert ran == "sent"
    assert any("insert into threads_query_log" in sql.lower() for sql in allowed.statements)


def test_usage_tables_are_forced_rls():
    sql = Path("apps/web/src/db/sql/003_usage_caps.sql").read_text(encoding="utf-8")
    assert "x_read_counters" in sql
    assert "threads_query_log" in sql
    assert sql.lower().count("force row level security") >= 2
    assert "grant select on x_read_counters to app_user" in sql.lower()
    assert "threads_query_log to app_user" not in sql.lower()
```

- [ ] **Step 7: Run the new tests to verify they fail**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_x_cost.py -v`

Expected: FAIL. `sentiment_monitor.limits` does not exist, or `admit_x_read` is missing. The four tests from Step 4 still pass.

- [ ] **Step 8: Write the counters, the reserve, and the guard**

Write `apps/web/src/db/sql/003_usage_caps.sql`:

```sql
create table x_read_counters (
  customer_id uuid not null,
  period_start date not null,
  posts_reserved integer not null,
  primary key (customer_id, period_start)
);

create table threads_query_log (
  id uuid primary key,
  queried_at timestamptz not null
);

grant select on x_read_counters to app_user;
grant select, insert, update on x_read_counters, threads_query_log to worker_role;

alter table x_read_counters enable row level security;
alter table x_read_counters force row level security;
alter table threads_query_log enable row level security;
alter table threads_query_log force row level security;

create policy x_read_counters_tenant on x_read_counters
  for select to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid);
create policy x_read_counters_worker on x_read_counters
  for all to worker_role using (true) with check (true);
create policy threads_query_log_worker on threads_query_log
  for all to worker_role using (true) with check (true);
```

The global X row uses `GLOBAL_CUSTOMER_ID`, which is not a customer, so the tenant policy hides it from `app_user`. `threads_query_log` is not granted to `app_user` and has no policy for that role, so owners cannot read or write the shared counter. This migration grants `x_read_counters` select to `app_user` and both tables to `worker_role`. The select policy then limits an owner to their own X counter. A policy without a `GRANT` would not let `app_user` read the row.

Write `apps/worker/sentiment_monitor/limits.py`:

```python
import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Limits:
    x_monthly_global_post_reads: int
    x_monthly_per_customer_post_reads: int
    threads_rolling_24h_reserve: int
    threads_rolling_24h_platform: int
    schedule_min_interval_hours: int
    manual_min_interval_seconds: int
    max_jobs_per_tick: int
    worker_poll_seconds: int
    worker_heartbeat_stale_seconds: int


def load_limits(path: Path, env: dict[str, str] | None = None) -> Limits:
    source = os.environ if env is None else env
    file = json.loads(path.read_text(encoding="utf-8"))

    def value(name: str, key: str) -> int:
        raw = source.get(name)
        return int(raw) if raw not in (None, "") else int(file[key])

    limits = Limits(
        x_monthly_global_post_reads=value("X_MONTHLY_GLOBAL_POST_READS", "x_monthly_global_post_reads"),
        x_monthly_per_customer_post_reads=value("X_MONTHLY_PER_CUSTOMER_POST_READS", "x_monthly_per_customer_post_reads"),
        threads_rolling_24h_reserve=value("THREADS_ROLLING_24H_RESERVE", "threads_rolling_24h_reserve"),
        threads_rolling_24h_platform=value("THREADS_ROLLING_24H_PLATFORM", "threads_rolling_24h_platform"),
        schedule_min_interval_hours=value("SCHEDULE_MIN_INTERVAL_HOURS", "schedule_min_interval_hours"),
        manual_min_interval_seconds=value("MANUAL_MIN_INTERVAL_SECONDS", "manual_min_interval_seconds"),
        max_jobs_per_tick=value("MAX_JOBS_PER_TICK", "max_jobs_per_tick"),
        worker_poll_seconds=value("WORKER_POLL_SECONDS", "worker_poll_seconds"),
        worker_heartbeat_stale_seconds=value("WORKER_HEARTBEAT_STALE_SECONDS", "worker_heartbeat_stale_seconds"),
    )
    if limits.threads_rolling_24h_reserve > limits.threads_rolling_24h_platform:
        raise ValueError("threads_reserve")
    if not 15 <= limits.worker_poll_seconds <= 30:
        raise ValueError("worker_poll_seconds")
    return limits
```

When `env` is omitted, `load_limits` reads the process environment so Railway variables override the file. The tests pass `{}` so they see the file defaults, and one test passes a one-key dict.

Append to `apps/worker/sentiment_monitor/x_cost.py`:

```python
GLOBAL_CUSTOMER_ID = "00000000-0000-0000-0000-000000000000"

X_COUNTER_SQL = """
select coalesce(posts_reserved, 0)
from x_read_counters
where customer_id = %s
  and period_start = date_trunc('month', now() at time zone 'utc')::date
for update
"""

RESERVE_X_SQL = """
insert into x_read_counters (customer_id, period_start, posts_reserved)
values (%s, date_trunc('month', now() at time zone 'utc')::date, %s)
on conflict (customer_id, period_start)
do update set posts_reserved = x_read_counters.posts_reserved + excluded.posts_reserved
"""

THREADS_COUNT_SQL = """
select count(*)
from threads_query_log
where queried_at > now() - interval '24 hours'
"""

RESERVE_THREADS_SQL = """
insert into threads_query_log (id, queried_at)
values (gen_random_uuid(), now())
"""


def threads_block_report() -> CollectionReport:
    return CollectionReport("threads", "failed", None, "rate_limited", "threads_budget", False)


def _counter(conn, sql: str, params: tuple) -> int:
    found = conn.execute(sql, params)
    return int(found or 0)


def admit_x_read(conn, customer_id: str, requested: int, limits) -> int | CollectionReport:
    customer_used = _counter(conn, X_COUNTER_SQL, (customer_id,))
    global_used = _counter(conn, X_COUNTER_SQL, (GLOBAL_CUSTOMER_ID,))
    if customer_used + requested > limits.x_monthly_per_customer_post_reads:
        return budget_block_report("x_customer_cap")
    if global_used + requested > limits.x_monthly_global_post_reads:
        return budget_block_report("x_global_cap")
    page = max_results_within_budget(
        customer_used,
        global_used,
        limits.x_monthly_per_customer_post_reads,
        limits.x_monthly_global_post_reads,
        requested,
    )
    if page is None:
        detail = "x_global_cap" if global_used >= customer_used else "x_customer_cap"
        return budget_block_report(detail)
    conn.execute(RESERVE_X_SQL, (customer_id, page))
    conn.execute(RESERVE_X_SQL, (GLOBAL_CUSTOMER_ID, page))
    return page


def admit_threads_query(conn, limits) -> CollectionReport | None:
    used = _counter(conn, THREADS_COUNT_SQL, ())
    if used >= limits.threads_rolling_24h_reserve:
        return threads_block_report()
    conn.execute(RESERVE_THREADS_SQL, ())
    return None


def run_threads(conn, limits, fetch):
    blocked = admit_threads_query(conn, limits)
    if blocked is not None:
        return blocked
    return fetch()
```

`admit_x_read` reserves the page size on the customer row and the global sentinel row before it returns. The caller may call X only when the return value is an `int`. `admit_threads_query` inserts the rolling-window row before it returns `None`. Both checks are the statements above; they do not contain a host name.

`_counter` must tolerate `ScriptedConn.execute` returning an int. A real psycopg cursor returns a row. In Task 22 the scheduler wraps psycopg so `execute` returns the first column, matching this helper. Do not call `fetch` inside `admit_x_read` or `admit_threads_query`.

The `test_x_global_cap` assertion looks for `date_trunc('month'` in the executed SQL. `X_COUNTER_SQL` contains that fragment. `ScriptedConn` records the SQL string passed in, so the global check's statement is in `conn.statements`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `apps/worker/.venv/bin/pytest apps/worker/tests/test_x_cost.py -v`

Expected: PASS. 9 tests.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/sentiment_monitor/x_cost.py apps/worker/sentiment_monitor/limits.py apps/worker/tests/test_x_cost.py apps/web/src/db/sql/003_usage_caps.sql
git commit -m "feat: stop X and Threads calls at the database caps"
```

---

### Task 13: Send one Jev request and fall back to OpenRouter

**Files:**
- Create: `apps/web/src/jev/questions.ts`
- Create: `apps/web/src/jev/client.ts`
- Create: `config/topic-labels.json`
- Test: `apps/web/src/jev/client.test.ts`

**Interfaces:**
- Consumes: `ParsedJudgment` from `apps/web/src/domain/routing.ts`
- Produces:
  - `buildSystemOneBody(input: { model: string; brandName: string; text: string; topics: { id: string; instructions: string }[] }): { model: string; state: { brand: string; text: string }; questions: Record<string, unknown> }`
  - `parseSystemOne(payload: { model: string; answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number }> }): ParsedJudgment`
  - `TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"`
  - `OPENROUTER_URL = "https://openrouter.ai/api/v1/systemone"`
  - `TYPESAFE_MODEL = "jev-1.14.0"`
  - `OPENROUTER_MODEL = "typesafe/jev-1.14"`
  - `shouldFallback(error: { status?: number; network?: boolean }): boolean` is true for `network: true` and for statuses 402, 408, 429, 500, 502, 503, and 504. It is false for 400 and 401.
  - `scoreWithFallback(body, io: { primary: Function; fallback: Function }, fallbackEnabled: boolean): Promise<{ provider: "typesafe" | "openrouter"; model: string; judgment: ParsedJudgment }>`

The body has `questions.relevant` as a noul, `questions.sentiment` as a choice of `positive`, `neutral`, and `negative`, and one noul named `topic_<id>` per supplied topic. It has no `box` question and no field asking for prose. `config/topic-labels.json` is `{ "approved": false, "fallbackId": null, "labels": [] }`. An empty label list produces a body with no topic questions.

**Acceptance criteria:**
- Covers AC-3's "one recorded relevance judgment, and where relevant sentiment and topics."
- One call object contains relevance, sentiment, and every configured topic. The test asserts `primary` is called once.
- A 503 uses the fallback and records `provider: "openrouter"`. A 400 does not call the fallback.
- `fallbackEnabled: false` rethrows a 503.
- The test injects both transports. It does not call TypeSafe or OpenRouter.

- [ ] **Step 1: Write the failing test**

Write `config/topic-labels.json`:

```json
{ "approved": false, "fallbackId": null, "labels": [] }
```

Write `apps/web/src/jev/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildSystemOneBody, scoreWithFallback, TYPESAFE_MODEL, OPENROUTER_MODEL } from "./client";

const answers = {
  relevant: { type: "noul", noul: 0.93 },
  sentiment: { type: "choice", choice: "negative", confidence: 0.88 },
  topic_harga: { type: "noul", noul: 0.8 },
};

describe("buildSystemOneBody", () => {
  it("puts relevance, sentiment, and topics in one body and does not ask for a box", () => {
    const body = buildSystemOneBody({
      model: TYPESAFE_MODEL,
      brandName: "ayam geprek pak gembus",
      text: "geprek gembus mahal",
      topics: [{ id: "harga", instructions: "The post is about price." }],
    });
    expect(body.model).toBe("jev-1.14.0");
    expect(body.questions.relevant).toMatchObject({ type: "noul" });
    expect(body.questions.sentiment).toMatchObject({ type: "choice" });
    expect(body.questions.topic_harga).toMatchObject({ type: "noul" });
    expect(JSON.stringify(body)).not.toContain('"box"');
  });
});

describe("scoreWithFallback", () => {
  it("calls the primary once when it succeeds", async () => {
    const primary = vi.fn(async () => ({ model: "jev-1.14.0", answers }));
    const fallback = vi.fn();
    const body = buildSystemOneBody({
      model: TYPESAFE_MODEL,
      brandName: "ayam geprek pak gembus",
      text: "geprek gembus mahal",
      topics: [{ id: "harga", instructions: "The post is about price." }],
    });
    const scored = await scoreWithFallback(body, { primary, fallback }, true);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(scored.provider).toBe("typesafe");
    expect(scored.judgment.sentiment).toBe("negative");
    expect(scored.judgment.topicNouls).toEqual([{ id: "harga", noul: 0.8 }]);
  });

  it("falls back on a 503 and refuses a 400", async () => {
    const body = buildSystemOneBody({
      model: TYPESAFE_MODEL,
      brandName: "merek",
      text: "teks",
      topics: [],
    });
    const fallback = vi.fn(async () => ({ model: "typesafe/jev-1.14", answers }));
    const scored = await scoreWithFallback(
      body,
      { primary: async () => Promise.reject({ status: 503 }), fallback },
      true,
    );
    expect(scored.provider).toBe("openrouter");
    expect(scored.model).toBe(OPENROUTER_MODEL);
    await expect(
      scoreWithFallback(body, { primary: async () => Promise.reject({ status: 400 }), fallback }, true),
    ).rejects.toEqual({ status: 400 });
  });

  it("does not call OpenRouter when the fallback flag is off", async () => {
    const fallback = vi.fn();
    const body = buildSystemOneBody({ model: TYPESAFE_MODEL, brandName: "merek", text: "teks", topics: [] });
    await expect(
      scoreWithFallback(body, { primary: async () => Promise.reject({ status: 503 }), fallback }, false),
    ).rejects.toEqual({ status: 503 });
    expect(fallback).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/jev/client.test.ts`

Expected: FAIL. Cannot resolve `./client`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/jev/questions.ts`:

```ts
export type TopicQuestion = { id: string; instructions: string };

export function buildSystemOneBody(input: {
  model: string;
  brandName: string;
  text: string;
  topics: TopicQuestion[];
}): { model: string; state: { brand: string; text: string }; questions: Record<string, unknown> } {
  const questions: Record<string, unknown> = {
    relevant: {
      type: "noul",
      instructions: "The post is about the named brand.",
      criteria: {
        true: "A reader would treat the post as a mention of this brand.",
        false: "The words are unrelated, including a different product that only shares part of the name.",
      },
    },
    sentiment: {
      type: "choice",
      instructions: "What is the sentiment toward the brand?",
      criteria: {
        positive: "Praise or a favorable experience",
        neutral: "A factual or mixed mention without a clear favorable or unfavorable stance",
        negative: "A complaint or an unfavorable experience",
      },
    },
  };
  for (const topic of input.topics) {
    questions[`topic_${topic.id}`] = {
      type: "noul",
      instructions: topic.instructions,
    };
  }
  return { model: input.model, state: { brand: input.brandName, text: input.text }, questions };
}
```

Write `apps/web/src/jev/client.ts`:

```ts
import type { ParsedJudgment } from "../domain/routing";
import { buildSystemOneBody, type TopicQuestion } from "./questions";

export { buildSystemOneBody, type TopicQuestion };

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/systemone";
export const TYPESAFE_MODEL = "jev-1.14.0";
export const OPENROUTER_MODEL = "typesafe/jev-1.14";

const FALLBACK_STATUSES = new Set([402, 408, 429, 500, 502, 503, 504]);

type TransportResponse = { model: string; answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number }> };
type Transport = (body: unknown) => Promise<TransportResponse>;

export function shouldFallback(error: { status?: number; network?: boolean }): boolean {
  if (error.network) return true;
  return error.status !== undefined && FALLBACK_STATUSES.has(error.status);
}

export function parseSystemOne(payload: TransportResponse): ParsedJudgment {
  const sentiment = payload.answers.sentiment?.choice;
  if (sentiment !== "positive" && sentiment !== "neutral" && sentiment !== "negative") {
    throw new Error("invalid_sentiment");
  }
  const relevance = payload.answers.relevant?.noul;
  const confidence = payload.answers.sentiment?.confidence;
  if (typeof relevance !== "number" || typeof confidence !== "number") throw new Error("invalid_judgment");
  const topicNouls = Object.entries(payload.answers)
    .filter(([key]) => key.startsWith("topic_"))
    .map(([key, value]) => ({ id: key.slice("topic_".length), noul: value.noul ?? 0 }));
  return { relevanceNoul: relevance, sentiment, sentimentConfidence: confidence, topicNouls };
}

export async function scoreWithFallback(
  body: ReturnType<typeof buildSystemOneBody>,
  io: { primary: Transport; fallback: Transport },
  fallbackEnabled: boolean,
): Promise<{ provider: "typesafe" | "openrouter"; model: string; judgment: ParsedJudgment }> {
  try {
    const response = await io.primary(body);
    return { provider: "typesafe", model: response.model, judgment: parseSystemOne(response) };
  } catch (error) {
    const reason = typeof error === "object" && error !== null ? (error as { status?: number; network?: boolean }) : {};
    if (!fallbackEnabled || !shouldFallback(reason)) throw error;
    const response = await io.fallback({ ...body, model: OPENROUTER_MODEL });
    return { provider: "openrouter", model: response.model, judgment: parseSystemOne(response) };
  }
}
```

The production transports, added in this same step to `apps/web/src/jev/http.ts`, are the only functions that know the URLs:

```ts
import { OPENROUTER_URL, TYPESAFE_URL } from "./client";

export async function postSystemOne(url: string, body: unknown, apiKey: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw { status: response.status };
  return response.json();
}

export const primaryTransport = (apiKey: string) => (body: unknown) => postSystemOne(TYPESAFE_URL, body, apiKey);
export const fallbackTransport = (apiKey: string) => (body: unknown) => postSystemOne(OPENROUTER_URL, body, apiKey);
```

Do not call `postSystemOne` from a test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/jev/client.test.ts`

Expected: PASS. 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/jev config/topic-labels.json
git commit -m "feat: score each post with one Jev request"
```

---

### Task 14: Persist scores, retries, and owner corrections

**Files:**
- Create: `apps/web/src/ingest/mentions.ts`
- Create: `apps/web/src/domain/display.ts`
- Create: `apps/web/src/scoring/jobs.ts`
- Test: `apps/web/src/scoring/jobs.test.ts`

**Interfaces:**
- Consumes: `routeJudgment`, `failedScoring`, `overviewScore`, `withCustomer`, `attentionDecision`, `dedupeAttention`
- Produces:
  - `ingestMention(db, input: { customerId: string; projectId: string; source: "x" | "threads"; externalId: string; variant: string; excerpt: string; url: string | null; author: string | null; postedAt: string }): Promise<{ id: string; result: "inserted" | "deduped" }>`
  - `claimMention(db, customerId: string, mentionId: string): Promise<boolean>` which updates `pending` to `scoring`
  - `recordSuccess(db, customerId, mentionId, input: { provider: "typesafe" | "openrouter"; model: string; raw: unknown; judgment: ParsedJudgment }): Promise<void>`
  - `recordFailure(db, customerId, mentionId): Promise<void>` sets `scoring_status` to `failed` and writes no sentiment
  - `DisplayState = { bucket: "included" | "excluded" | "not_sure" | "failed" | "policy_unapproved"; relevance: "relevant" | "irrelevant" | null; sentiment: "positive" | "neutral" | "negative" | null; topics: string[]; source: "jev" | "owner_confirm" | "owner_correct" | "failed" }`
  - `displayOf(route: RouteDecision | FailedScoring, correction: { action: "confirm" | "correct"; relevance: "relevant" | "irrelevant"; sentiment: "positive" | "neutral" | "negative" | null; topics: string[] } | null): DisplayState`
  - `saveCorrection(db, customerId, mentionId, correction): Promise<void>`

A second ingest of the same `(customerId, source, externalId)` appends the variant if it is new, returns `deduped`, and does not change `scoring_status`. `displayOf` with a failed route and no correction returns sentiment `null` and source `failed`. A correction replaces the displayed bucket: `relevant` becomes `included`, `irrelevant` becomes `excluded`. The `jev_results` row is not updated.

**Acceptance criteria:**
- Covers AC-2, AC-3, and AC-5.
- A stored failed mention displayed through `displayOf(failedScoring(), null)` has sentiment `null`.
- An excluded "tempe gembus" route does not increment `overviewScore`.
- An owner correction to relevant/positive changes the displayed aggregate and leaves the stored `relevance_noul` untouched.
- Two variants of external id `100` produce one mention and one attention decision.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/scoring/jobs.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable } from "../db/migrate";
import { overviewScore } from "../domain/aggregates";
import { failedScoring, routeJudgment, type ScoringPolicy } from "../domain/routing";
import { createProject } from "../projects/handlers";
import { displayOf } from "../domain/display";
import { ingestMention } from "../ingest/mentions";
import { attentionDecision } from "../domain/attention";
import { recordFailure, recordSuccess, saveCorrection } from "./jobs";

const policy: ScoringPolicy = {
  approved: true,
  relevanceExcludeMax: 0.2,
  relevanceIncludeMin: 0.8,
  sentimentConfidenceMin: 0.75,
  topicNoulMin: 0.7,
  attentionNegativeConfidenceMin: 0.8,
  fallbackTopicId: null,
};

describe("scoring persistence", () => {
  it("dedupes variants, keeps the raw judgment, and applies a correction only to the display", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "owner@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "ayam geprek pak gembus");
    const first = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "x",
      externalId: "100",
      variant: "geprek gembus",
      excerpt: "geprek gembus enak",
      url: "https://x.com/ani/status/100",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    const second = await ingestMention(db, { ...{
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "x" as const,
      externalId: "100",
      variant: "ayam pak gembus",
      excerpt: "geprek gembus enak",
      url: "https://x.com/ani/status/100",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    } });
    expect(second.result).toBe("deduped");
    expect(second.id).toBe(first.id);
    const judgment = { relevanceNoul: 0.05, sentiment: "negative" as const, sentimentConfidence: 0.99, topicNouls: [] };
    await recordSuccess(db, owner.customerId, first.id, {
      provider: "typesafe",
      model: "jev-1.14.0",
      raw: judgment,
      judgment,
    });
    const excluded = displayOf(routeJudgment(judgment, policy), null);
    expect(excluded.bucket).toBe("excluded");
    expect(overviewScore({ positive: 0, negative: 0, neutral: 0 })).toEqual({ kind: "empty" });
    await saveCorrection(db, owner.customerId, first.id, {
      action: "correct",
      relevance: "relevant",
      sentiment: "positive",
      topics: [],
    });
    const shown = displayOf(routeJudgment(judgment, policy), {
      action: "correct",
      relevance: "relevant",
      sentiment: "positive",
      topics: [],
    });
    expect(shown.source).toBe("owner_correct");
    expect(overviewScore({ positive: 1, negative: 0, neutral: 0 }).kind).toBe("score");
    const raw = await db.query<{ relevance_noul: number }>("select relevance_noul from jev_results where mention_id = $1", [first.id]);
    expect(raw.rows[0].relevance_noul).toBe(0.05);
    expect(displayOf(failedScoring(), null)).toMatchObject({ bucket: "failed", sentiment: null, source: "failed" });
    expect(attentionDecision({ mentionId: first.id, route: routeJudgment(judgment, policy), sentimentConfidence: 0.99 }, policy).eligible).toBe(false);
  });

  it("marks a failed claim target as failed without a sentiment", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "dua@example.com", password: "sandi-panjang" });
    const project = await createProject(db, owner.customerId, "kedai");
    const mention = await ingestMention(db, {
      customerId: owner.customerId,
      projectId: project.projectId,
      source: "threads",
      externalId: "55",
      variant: "kedai",
      excerpt: "teks",
      url: "https://www.threads.com/@ani/post/55",
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    });
    await recordFailure(db, owner.customerId, mention.id);
    const row = await db.query<{ scoring_status: string }>("select scoring_status from mentions where id = $1", [mention.id]);
    expect(row.rows[0].scoring_status).toBe("failed");
    const jev = await db.query("select mention_id from jev_results where mention_id = $1", [mention.id]);
    expect(jev.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/scoring/jobs.test.ts`

Expected: FAIL. Cannot resolve `../ingest/mentions`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/domain/display.ts`:

```ts
import type { FailedScoring, RouteDecision } from "./routing";

export type OwnerCorrection = {
  action: "confirm" | "correct";
  relevance: "relevant" | "irrelevant";
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
};

export type DisplayState = {
  bucket: "included" | "excluded" | "not_sure" | "failed" | "policy_unapproved";
  relevance: "relevant" | "irrelevant" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
  source: "jev" | "owner_confirm" | "owner_correct" | "failed";
};

export function displayOf(route: RouteDecision | FailedScoring, correction: OwnerCorrection | null): DisplayState {
  if (correction) {
    return {
      bucket: correction.relevance === "relevant" ? "included" : "excluded",
      relevance: correction.relevance,
      sentiment: correction.relevance === "relevant" ? correction.sentiment : null,
      topics: correction.relevance === "relevant" ? correction.topics : [],
      source: correction.action === "confirm" ? "owner_confirm" : "owner_correct",
    };
  }
  if (route.bucket === "failed") {
    return { bucket: "failed", relevance: null, sentiment: null, topics: [], source: "failed" };
  }
  return {
    bucket: route.bucket,
    relevance: route.relevance === "relevant" || route.relevance === "irrelevant" ? route.relevance : null,
    sentiment: route.sentiment,
    topics: route.topics,
    source: "jev",
  };
}
```

Write `apps/web/src/ingest/mentions.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";

export async function ingestMention(
  db: Queryable,
  input: {
    customerId: string;
    projectId: string;
    source: "x" | "threads";
    externalId: string;
    variant: string;
    excerpt: string;
    url: string | null;
    author: string | null;
    postedAt: string;
  },
): Promise<{ id: string; result: "inserted" | "deduped" }> {
  return withCustomer(db, input.customerId, async () => {
    const existing = await db.query<{ id: string; matched_variants: string[] }>(
      "select id, matched_variants from mentions where customer_id = $1 and source = $2 and external_id = $3",
      [input.customerId, input.source, input.externalId],
    );
    if (existing.rows[0]) {
      const variants = existing.rows[0].matched_variants.includes(input.variant)
        ? existing.rows[0].matched_variants
        : [...existing.rows[0].matched_variants, input.variant];
      await db.query("update mentions set matched_variants = $1 where id = $2 and customer_id = $3", [
        variants,
        existing.rows[0].id,
        input.customerId,
      ]);
      return { id: existing.rows[0].id, result: "deduped" as const };
    }
    const id = randomUUID();
    await db.query(
      `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, 'pending')`,
      [id, input.customerId, input.projectId, input.source, input.externalId, input.excerpt, input.url, input.author, input.postedAt, [input.variant]],
    );
    return { id, result: "inserted" as const };
  });
}
```

Write `apps/web/src/scoring/jobs.ts`:

```ts
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import type { ParsedJudgment } from "../domain/routing";
import type { OwnerCorrection } from "../domain/display";

export async function claimMention(db: Queryable, customerId: string, mentionId: string): Promise<boolean> {
  const claimed = await withCustomer(db, customerId, () =>
    db.query<{ id: string }>(
      "update mentions set scoring_status = 'scoring' where id = $1 and customer_id = $2 and scoring_status = 'pending' returning id",
      [mentionId, customerId],
    ),
  );
  return claimed.rows.length === 1;
}

export async function recordSuccess(
  db: Queryable,
  customerId: string,
  mentionId: string,
  input: { provider: "typesafe" | "openrouter"; model: string; raw: unknown; judgment: ParsedJudgment },
): Promise<void> {
  await withCustomer(db, customerId, async () => {
    await db.query(
      `insert into jev_results (mention_id, customer_id, provider, model, raw_response, relevance_noul, sentiment, sentiment_confidence, topic_nouls, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
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
    await db.query("update mentions set scoring_status = 'succeeded' where id = $1 and customer_id = $2", [
      mentionId,
      customerId,
    ]);
  });
}

export async function recordFailure(db: Queryable, customerId: string, mentionId: string): Promise<void> {
  await withCustomer(db, customerId, () =>
    db.query("update mentions set scoring_status = 'failed' where id = $1 and customer_id = $2", [mentionId, customerId]),
  );
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/scoring/jobs.test.ts`

Expected: PASS. 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ingest apps/web/src/domain/display.ts apps/web/src/scoring
git commit -m "feat: persist Jev results separately from owner corrections"
```

---

### Task 15: Build Indonesian onboarding and source status screens

**Files:**
- Create: `apps/web/src/components/variant-editor.tsx`
- Create: `apps/web/src/components/source-status-list.tsx`
- Create: `apps/web/src/components/schedule-editor.tsx`
- Create: `apps/web/src/components/app-shell.tsx`
- Create: `apps/web/src/app/onboarding/page.tsx`
- Create: `apps/web/src/app/sumber/page.tsx`
- Test: `apps/web/src/components/onboarding.test.tsx`

**Interfaces:**
- Consumes: `generateCandidates`, the four source states from Task 11 (`ready`, `unavailable`, `authorization_failed`, `rate_limited`), and `readLimits` from Task 8
- Produces: `VariantEditor`, `SourceStatusList`, `ScheduleEditor`, and `AppShell` as React components. `SourceStatusList` takes `{ reports: { source: "x" | "threads"; state: "ready" | "unavailable" | "authorization_failed" | "rate_limited"; outcome: "success" | "failed" | "empty_unconfirmed"; fetchedCount: number | null; detail?: string }[] }`. `ScheduleEditor` takes `{ enabled: boolean; intervalHours: number; minIntervalHours: number; onSave: (value: { enabled: boolean; intervalHours: number }) => void }`.

**Acceptance criteria:**
- Covers AC-1's review-before-save UI and AC-4's source error state.
- The editor shows the brand `ayam geprek pak gembus` and the candidate `geprek gembus`.
- The sentence `Pencarian mengumpulkan kandidat, bukan sebutan merek yang sudah terverifikasi. Jev menilai relevansi setelahnya.` is visible.
- Empty, duplicate, and too-long errors use `Varian tidak boleh kosong.`, `Varian ini sudah ada.`, and `Varian terlalu panjang untuk pencarian X.`
- A failed report renders `Pengumpulan gagal. Ini bukan nol sebutan.` and does not render the digit `0`.
- A Threads `empty_unconfirmed` report renders `Threads mengembalikan daftar kosong. Daftar kosong juga dipakai untuk kata yang dianggap sensitif, jadi ini bukan bukti bahwa tidak ada sebutan.`
- There is no control named `Balas` or `Kirim`.
- The shell uses `flex-col` and `px-4` so the page stacks on a narrow viewport.
- `ScheduleEditor` shows `Jadwal pengumpulan` and `Asia/Jakarta`. Saving `5` when the minimum is `6` shows `Jarak jadwal minimal 6 jam.` and does not call `onSave`.
- A report whose `detail` is `x_customer_cap`, `x_global_cap`, or `threads_budget` renders the matching limit sentence and does not render `0`.

- [ ] **Step 1: Add the UI test runner and shadcn primitives**

Run from `apps/web`:

```bash
npm install -D jsdom@30.1.3 @testing-library/react@16.3.3 @testing-library/jest-dom@7.0.1
npx shadcn@latest init -y --preset base-nova --no-monorepo
npx shadcn@latest add button input label badge card -y
```

Expected: `src/components/ui/button.tsx` exists. If init cannot detect the framework, run it again with `--cwd` set to `apps/web` after `npm install` inside that directory. Do not hand-write the shadcn primitives.

In `apps/web/vitest.config.mts`, set `environment` to `jsdom` for `**/*.test.tsx` by adding a second project, or set the file's first line to `// @vitest-environment jsdom`. Use the per-file directive on the new test.

- [ ] **Step 2: Write the failing test**

Write `apps/web/src/components/onboarding.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./app-shell";
import { SourceStatusList } from "./source-status-list";
import { VariantEditor } from "./variant-editor";

describe("onboarding", () => {
  it("shows the example brand, the candidate explanation, and no reply control", () => {
    render(
      <AppShell>
        <VariantEditor
          brandName="ayam geprek pak gembus"
          candidates={["ayam geprek pak gembus", "geprek gembus"]}
          selected={["geprek gembus"]}
          error="duplicate"
          onToggle={() => undefined}
          onAdd={() => undefined}
          onSave={() => undefined}
        />
      </AppShell>,
    );
    expect(screen.getAllByText("ayam geprek pak gembus").length).toBeGreaterThan(0);
    expect(screen.getAllByText("geprek gembus").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Pencarian mengumpulkan kandidat, bukan sebutan merek yang sudah terverifikasi. Jev menilai relevansi setelahnya.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Varian ini sudah ada.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Balas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Kirim" })).toBeNull();
  });

  it("does not render a failed collection as zero", () => {
    render(
      <SourceStatusList
        reports={[
          { source: "x", state: "rate_limited", outcome: "failed", fetchedCount: null },
          { source: "threads", state: "ready", outcome: "empty_unconfirmed", fetchedCount: null },
        ]}
      />,
    );
    expect(screen.getByText("Pengumpulan gagal. Ini bukan nol sebutan.")).toBeTruthy();
    expect(screen.getByText("Batas permintaan tercapai")).toBeTruthy();
    expect(
      screen.getByText(
        "Threads mengembalikan daftar kosong. Daftar kosong juga dipakai untuk kata yang dianggap sensitif, jadi ini bukan bukti bahwa tidak ada sebutan.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/components/onboarding.test.tsx`

Expected: FAIL. Cannot resolve `./variant-editor`.

- [ ] **Step 4: Write the minimal implementation**

Write `apps/web/src/components/app-shell.tsx`:

```tsx
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-stone-900">
      <header className="border-b px-4 py-3">
        <p className="text-sm font-semibold">Pemantau sentimen merek</p>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">{children}</main>
    </div>
  );
}
```

Write `apps/web/src/components/variant-editor.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ERRORS = {
  empty: "Varian tidak boleh kosong.",
  duplicate: "Varian ini sudah ada.",
  too_long: "Varian terlalu panjang untuk pencarian X.",
} as const;

export function VariantEditor(props: {
  brandName: string;
  candidates: string[];
  selected: string[];
  error: "empty" | "duplicate" | "too_long" | null;
  onToggle: (variant: string) => void;
  onAdd: (variant: string) => void;
  onSave: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Siapkan pemantauan</h1>
      <p>{props.brandName}</p>
      <p>Pencarian mengumpulkan kandidat, bukan sebutan merek yang sudah terverifikasi. Jev menilai relevansi setelahnya.</p>
      <ul className="flex flex-col gap-2">
        {props.candidates.map((candidate) => (
          <li key={candidate}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={props.selected.includes(candidate)}
                onChange={() => props.onToggle(candidate)}
              />
              <span>{candidate}</span>
            </label>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          props.onAdd(String(data.get("variant") ?? ""));
        }}
      >
        <Label htmlFor="variant">Tambah varian</Label>
        <Input id="variant" name="variant" />
        <Button type="submit">Tambah</Button>
      </form>
      {props.error ? <p role="alert">{ERRORS[props.error]}</p> : null}
      <Button type="button" onClick={props.onSave}>Simpan</Button>
    </section>
  );
}
```

Write `apps/web/src/components/source-status-list.tsx`:

```tsx
const STATE_LABEL = {
  ready: "Siap",
  unavailable: "Tidak tersedia",
  authorization_failed: "Otorisasi gagal",
  rate_limited: "Batas permintaan tercapai",
} as const;

export function SourceStatusList(props: {
  reports: {
    source: "x" | "threads";
    state: keyof typeof STATE_LABEL;
    outcome: "success" | "failed" | "empty_unconfirmed";
    fetchedCount: number | null;
  }[];
}) {
  return (
    <ul className="flex flex-col gap-3">
      {props.reports.map((report) => (
        <li key={`${report.source}-${report.outcome}-${"detail" in report ? report.detail ?? "" : ""}`}>
          <p>{report.source === "x" ? "X" : "Threads"}</p>
          <p>{STATE_LABEL[report.state]}</p>
          {report.outcome === "failed" ? <p>Pengumpulan gagal. Ini bukan nol sebutan.</p> : null}
          {report.outcome === "empty_unconfirmed" ? (
            <p>
              Threads mengembalikan daftar kosong. Daftar kosong juga dipakai untuk kata yang dianggap sensitif, jadi ini bukan bukti bahwa tidak ada sebutan.
            </p>
          ) : null}
          {report.outcome === "success" && report.fetchedCount !== null ? (
            <p>{report.fetchedCount} kandidat baru</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
```

Add `"use client";` as the first line of `variant-editor.tsx`, `source-status-list.tsx`, and `app-shell.tsx`.

Write `apps/web/src/app/onboarding/actions.ts`:

```ts
"use server";

import { saveActiveVariants } from "@/projects/handlers";
import type { Queryable } from "@/db/migrate";

export async function saveVariantsAction(
  db: Queryable,
  customerId: string,
  projectId: string,
  variants: string[],
): Promise<{ ok: true; active: string[] } | { ok: false; reason: "empty" | "duplicate" | "too_long"; value: string }> {
  return saveActiveVariants(db, customerId, projectId, variants, async () => undefined);
}
```

`saveVariantsAction` passes a rescore function that resolves without reading mention ids. `effectOfKeywordEdit` keeps `reclassifyExisting` false, so that function is not called.

Write `apps/web/src/app/onboarding/page.tsx`:

```tsx
"use client";

import { AppShell } from "@/components/app-shell";
import { VariantEditor } from "@/components/variant-editor";

export default function OnboardingPage() {
  return (
    <AppShell>
      <VariantEditor
        brandName=""
        candidates={[]}
        selected={[]}
        error={null}
        onToggle={() => undefined}
        onAdd={() => undefined}
        onSave={() => undefined}
      />
    </AppShell>
  );
}
```

Write `apps/web/src/app/sumber/page.tsx`:

```tsx
"use client";

import { AppShell } from "@/components/app-shell";
import { SourceStatusList } from "@/components/source-status-list";

export default function SourcePage() {
  return (
    <AppShell>
      <SourceStatusList reports={[]} />
    </AppShell>
  );
}
```

Neither page contains a `<textarea>` or a button named Balas or Kirim. The onboarding save control is the `Simpan` button inside `VariantEditor`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/components/onboarding.test.tsx`

Expected: PASS. 2 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat: add Indonesian onboarding and source status"
```

- [ ] **Step 7: Write the failing schedule and cap-status test**

Add the import lines at the top of `apps/web/src/components/onboarding.test.tsx`. Place both new `it` blocks inside the existing `describe("onboarding")` callback:

```tsx
import { fireEvent } from "@testing-library/react";
import { ScheduleEditor } from "./schedule-editor";

it("rejects a schedule shorter than the configured minimum", () => {
  const onSave = vi.fn();
  render(<ScheduleEditor enabled={false} intervalHours={6} minIntervalHours={6} onSave={onSave} />);
  expect(screen.getByText("Jadwal pengumpulan")).toBeTruthy();
  expect(screen.getByText("Asia/Jakarta")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Setiap berapa jam"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Simpan jadwal" }));
  expect(screen.getByText("Jarak jadwal minimal 6 jam.")).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
});

it("renders a reached cap as a sentence instead of zero", () => {
  render(
    <SourceStatusList
      reports={[
        { source: "x", state: "rate_limited", outcome: "failed", fetchedCount: null, detail: "x_customer_cap" },
        { source: "threads", state: "rate_limited", outcome: "failed", fetchedCount: null, detail: "threads_budget" },
        { source: "x", state: "rate_limited", outcome: "failed", fetchedCount: null, detail: "x_global_cap" },
      ]}
    />,
  );
  expect(screen.getByText("Batas baca X untuk pelanggan ini tercapai. Ini bukan nol sebutan.")).toBeTruthy();
  expect(screen.getByText("Batas baca X bersama tercapai. Ini bukan nol sebutan.")).toBeTruthy();
  expect(screen.getByText("Batas pencarian Threads tercapai. Ini bukan nol sebutan.")).toBeTruthy();
  expect(screen.queryByText("0")).toBeNull();
});
```

Add `vi` to the vitest import in that file: `import { describe, expect, it, vi } from "vitest"`.

- [ ] **Step 8: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/components/onboarding.test.tsx`

Expected: FAIL. Cannot resolve `./schedule-editor`.

- [ ] **Step 9: Write the schedule editor and the cap sentences**

Write `apps/web/src/components/schedule-editor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ScheduleEditor(props: {
  enabled: boolean;
  intervalHours: number;
  minIntervalHours: number;
  onSave: (value: { enabled: boolean; intervalHours: number }) => void;
}) {
  const [enabled, setEnabled] = useState(props.enabled);
  const [hours, setHours] = useState(String(props.intervalHours));
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-3">
      <h2>Jadwal pengumpulan</h2>
      <p>Asia/Jakarta</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Aktifkan jadwal</span>
      </label>
      <Label htmlFor="interval-hours">Setiap berapa jam</Label>
      <Input
        id="interval-hours"
        inputMode="numeric"
        value={hours}
        onChange={(event) => setHours(event.target.value)}
      />
      {error ? <p role="alert">{error}</p> : null}
      <Button
        type="button"
        onClick={() => {
          const intervalHours = Number(hours);
          if (!Number.isInteger(intervalHours) || intervalHours < props.minIntervalHours) {
            setError(`Jarak jadwal minimal ${props.minIntervalHours} jam.`);
            return;
          }
          setError(null);
          props.onSave({ enabled, intervalHours });
        }}
      >
        Simpan jadwal
      </Button>
    </section>
  );
}
```

In `apps/web/src/components/source-status-list.tsx`, add optional `detail?: string` on each report and this map above the component:

```tsx
const DETAIL_LABEL: Record<string, string> = {
  x_customer_cap: "Batas baca X untuk pelanggan ini tercapai. Ini bukan nol sebutan.",
  x_global_cap: "Batas baca X bersama tercapai. Ini bukan nol sebutan.",
  threads_budget: "Batas pencarian Threads tercapai. Ini bukan nol sebutan.",
};
```

Inside each `<li>`, after the failed-outcome paragraph, render `{report.detail && DETAIL_LABEL[report.detail] ? <p>{DETAIL_LABEL[report.detail]}</p> : null}`.

The onboarding page does not need a live save yet. Pass `minIntervalHours={6}` from `readLimits().scheduleMinIntervalHours` when a later page wires `saveSchedule`. The component test passes the `6` directly.

- [ ] **Step 10: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/components/onboarding.test.tsx`

Expected: PASS. 4 tests.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/schedule-editor.tsx apps/web/src/components/source-status-list.tsx apps/web/src/components/onboarding.test.tsx
git commit -m "feat: add the collection schedule control and cap status copy"
```

---

### Task 16: Build the results dashboard

**Files:**
- Create: `apps/web/src/components/results.tsx`
- Create: `apps/web/src/components/collection-controls.tsx`
- Create: `apps/web/src/app/dasbor/actions.ts`
- Create: `apps/web/src/app/dasbor/page.tsx`
- Test: `apps/web/src/components/results.test.tsx`

**Interfaces:**
- Consumes: `OverviewScore`, `TrendBucket`, `DisplayState`, and `workerHeartbeatStaleSeconds` from `readLimits` in Task 8
- Produces: `withFilters(path: string, filters: { from?: string; to?: string; source?: string }): string`, plus `OverviewPanel`, `TrendPanel`, `TopicPanel`, `MentionFeed`, `DataStatusPanel`, and `CollectionControls`.

`CollectionControls` takes `{ lastSeenAt: string | null; now: string; staleSeconds: number; manualBlocked: boolean; onRunNow: () => void }`. It renders a button named `Kumpulkan sekarang`. That button is the Run now / collect now control. It calls `onRunNow` only when `manualBlocked` is false. It renders `Worker offline` when `lastSeenAt` is null or older than `staleSeconds`, and `Worker aktif` otherwise.

`withFilters` writes only the keys that are non-empty and preserves them in that order: `from`, `to`, `source`.

**Acceptance criteria:**
- Covers AC-4.
- Empty overview renders `Belum ada sebutan yang dinilai` and does not render a score of `0`.
- A score renders the explanation `Skor = 100 × (positif − negatif) / semua sebutan yang dihitung. Rentangnya −100 sampai +100. Ini bukan keyakinan Jev.` This is the Indonesian rendering of the spec sentence "No scored mentions" for the empty state, and of the proposed formula. When `formulaApproved` is false, also render `Rumus ini menunggu persetujuan.`
- A null timezone renders `Pilih zona waktu dan ukuran kelompok sebelum grafik ditampilkan.` and a table of each row's date and sentiment word (`Positif`, `Netral`, `Negatif`).
- Topic panel renders `Satu sebutan dihitung pada setiap label yang lolos ambang.` and, when `countingApproved` is false, `Aturan hitung topik menunggu persetujuan.`
- A mention shows excerpt, source, a link whose href is the source URL, timestamp, relevance, sentiment text, topics, confidence, and `Hasil Jev` or `Koreksi pemilik`.
- Failed scoring renders `Penilaian gagal`. Pending renders `Penilaian tertunda`. Neither renders `Netral` unless the sentiment is actually neutral.
- `sourcePostUnavailable` renders `Postingan tidak lagi tersedia`, which is a different string from `Penilaian gagal`.
- Missing dates render `Pilih rentang tanggal.`
- Data status includes `Nilai keyakinan adalah ketidakpastian model, bukan jaminan kebenaran.`
- Links to attention and review use `withFilters`, so `from`, `to`, and `source` survive.
- A stale or missing heartbeat renders `Worker offline`. A fresh heartbeat renders `Worker aktif`.
- `Kumpulkan sekarang` calls `onRunNow` once when the manual interval allows it, and renders `Tunggu 15 menit sebelum mengumpulkan lagi.` without calling `onRunNow` when `manualBlocked` is true.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/components/results.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataStatusPanel, MentionFeed, OverviewPanel, TopicPanel, TrendPanel, withFilters } from "./results";

describe("results", () => {
  it("keeps filters and explains an empty score", () => {
    expect(withFilters("/dasbor/perlu-perhatian", { from: "2026-11-01", to: "2026-11-02", source: "x" })).toBe(
      "/dasbor/perlu-perhatian?from=2026-11-01&to=2026-11-02&source=x",
    );
    render(<OverviewPanel score={{ kind: "empty" }} included={0} formulaApproved={false} from="" to="" />);
    expect(screen.getByText("Belum ada sebutan yang dinilai")).toBeTruthy();
    expect(screen.getByText("Pilih rentang tanggal.")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("shows a failed mention as failed and a correction as the owner's", () => {
    render(
      <MentionFeed
        mentions={[
          {
            id: "1",
            excerpt: "geprek gembus mahal",
            source: "x",
            url: "https://x.com/ani/status/100",
            postedAt: "2026-11-01T00:00:00.000Z",
            relevance: "relevant",
            sentiment: null,
            topics: [],
            confidence: null,
            displaySource: "failed",
            scoringStatus: "failed",
            sourcePostUnavailable: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("Penilaian gagal")).toBeTruthy();
    expect(screen.queryByText("Netral")).toBeNull();
    expect(screen.getByRole("link", { name: "Buka sumber" }).getAttribute("href")).toBe("https://x.com/ani/status/100");
  });

  it("asks for a timezone instead of inventing a bucket", () => {
    render(
      <TrendPanel
        timeZone={null}
        bucket={null}
        rows={[{ createdAt: "2026-11-01", sentiment: "negative" }]}
        buckets={[]}
      />,
    );
    expect(screen.getByText("Pilih zona waktu dan ukuran kelompok sebelum grafik ditampilkan.")).toBeTruthy();
    expect(screen.getByText("Negatif")).toBeTruthy();
  });

  it("explains multi-topic counts", () => {
    render(<TopicPanel counts={[{ label: "harga", count: 2 }]} countingApproved={false} />);
    expect(screen.getByText("Satu sebutan dihitung pada setiap label yang lolos ambang.")).toBeTruthy();
    expect(screen.getByText("Aturan hitung topik menunggu persetujuan.")).toBeTruthy();
    render(<DataStatusPanel lastSuccess="2026-11-01T00:00:00.000Z" pending={1} failed={1} sourceState="Siap" />);
    expect(screen.getByText("Nilai keyakinan adalah ketidakpastian model, bukan jaminan kebenaran.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/components/results.test.tsx`

Expected: FAIL. Cannot resolve `./results`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/components/results.tsx`:

```tsx
"use client";

const SENTIMENT_TEXT = { positive: "Positif", neutral: "Netral", negative: "Negatif" } as const;

export function withFilters(path: string, filters: { from?: string; to?: string; source?: string }): string {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.source) params.set("source", filters.source);
  const query = params.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

export function OverviewPanel(props: {
  score: { kind: "empty" } | { kind: "score"; value: number; included: number };
  included: number;
  formulaApproved: boolean;
  from: string;
  to: string;
}) {
  return (
    <section>
      <h2>Skor sentimen</h2>
      {props.from === "" || props.to === "" ? <p>Pilih rentang tanggal.</p> : null}
      {props.score.kind === "empty" ? (
        <p>Belum ada sebutan yang dinilai</p>
      ) : (
        <>
          <p>{props.score.value}</p>
          <p>{props.score.included} sebutan dihitung</p>
          <p>
            Skor = 100 × (positif − negatif) / semua sebutan yang dihitung. Rentangnya −100 sampai +100. Ini bukan keyakinan Jev.
          </p>
          {props.formulaApproved ? null : <p>Rumus ini menunggu persetujuan.</p>}
        </>
      )}
    </section>
  );
}

export function TrendPanel(props: {
  timeZone: string | null;
  bucket: "day" | "week" | null;
  rows: { createdAt: string; sentiment: "positive" | "neutral" | "negative" }[];
  buckets: { bucketStart: string; positive: number; neutral: number; negative: number }[];
}) {
  if (!props.timeZone || !props.bucket) {
    return (
      <section>
        <h2>Tren</h2>
        <p>Pilih zona waktu dan ukuran kelompok sebelum grafik ditampilkan.</p>
        <table>
          <tbody>
            {props.rows.map((row) => (
              <tr key={`${row.createdAt}-${row.sentiment}`}>
                <td>{row.createdAt}</td>
                <td>{SENTIMENT_TEXT[row.sentiment]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  }
  return (
    <section>
      <h2>Tren</h2>
      <table>
        <tbody>
          {props.buckets.map((bucket) => (
            <tr key={bucket.bucketStart}>
              <td>{bucket.bucketStart}</td>
              <td>{bucket.positive}</td>
              <td>{bucket.neutral}</td>
              <td>{bucket.negative}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function TopicPanel(props: { counts: { label: string; count: number }[]; countingApproved: boolean }) {
  return (
    <section>
      <h2>Topik teratas</h2>
      <p>Satu sebutan dihitung pada setiap label yang lolos ambang.</p>
      {props.countingApproved ? null : <p>Aturan hitung topik menunggu persetujuan.</p>}
      <ul>
        {props.counts.map((count) => (
          <li key={count.label}>
            {count.label} {count.count}
          </li>
        ))}
      </ul>
    </section>
  );
}

type MentionRow = {
  id: string;
  excerpt: string;
  source: "x" | "threads";
  url: string;
  postedAt: string;
  relevance: "relevant" | "irrelevant" | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  topics: string[];
  confidence: number | null;
  displaySource: "failed" | "owner_confirm" | "owner_correct" | "jev";
  scoringStatus: "pending" | "scoring" | "succeeded" | "failed";
  sourcePostUnavailable: boolean;
};

function mentionStatus(row: MentionRow): string {
  if (row.sourcePostUnavailable) return "Postingan tidak lagi tersedia";
  if (row.displaySource === "failed" || row.scoringStatus === "failed") return "Penilaian gagal";
  if (row.scoringStatus === "pending" || row.scoringStatus === "scoring") return "Penilaian tertunda";
  if (row.displaySource === "owner_confirm" || row.displaySource === "owner_correct") return "Koreksi pemilik";
  return "Hasil Jev";
}

export function MentionFeed(props: { mentions: MentionRow[] }) {
  return (
    <section>
      <h2>Sebutan</h2>
      <ul>
        {props.mentions.map((mention) => (
          <li key={mention.id}>
            <p>{mention.excerpt}</p>
            <p>{mention.source === "x" ? "X" : "Threads"}</p>
            <p>{mention.postedAt}</p>
            <p>{mentionStatus(mention)}</p>
            {mention.sentiment ? <p>{SENTIMENT_TEXT[mention.sentiment]}</p> : null}
            <p>{mention.topics.join(", ")}</p>
            <a href={mention.url}>Buka sumber</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DataStatusPanel(props: { lastSuccess: string; pending: number; failed: number; sourceState: string }) {
  return (
    <section>
      <h2>Status data</h2>
      <p>Pengumpulan terakhir berhasil {props.lastSuccess}</p>
      <p>Penilaian tertunda {props.pending}</p>
      <p>Penilaian gagal {props.failed}</p>
      <p>{props.sourceState}</p>
      <p>Nilai keyakinan adalah ketidakpastian model, bukan jaminan kebenaran.</p>
    </section>
  );
}
```

`DataStatusPanel` renders the pending and failed counts as part of a longer sentence, so the digits are visible with their labels. The empty-overview test does not render this panel.

Write `apps/web/src/app/dasbor/page.tsx`:

```tsx
import Link from "next/link";
import { DataStatusPanel, MentionFeed, OverviewPanel, TopicPanel, TrendPanel, withFilters } from "@/components/results";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; source?: string }>;
}) {
  const filters = await searchParams;
  const from = filters.from ?? "";
  const to = filters.to ?? "";
  const source = filters.source ?? "";
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4">
      <a href={withFilters("/dasbor/perlu-perhatian", { from, to, source })}>Perlu perhatian</a>
      <a href={withFilters("/dasbor/belum-yakin", { from, to, source })}>Belum yakin</a>
      <OverviewPanel score={{ kind: "empty" }} included={0} formulaApproved={false} from={from} to={to} />
      <TrendPanel timeZone={null} bucket={null} rows={[]} buckets={[]} />
      <TopicPanel counts={[]} countingApproved={false} />
      <MentionFeed mentions={[]} />
      <DataStatusPanel lastSuccess="" pending={0} failed={0} sourceState="Tidak tersedia" />
      <Link href="/onboarding">Ubah varian</Link>
    </main>
  );
}
```

The page has no reply form. Signed-in rows use these same components: map stored mentions through `displayOf` and pass the result to `MentionFeed`, and pass `overviewScore` to `OverviewPanel`. Do not add a second results layout.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/components/results.test.tsx`

Expected: PASS. 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/results.tsx apps/web/src/components/results.test.tsx apps/web/src/app/dasbor/page.tsx
git commit -m "feat: show sentiment results with explicit empty and error states"
```

- [ ] **Step 6: Write the failing Run now and heartbeat test**

Add the import lines at the top of `apps/web/src/components/results.test.tsx`. Place the new `it` block inside the existing `describe("results")` callback:

```tsx
import { fireEvent } from "@testing-library/react";
import { CollectionControls } from "./collection-controls";

it("shows worker offline and rate-limits Kumpulkan sekarang", () => {
  const onRunNow = vi.fn();
  const { rerender } = render(
    <CollectionControls
      lastSeenAt={null}
      now="2026-11-01T00:02:00.000Z"
      staleSeconds={90}
      manualBlocked={false}
      onRunNow={onRunNow}
    />,
  );
  expect(screen.getByText("Worker offline")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Kumpulkan sekarang" }));
  expect(onRunNow).toHaveBeenCalledTimes(1);
  rerender(
    <CollectionControls
      lastSeenAt="2026-11-01T00:01:00.000Z"
      now="2026-11-01T00:02:00.000Z"
      staleSeconds={90}
      manualBlocked={true}
      onRunNow={onRunNow}
    />,
  );
  expect(screen.getByText("Worker aktif")).toBeTruthy();
  expect(screen.getByText("Tunggu 15 menit sebelum mengumpulkan lagi.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Kumpulkan sekarang" }));
  expect(onRunNow).toHaveBeenCalledTimes(1);
});
```

Add `vi` to the vitest import in that file.

The fresh timestamp is 60 seconds before `now`, which is inside the 90 second stale window. A missing `lastSeenAt` is offline.

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/components/results.test.tsx`

Expected: FAIL. Cannot resolve `./collection-controls`. The four earlier tests still pass.

- [ ] **Step 8: Write the collection controls**

Write `apps/web/src/components/collection-controls.tsx`:

```tsx
"use client";

export function CollectionControls(props: {
  lastSeenAt: string | null;
  now: string;
  staleSeconds: number;
  manualBlocked: boolean;
  onRunNow: () => void;
}) {
  const stale =
    props.lastSeenAt === null ||
    new Date(props.now).getTime() - new Date(props.lastSeenAt).getTime() > props.staleSeconds * 1000;
  return (
    <section className="flex flex-col gap-2">
      <h2>Pengumpulan</h2>
      <p>{stale ? "Worker offline" : "Worker aktif"}</p>
      {props.manualBlocked ? <p>Tunggu 15 menit sebelum mengumpulkan lagi.</p> : null}
      <button
        type="button"
        disabled={props.manualBlocked}
        onClick={() => {
          if (props.manualBlocked) return;
          props.onRunNow();
        }}
      >
        Kumpulkan sekarang
      </button>
    </section>
  );
}
```

The button label stays `Kumpulkan sekarang` in both states. The `onClick` guard is what the test locks; `disabled` is additional.

Write `apps/web/src/app/dasbor/actions.ts`:

```ts
"use server";

import type { Queryable } from "@/db/migrate";
import { readLimits, requestManualRun } from "@/projects/schedules";

export async function runNowAction(
  db: Queryable,
  customerId: string,
  projectId: string,
): Promise<{ ok: true; jobId: string } | { ok: false; reason: "manual_rate_limited"; retryAt: string }> {
  return requestManualRun(db, customerId, projectId, new Date(), readLimits());
}
```

`runNowAction` inserts the due manual job and does not import an X or Threads client.

In `apps/web/src/app/dasbor/page.tsx`, render `CollectionControls` above `OverviewPanel`. Load the signed-in customer and the open project, then:

```tsx
import { collectionControlState, readLimits } from "@/projects/schedules";
import { runNowAction } from "./actions";

const limits = readLimits();
const state = await collectionControlState(db, customerId, new Date(), limits);
```

Pass `lastSeenAt={state.lastSeenAt}`, `now={new Date().toISOString()}`, `staleSeconds={limits.workerHeartbeatStaleSeconds}`, `manualBlocked={state.manualBlocked}`, and `onRunNow` that calls `runNowAction(db, customerId, projectId)`. `collectionControlState` is the heartbeat read and the manual-interval check. When no customer is signed in, omit the button's action and pass `lastSeenAt={null}`, `manualBlocked={false}`, and `onRunNow={() => undefined}`. Do not use that no-op once `customerId` and `projectId` exist.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/components/results.test.tsx`

Expected: PASS. 5 tests.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/collection-controls.tsx apps/web/src/components/results.test.tsx apps/web/src/app/dasbor/page.tsx apps/web/src/app/dasbor/actions.ts
git commit -m "feat: add collect now and the worker heartbeat status"
```

---

### Task 17: Build Needs attention and Not sure

**Files:**
- Create: `apps/web/src/components/review.tsx`
- Create: `apps/web/src/app/dasbor/perlu-perhatian/page.tsx`
- Create: `apps/web/src/app/dasbor/belum-yakin/page.tsx`
- Test: `apps/web/src/components/review.test.tsx`

**Interfaces:**
- Consumes: `AttentionItem`, `markSeen`, `suggestedLabels`
- Produces: `AttentionList` and `NotSureList`

**Acceptance criteria:**
- Covers AC-5 and AC-6.
- One eligible item renders one `Negatif` badge, the confidence, the source link, `Baru`, and a button `Tandai sudah dilihat`.
- The unread count's accessible name is `1 baru` for one unread item. A second copy of the same mention id is not rendered; the list receives already-deduped items and the test passes two items with the same `mentionId` only if the component itself drops the second. The component must drop a repeated `mentionId`.
- A failed mark renders `Status perhatian gagal diperbarui.` and the item still shows `Baru`.
- The page renders `Label dampak tinggi tidak ditampilkan sampai aturan dan metadata sumber disetujui.` and does not render `Dampak tinggi`.
- Not sure shows the uncertain field, the original label, the confidence, the source link, and the buttons `Relevan`, `Tidak relevan`, `Positif`, `Netral`, and `Negatif`. When the sentiment suggestion is null, there is no button named `Setujui label ini`.
- No button named `Balas` or `Kirim`.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/components/review.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AttentionList, NotSureList } from "./review";

describe("review", () => {
  it("shows one unread negative item and no high-impact badge", () => {
    render(
      <AttentionList
        items={[
          { id: "a", mentionId: "m1", reason: "negative", unread: true, confidence: 0.91, url: "https://x.com/ani/status/100", excerpt: "mahal" },
          { id: "b", mentionId: "m1", reason: "negative", unread: true, confidence: 0.91, url: "https://x.com/ani/status/100", excerpt: "mahal" },
        ]}
        markError={false}
      />,
    );
    expect(screen.getAllByText("Negatif")).toHaveLength(1);
    expect(screen.getByText("Baru")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tandai sudah dilihat" })).toBeTruthy();
    expect(screen.getByLabelText("1 baru")).toBeTruthy();
    expect(screen.getByText("Label dampak tinggi tidak ditampilkan sampai aturan dan metadata sumber disetujui.")).toBeTruthy();
    expect(screen.queryByText("Dampak tinggi")).toBeNull();
  });

  it("keeps the item unread when the update fails", () => {
    render(
      <AttentionList
        items={[{ id: "a", mentionId: "m1", reason: "negative", unread: true, confidence: 0.91, url: "https://x.com/ani/status/100", excerpt: "mahal" }]}
        markError
      />,
    );
    expect(screen.getByText("Status perhatian gagal diperbarui.")).toBeTruthy();
    expect(screen.getByText("Baru")).toBeTruthy();
  });

  it("requires an explicit sentiment choice when none is suggested", () => {
    render(
      <NotSureList
        item={{
          uncertain: "sentimen",
          originalLabel: "Negatif",
          confidence: 0.4,
          url: "https://www.threads.com/@ani/post/55",
          sentimentSuggested: null,
        }}
      />,
    );
    expect(screen.getByText("sentimen")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Positif" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Setujui label ini" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Balas" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/components/review.test.tsx`

Expected: FAIL. Cannot resolve `./review`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/components/review.tsx`:

```tsx
"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type AttentionRow = {
  id: string;
  mentionId: string;
  reason: "negative";
  unread: boolean;
  confidence: number;
  url: string;
  excerpt: string;
};

export function AttentionList(props: { items: AttentionRow[]; markError: boolean }) {
  const seen = new Set<string>();
  const items = props.items.filter((item) => {
    if (seen.has(item.mentionId)) return false;
    seen.add(item.mentionId);
    return true;
  });
  const unread = items.filter((item) => item.unread).length;
  return (
    <section>
      <h1>Perlu perhatian</h1>
      <span aria-label={`${unread} baru`}>{unread}</span>
      <p>Label dampak tinggi tidak ditampilkan sampai aturan dan metadata sumber disetujui.</p>
      {props.markError ? <p role="alert">Status perhatian gagal diperbarui.</p> : null}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <p>{item.excerpt}</p>
            <Badge>Negatif</Badge>
            <p>{item.confidence}</p>
            <a href={item.url}>Buka sumber</a>
            <p>{item.unread ? "Baru" : "Sudah dilihat"}</p>
            <Button type="button">Tandai sudah dilihat</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NotSureList(props: {
  item: {
    uncertain: string;
    originalLabel: string;
    confidence: number;
    url: string;
    sentimentSuggested: "positive" | "neutral" | "negative" | null;
  };
}) {
  return (
    <section>
      <h1>Belum yakin</h1>
      <p>{props.item.uncertain}</p>
      <p>{props.item.originalLabel}</p>
      <p>{props.item.confidence}</p>
      <a href={props.item.url}>Buka sumber</a>
      <Button type="button">Relevan</Button>
      <Button type="button">Tidak relevan</Button>
      <Button type="button">Positif</Button>
      <Button type="button">Netral</Button>
      <Button type="button">Negatif</Button>
      {props.item.sentimentSuggested ? <Button type="button">Setujui label ini</Button> : null}
    </section>
  );
}
```

The mark-seen button's server action calls `markSeen` from Task 6. When that function returns `{ ok: false }`, the page passes `markError` true and leaves `unread` true. The component above shows that state; it does not clear the word `Baru` by itself.

Write `apps/web/src/app/dasbor/perlu-perhatian/page.tsx`:

```tsx
"use client";

import { AppShell } from "@/components/app-shell";
import { AttentionList } from "@/components/review";

export default function NeedsAttentionPage() {
  return (
    <AppShell>
      <AttentionList items={[]} markError={false} />
    </AppShell>
  );
}
```

Write `apps/web/src/app/dasbor/belum-yakin/page.tsx`:

```tsx
"use client";

import { AppShell } from "@/components/app-shell";
import { NotSureList } from "@/components/review";

export default function NotSurePage() {
  return (
    <AppShell>
      <NotSureList
        item={{
          uncertain: "sentimen",
          originalLabel: "",
          confidence: 0,
          url: "",
          sentimentSuggested: null,
        }}
      />
    </AppShell>
  );
}
```

The empty URL on the placeholder page is replaced by the stored mention URL when the page loads a row. The test renders `NotSureList` directly with a real URL.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/components/review.test.tsx`

Expected: PASS. 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/review.tsx apps/web/src/components/review.test.tsx apps/web/src/app/dasbor
git commit -m "feat: add Needs attention and Not sure review"
```

---

### Task 18: Record analytics without post content or credentials

**Files:**
- Create: `apps/web/src/analytics/events.ts`
- Test: `apps/web/src/analytics/events.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `EVENT_NAMES` and `buildEvent(name: EventName, properties: Record<string, string | number | boolean>): { name: EventName; properties: Record<string, string | number | boolean> }`

`EVENT_NAMES` is exactly: `project_created`, `keyword_added`, `keyword_removed`, `source_connection_outcome`, `attention_eligible`, `attention_indicator_surfaced`, `attention_marked_seen`, `attention_state_update_failed`, `attention_deduped`, `mention_collected`, `mention_deduplicated`, `scoring_completed`, `scoring_failed`, `relevance_excluded`, `routed_not_sure`, `dashboard_viewed`, `source_link_opened`, `review_confirmed`, `review_corrected`, `needs_attention_viewed`.

`buildEvent` throws `forbidden_property` if any key is `excerpt`, `text`, `password`, `token`, `authorization`, `credential`, `apiKey`, or `bearer`.

**Acceptance criteria:**
- Covers the tracking plan's ban on copying post content or credentials into analytics events.
- A property named `excerpt` throws. A property set `{ projectId: "p1", source: "x" }` is returned unchanged.

- [ ] **Step 1: Write the failing test**

Write `apps/web/src/analytics/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEvent } from "./events";

describe("buildEvent", () => {
  it("keeps ids and rejects post text", () => {
    expect(buildEvent("mention_collected", { projectId: "p1", source: "x" })).toEqual({
      name: "mention_collected",
      properties: { projectId: "p1", source: "x" },
    });
    expect(() => buildEvent("mention_collected", { excerpt: "rahasia" })).toThrow("forbidden_property");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --prefix apps/web -- src/analytics/events.test.ts`

Expected: FAIL. Cannot resolve `./events`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/web/src/analytics/events.ts`:

```ts
export const EVENT_NAMES = [
  "project_created",
  "keyword_added",
  "keyword_removed",
  "source_connection_outcome",
  "attention_eligible",
  "attention_indicator_surfaced",
  "attention_marked_seen",
  "attention_state_update_failed",
  "attention_deduped",
  "mention_collected",
  "mention_deduplicated",
  "scoring_completed",
  "scoring_failed",
  "relevance_excluded",
  "routed_not_sure",
  "dashboard_viewed",
  "source_link_opened",
  "review_confirmed",
  "review_corrected",
  "needs_attention_viewed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const FORBIDDEN_KEYS = new Set([
  "excerpt",
  "text",
  "password",
  "token",
  "authorization",
  "credential",
  "apiKey",
  "bearer",
]);

export function buildEvent(
  name: EventName,
  properties: Record<string, string | number | boolean>,
): { name: EventName; properties: Record<string, string | number | boolean> } {
  for (const key of Object.keys(properties)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error("forbidden_property");
  }
  return { name, properties };
}
```

Call `buildEvent` at the handler that already performed the matching write: `createProject` emits `project_created`, `saveActiveVariants` emits `keyword_added` or `keyword_removed`, `ingestMention` emits `mention_collected` or `mention_deduplicated`, `recordSuccess` emits `scoring_completed`, `recordFailure` emits `scoring_failed`, an excluded route emits `relevance_excluded`, a `not_sure` route emits `routed_not_sure`, and `markSeen` emits `attention_marked_seen` or `attention_state_update_failed`. Properties may include `projectId`, `source`, `model`, and `ruleVersion`. They must not include the post excerpt or a credential.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --prefix apps/web -- src/analytics/events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/analytics apps/web/src/projects apps/web/src/ingest apps/web/src/scoring apps/web/src/components
git commit -m "feat: record analytics events without post content"
```

---

### Task 19: Gate launch on a user-set Indonesian evaluation

**Files:**
- Create: `eval/format-sample.jsonl`
- Create: `eval/gate.py`
- Create: `config/eval-criteria.json`
- Test: `eval/test_gate.py`

**Interfaces:**
- Consumes: nothing from the app runtime
- Produces: `evaluate(labels_path: Path, predictions_path: Path, criteria_path: Path) -> int`

Exit `2` when criteria `approved` is false, any threshold is null, `includes_informal_indonesian` is false, or any label row has `launch_set` other than true. Exit `1` when a computed rate misses a user threshold. Exit `0` when every check passes. Computed values:

- relevance error rate: fraction of rows where `labels.relevant` differs from `predictions.relevant`. Both values are booleans already decided outside this gate. This gate does not call Jev and does not apply a numeric cutoff of its own.
- sentiment error rate: among rows with `relevant: true`, fraction whose sentiment differs. Rows with `sentiment: null` in the label are skipped.
- topic exact agreement: among relevant rows, fraction whose topic-id set equals the prediction set.
- uncertain routing recall: among rows with `human_uncertain: true`, fraction whose `routing_bucket` is `not_sure`.

The committed criteria file is:

```json
{
  "approved": false,
  "includes_informal_indonesian": false,
  "relevance_max_error_rate": null,
  "sentiment_max_error_rate": null,
  "topic_min_exact_agreement": null,
  "uncertain_routing_min_recall": null
}
```

The committed `eval/format-sample.jsonl` has `launch_set: false` on every row. It is a format example, not a launch set and not an accuracy result. Rows:

```json
{"id":"fmt-1","text":"geprek gembus enak","relevant":true,"sentiment":"positive","topics":["rasa"],"human_uncertain":false,"informal":true,"launch_set":false}
{"id":"fmt-2","text":"tempe gembus untuk besok","relevant":false,"sentiment":null,"topics":[],"human_uncertain":false,"informal":true,"launch_set":false}
```

**Acceptance criteria:**
- Covers AC-2's "error rates must be agreed before launch" and AC-8.
- Pointing the gate at the committed criteria file returns 2.
- A temporary criteria file created inside the test, with thresholds the test itself writes, returns 0 for matching predictions and 1 for a mismatch. Those numbers exist only in the test.

- [ ] **Step 1: Write the failing test**

Write `eval/test_gate.py`:

```python
import json
from pathlib import Path

from gate import evaluate

ROOT = Path(__file__).resolve().parents[1]


def test_committed_criteria_block_launch():
    sample = Path(__file__).parent / "format-sample.jsonl"
    assert evaluate(sample, sample, ROOT / "config" / "eval-criteria.json") == 2


def test_user_thresholds_are_applied(tmp_path):
    labels = tmp_path / "labels.jsonl"
    predictions = tmp_path / "predictions.jsonl"
    criteria = tmp_path / "criteria.json"
    labels.write_text(
        json.dumps(
            {
                "id": "1",
                "relevant": True,
                "sentiment": "positive",
                "topics": ["harga"],
                "human_uncertain": False,
                "informal": True,
                "launch_set": True,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    predictions.write_text(
        json.dumps(
            {
                "id": "1",
                "relevant": True,
                "sentiment": "positive",
                "topics": ["harga"],
                "routing_bucket": "included",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    criteria.write_text(
        json.dumps(
            {
                "approved": True,
                "includes_informal_indonesian": True,
                "relevance_max_error_rate": 0,
                "sentiment_max_error_rate": 0,
                "topic_min_exact_agreement": 1,
                "uncertain_routing_min_recall": 1,
            }
        ),
        encoding="utf-8",
    )
    assert evaluate(labels, predictions, criteria) == 0
    predictions.write_text(
        json.dumps(
            {
                "id": "1",
                "relevant": False,
                "sentiment": "negative",
                "topics": [],
                "routing_bucket": "excluded",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    assert evaluate(labels, predictions, criteria) == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `apps/worker/.venv/bin/pytest eval/test_gate.py -v`

Expected: FAIL. `gate` cannot be imported. Set `PYTHONPATH=eval` if the import needs it:

```bash
PYTHONPATH=eval apps/worker/.venv/bin/pytest eval/test_gate.py -v
```

- [ ] **Step 3: Write the minimal implementation**

Write `eval/format-sample.jsonl` with the two JSON rows in the interface block, one row per line. Write `config/eval-criteria.json` with the JSON object in the interface block.

Write `eval/gate.py`:

```python
import json
import sys
from pathlib import Path


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def evaluate(labels_path: Path, predictions_path: Path, criteria_path: Path) -> int:
    criteria = json.loads(criteria_path.read_text(encoding="utf-8"))
    thresholds = (
        criteria.get("relevance_max_error_rate"),
        criteria.get("sentiment_max_error_rate"),
        criteria.get("topic_min_exact_agreement"),
        criteria.get("uncertain_routing_min_recall"),
    )
    if criteria.get("approved") is not True or criteria.get("includes_informal_indonesian") is not True:
        return 2
    if any(value is None for value in thresholds):
        return 2
    labels = _rows(labels_path)
    if any(row.get("launch_set") is not True for row in labels):
        return 2
    predictions = {row["id"]: row for row in _rows(predictions_path)}
    relevance_compared = relevance_errors = 0
    sentiment_compared = sentiment_errors = 0
    topic_compared = topic_matches = 0
    uncertain_total = uncertain_hits = 0
    for label in labels:
        prediction = predictions[label["id"]]
        relevance_compared += 1
        if bool(label["relevant"]) != bool(prediction["relevant"]):
            relevance_errors += 1
        if label["relevant"] and label.get("sentiment") is not None:
            sentiment_compared += 1
            topic_compared += 1
            if label["sentiment"] != prediction.get("sentiment"):
                sentiment_errors += 1
            if set(label.get("topics") or []) == set(prediction.get("topics") or []):
                topic_matches += 1
        if label.get("human_uncertain") is True:
            uncertain_total += 1
            if prediction.get("routing_bucket") == "not_sure":
                uncertain_hits += 1
    relevance_rate = relevance_errors / relevance_compared if relevance_compared else 0
    sentiment_rate = sentiment_errors / sentiment_compared if sentiment_compared else 0
    topic_agreement = topic_matches / topic_compared if topic_compared else 1
    uncertain_recall = uncertain_hits / uncertain_total if uncertain_total else 1
    if (
        relevance_rate <= criteria["relevance_max_error_rate"]
        and sentiment_rate <= criteria["sentiment_max_error_rate"]
        and topic_agreement >= criteria["topic_min_exact_agreement"]
        and uncertain_recall >= criteria["uncertain_routing_min_recall"]
    ):
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(evaluate(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])))
```

This file does not read an API key and does not open a socket.

- [ ] **Step 4: Run the test to verify it passes**

Run: `PYTHONPATH=eval apps/worker/.venv/bin/pytest eval/test_gate.py -v`

Expected: PASS. 2 tests.

- [ ] **Step 5: Commit**

```bash
git add eval config/eval-criteria.json
git commit -m "feat: block launch until the user sets Indonesian eval thresholds"
```

---

### Task 20: Gate launch on Threads, X, and monitor-only checks

**Files:**
- Create: `config/launch-approvals.json`
- Create: `eval/launch_gate.py`
- Create: `eval/test_launch_gate.py`
- Create: `eval/test_monitor_only.py`

**Interfaces:**
- Consumes: the approval JSON shape from the Approval file section
- Produces: `launch_allowed(flags: dict) -> bool` and `scan_forbidden(root: Path) -> list[str]`

`launch_allowed` is true only when `high_impact` is false and every other boolean flag is true, with one source exception:

- Two-source launch: `threads_public_search_demonstrated` is true, `x_cost_understood` is true, and `reduced_source_launch` is null.
- X-only launch: `reduced_source_launch` is `"x_only_approved"`, `x_cost_understood` is true, and `threads_public_search_demonstrated` may be false.

Any other `reduced_source_launch` value is false. `scan_forbidden` walks `apps` and `eval`, skips files named `test_monitor_only.py`, and returns paths that contain any of: `api.telegram.org`, `hooks.slack.com`, `nodemailer`, `whatsapp`, `harken.web`, `LexiconSentiment`, `harken.pipeline`, `harken.alerts`, `/me/threads`, `chat/completions`.

**Acceptance criteria:**
- Covers AC-7 and AC-9.
- The committed approval file makes `launch_allowed` false.
- A flags object with every boolean true, `high_impact` false, `reduced_source_launch` null, and both source flags true is allowed.
- The same object with `threads_public_search_demonstrated` false is rejected.
- That object with `reduced_source_launch` set to `"x_only_approved"` and Threads false is allowed.
- `scan_forbidden` returns an empty list for this repository after the tasks above.

- [ ] **Step 1: Write the failing test and the approval file**

Write `config/launch-approvals.json` with the JSON in the Approval file section.

Write `eval/test_launch_gate.py`:

```python
import json
from pathlib import Path

from launch_gate import launch_allowed

ROOT = Path(__file__).resolve().parents[1]


def flags(**overrides):
    base = {
        "stack_reviewed": True,
        "credential_policy": True,
        "scoring_policy": True,
        "topic_labels": True,
        "topic_counting": True,
        "overview_formula": True,
        "jev_fallback_rule": True,
        "eval_criteria": True,
        "threads_public_search_demonstrated": True,
        "x_cost_understood": True,
        "reduced_source_launch": None,
        "high_impact": False,
    }
    base.update(overrides)
    return base


def test_committed_file_blocks():
    committed = json.loads((ROOT / "config" / "launch-approvals.json").read_text(encoding="utf-8"))
    assert launch_allowed(committed) is False


def test_two_source_and_explicit_x_only():
    assert launch_allowed(flags()) is True
    assert launch_allowed(flags(threads_public_search_demonstrated=False)) is False
    assert launch_allowed(flags(threads_public_search_demonstrated=False, reduced_source_launch="x_only_approved")) is True
```

Write `eval/test_monitor_only.py`:

```python
from pathlib import Path

from launch_gate import scan_forbidden

ROOT = Path(__file__).resolve().parents[1]


def test_product_tree_has_no_reply_or_external_delivery():
    assert scan_forbidden(ROOT) == []
    app = ROOT / "apps" / "web" / "src" / "app"
    names = [path.name for path in app.rglob("*")]
    assert "reply" not in names
    assert not any("reply" in name for name in names)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PYTHONPATH=eval apps/worker/.venv/bin/pytest eval/test_launch_gate.py eval/test_monitor_only.py -v`

Expected: FAIL. `launch_gate` cannot be imported.

- [ ] **Step 3: Write the minimal implementation**

Write `eval/launch_gate.py`:

```python
import json
from pathlib import Path

REQUIRED_TRUE = (
    "stack_reviewed",
    "credential_policy",
    "scoring_policy",
    "topic_labels",
    "topic_counting",
    "overview_formula",
    "jev_fallback_rule",
    "eval_criteria",
    "x_cost_understood",
)

NEEDLES = (
    "api.telegram.org",
    "hooks.slack.com",
    "nodemailer",
    "whatsapp",
    "harken.web",
    "LexiconSentiment",
    "harken.pipeline",
    "harken.alerts",
    "/me/threads",
    "chat/completions",
)

SKIP_NAMES = {"launch_gate.py", "test_launch_gate.py", "test_monitor_only.py"}


def launch_allowed(flags: dict) -> bool:
    if flags.get("high_impact") is not False:
        return False
    if any(flags.get(name) is not True for name in REQUIRED_TRUE):
        return False
    reduced = flags.get("reduced_source_launch")
    threads = flags.get("threads_public_search_demonstrated") is True
    if reduced is None:
        return threads
    return reduced == "x_only_approved"


def scan_forbidden(root: Path) -> list[str]:
    hits: list[str] = []
    for folder in ("apps", "eval"):
        base = root / folder
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx", ".sql"}:
                continue
            if not path.is_file() or path.name in SKIP_NAMES:
                continue
            if "node_modules" in path.parts or ".venv" in path.parts:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if any(needle in text for needle in NEEDLES):
                hits.append(str(path))
    return hits


def main() -> int:
    flags = json.loads(Path("config/launch-approvals.json").read_text(encoding="utf-8"))
    if launch_allowed(flags):
        print("allowed")
        return 0
    print("blocked")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
```

Do not change `config/launch-approvals.json` to true in this task. The scanner skips its own file so the needle list is not reported as product code.

- [ ] **Step 4: Run the test to verify it passes**

Run: `PYTHONPATH=eval apps/worker/.venv/bin/pytest eval/test_launch_gate.py eval/test_monitor_only.py -v`

Expected: PASS.

Also run the whole local suite:

```bash
npm test --prefix apps/web
apps/worker/.venv/bin/pytest apps/worker/tests -v
PYTHONPATH=eval apps/worker/.venv/bin/pytest eval -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/launch-approvals.json eval/launch_gate.py eval/test_launch_gate.py eval/test_monitor_only.py
git commit -m "feat: block launch until source access and monitor-only checks pass"
```

---

### Task 21: Document how to run the repo

**Files:**
- Modify: `README.md`
- Create: `.env.example`

**Interfaces:**
- Consumes: the commands and env var names from the earlier tasks
- Produces: a README that replaces the seeded file

**Acceptance criteria:**
- A new engineer can find the proposed repo name, the stack recommendation and its review gate, the dev port `43123`, and the test commands.
- The README lists env var names, points at `.env.example`, and states that values are not committed. It does not contain a token or a connection string with a password. The repository contains `.env.example` and no `.env` file.
- It states that Harken is MIT, pinned to commit `d0710a427dbbe712594ef3a6c25112e1d14cc027`, and that `harken serve` is not part of this app.

- [ ] **Step 1: Write the README**

Replace `README.md` with this file:

````markdown
# sentiment-monitor

Monitor-only dashboard for Indonesian SME brand mentions on X and Threads. The product stores candidates, Jev scores, and owner corrections. It does not draft replies, post, or send external alerts.

The web stack and the Harken worker split in `docs/superpowers/plans/2026-11-01-sentiment-monitor-mvp.md` are a recommendation. Do not start the tasks until the CTO and the user accept that recommendation or replace the file paths.

## Web

```bash
npm install --prefix apps/web
npm run dev --prefix apps/web
```

Open `http://127.0.0.1:43123`.

## Worker

```bash
python3 -m venv apps/worker/.venv
apps/worker/.venv/bin/pip install -e "apps/worker[dev]"
apps/worker/.venv/bin/python -m sentiment_monitor.scheduler
```

The Railway worker runs that module and stays up. `python -m sentiment_monitor.collect_once` only runs the approval gate and exits. Until `config/credential-policy.json` and `config/x-budget.json` are approved, the gate returns 2 and the scheduler does not call X or Threads. It still writes `worker_heartbeat`.

## Tests

```bash
npm test --prefix apps/web
apps/worker/.venv/bin/pytest apps/worker/tests -v
PYTHONPATH=eval apps/worker/.venv/bin/pytest eval -v
```

## Runtime configuration

Copy `.env.example` for local names. Do not commit a `.env` file. Production values are Railway service variables. Secret values are never printed. `format_log` replaces them with `[redacted]`.

Names: `DATABASE_URL`, `WORKER_DATABASE_URL`, `X_BEARER_TOKEN`, `THREADS_ACCESS_TOKEN`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `BACKUP_DESTINATION`, `X_MONTHLY_GLOBAL_POST_READS`, `X_MONTHLY_PER_CUSTOMER_POST_READS`, `THREADS_ROLLING_24H_RESERVE`, `SCHEDULE_MIN_INTERVAL_HOURS`, `MANUAL_MIN_INTERVAL_SECONDS`, `MAX_JOBS_PER_TICK`, `WORKER_POLL_SECONDS`, `WORKER_HEARTBEAT_STALE_SECONDS`.

## Harken

Collection imports Harken at commit `d0710a427dbbe712594ef3a6c25112e1d14cc027`, which is MIT licensed. Keep that notice in the installed package. Do not delete Harken's LICENSE file or its copyright line. This app does not fork Harken, does not run `harken serve`, and does not use Harken's dashboard, instance accounts, lexicon sentiment, or alert transports. Cursors are rows in Postgres.

## Launch

`python eval/launch_gate.py` prints `blocked` until the user sets the flags in `config/launch-approvals.json`. The evaluation thresholds live in `config/eval-criteria.json` and start unapproved. This repository does not choose those numbers.
````

When saving `README.md`, keep the inner command blocks and omit the four-backtick wrapper.

Write `.env.example` with these lines and no other values:

```
DATABASE_URL=
WORKER_DATABASE_URL=
X_BEARER_TOKEN=
THREADS_ACCESS_TOKEN=
TYPESAFE_API_KEY=
OPENROUTER_API_KEY=
BACKUP_DESTINATION=
X_MONTHLY_GLOBAL_POST_READS=20000
X_MONTHLY_PER_CUSTOMER_POST_READS=2000
THREADS_ROLLING_24H_RESERVE=1500
SCHEDULE_MIN_INTERVAL_HOURS=6
MANUAL_MIN_INTERVAL_SECONDS=900
MAX_JOBS_PER_TICK=5
WORKER_POLL_SECONDS=20
WORKER_HEARTBEAT_STALE_SECONDS=90
```

Do not create `.env`.

- [ ] **Step 2: Check the README and example file do not contain a secret**

Run: `rg -n "sk-|Bearer [A-Za-z0-9]|postgres://.+:.+@" README.md .env.example`

Expected: no matches.

Run: `test ! -f .env`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: explain how to run the sentiment monitor"
```

---

### Task 22: Run the scheduler and store Harken cursors in Postgres

**Files:**
- Create: `apps/worker/sentiment_monitor/scheduler.py`
- Create: `apps/worker/sentiment_monitor/pg_store.py`
- Create: `apps/worker/sentiment_monitor/backup.py`
- Create: `apps/worker/railway.toml`
- Create: `apps/web/railway.toml`
- Create: `deploy/postgres-service.txt`
- Modify: `apps/worker/pyproject.toml`
- Modify: `apps/worker/sentiment_monitor/collect.py`
- Test: `apps/worker/tests/test_scheduler.py`
- Test: `apps/worker/tests/test_pg_store.py`

**Interfaces:**
- Consumes: `query_key` from Task 11, `gate` from Task 12, `load_limits` and `Limits` from Task 12, `admit_x_read` and `run_threads` from Task 12, `project_schedules`, `jobs`, `source_cursors`, `worker_heartbeat`, and `keyword_variants` from Tasks 7 and 8. `commit_cursor` stays the Task 11 protocol helper. This task does not call it. `write_mentions_and_cursor` is the only path that commits a cursor.
- Produces:
  - `CLAIM_SQL`, `claim_due_jobs(conn, worker_id: str, limit: int) -> list`
  - `enqueue_due_sql() -> str`, `heartbeat_sql() -> str`, `record_heartbeat(conn, worker_id: str) -> None`
  - `heartbeat_is_stale(last_seen: datetime | None, now: datetime, stale_seconds: int) -> bool`
  - `decide_job(gate_code: int) -> tuple[str, str] | None`
  - `format_log(message: str) -> str`
  - `PostgresStore.write_mentions_and_cursor(...)` and `PostgresStore.record_source_success(...)`
  - `describe_backup(destination: str) -> dict`
  - `fetch_x_with_cursor(query, bearer_token, *, cursor, since, limit) -> tuple[list, str | None]`
  - `serve(connect, sleep, limits, worker_id: str, root: Path, fetch_x, fetch_threads) -> None`

Harken's package is the git pin from Task 9. This task adds `psycopg[binary]>=3.2` to `apps/worker/pyproject.toml` dependencies and does not change the Harken URL or commit. `PostgresStore` implements `source_state`, `record_source_error`, and `record_source_success` with the same parameter names as `harken.store.Store`. It does not subclass that class and it does not import it.

**Acceptance criteria:**
- The worker Railway file sets `numReplicas = 1`, starts `python -m sentiment_monitor.scheduler`, and has no `cronSchedule`.
- `deploy/postgres-service.txt` pins `postgres:16.15` and `asia-southeast1-eqsg3a`.
- `claim_due_jobs` runs `for update skip locked` and returns at most `max_jobs_per_tick` rows (default 5). A second claim does not receive a row the first claim locked. With 6 queued jobs, the first claim returns 5 and the second returns the one unlocked job.
- One `serve` pass writes `worker_heartbeat`, claims a due manual job, reads `keyword_variants` and the stored cursor, passes that cursor to the fetch, and commits the next cursor after the mention insert. `sleep` receives `worker_poll_seconds`. An unapproved gate defers the job and does not call the fetch.
- `fetch_x_with_cursor` returns Harken's `FetchPage.next_cursor` with the candidates. `fetch_x_page` still returns only the candidate list.
- Due schedules are inserted from `project_schedules.next_run_at`. The enqueue SQL has no cron expression.
- A cursor row is written only after the mention insert, in the same transaction. A failed mention insert rolls back and does not commit.
- `describe_backup("")` is `built: false` and `status: not_built`. The scheduler does not call `pg_dump`.
- `format_log` replaces Railway secret values with `[redacted]`.
- No worker module imports `harken.store` or `sqlite3`.

- [ ] **Step 1: Write the failing tests**

Add `psycopg[binary]>=3.2` to the `dependencies` list in `apps/worker/pyproject.toml`, then reinstall from `apps/worker` with `.venv/bin/pip install -e ".[dev]"`.

Write `apps/worker/tests/test_scheduler.py`:

```python
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from sentiment_monitor.backup import describe_backup
from sentiment_monitor.limits import load_limits
from sentiment_monitor.scheduler import (
    claim_due_jobs,
    decide_job,
    enqueue_due_sql,
    format_log,
    heartbeat_is_stale,
    heartbeat_sql,
    serve,
)


class JobLock:
    def __init__(self, queued: int):
        self.jobs = [{"id": f"j{i}", "status": "queued"} for i in range(queued)]
        self.locked = set()

    def connect(self):
        return _ClaimConn(self)


class _ClaimConn:
    def __init__(self, db):
        self.db = db
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        if "for update skip locked" not in sql.lower():
            return []
        limit = params[0]
        rows = []
        for job in self.db.jobs:
            if len(rows) >= limit:
                break
            if job["status"] == "queued" and job["id"] not in self.db.locked:
                self.db.locked.add(job["id"])
                rows.append(job)
        return rows


def test_worker_railway_file_is_one_replica_without_cron():
    text = Path("apps/worker/railway.toml").read_text(encoding="utf-8")
    assert "numReplicas = 1" in text
    assert "python -m sentiment_monitor.scheduler" in text
    assert "cronSchedule" not in text
    web = Path("apps/web/railway.toml").read_text(encoding="utf-8")
    assert "cronSchedule" not in web
    postgres = Path("deploy/postgres-service.txt").read_text(encoding="utf-8")
    assert "image=postgres:16.15" in postgres
    assert "region=asia-southeast1-eqsg3a" in postgres


def test_claim_uses_skip_locked_and_stops_at_five():
    limits = load_limits(Path("config/limits.json"), {})
    assert limits.max_jobs_per_tick == 5
    db = JobLock(queued=6)
    first_conn = db.connect()
    first = claim_due_jobs(first_conn, "worker-1", limits.max_jobs_per_tick)
    assert len(first) == 5
    assert "for update skip locked" in first_conn.statements[0].lower()
    second = claim_due_jobs(db.connect(), "worker-2", limits.max_jobs_per_tick)
    assert [job["id"] for job in second] == ["j5"]
    assert {job["id"] for job in second}.isdisjoint({job["id"] for job in first})


def test_enqueue_reads_stored_schedules():
    sql = enqueue_due_sql().lower()
    assert "project_schedules" in sql
    assert "next_run_at" in sql
    assert "cron" not in sql


def test_heartbeat_row_and_stale_rule():
    assert "worker_heartbeat" in heartbeat_sql()
    assert "on conflict (id)" in heartbeat_sql().lower()
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert heartbeat_is_stale(None, now, 90) is True
    assert heartbeat_is_stale(now - timedelta(seconds=60), now, 90) is False
    assert heartbeat_is_stale(now - timedelta(seconds=91), now, 90) is True


def test_poll_outside_15_to_30_is_rejected():
    assert load_limits(Path("config/limits.json"), {}).worker_poll_seconds == 20
    with pytest.raises(ValueError):
        load_limits(Path("config/limits.json"), {"WORKER_POLL_SECONDS": "5"})


def test_unapproved_gate_defers_the_job():
    assert decide_job(2) == ("deferred", "credential_unapproved")
    assert decide_job(0) is None


def test_backup_is_not_built():
    assert describe_backup("") == {
        "built": False,
        "status": "not_built",
        "cadence": "nightly",
        "destination": "",
        "command": ["pg_dump", "--format=custom", "--no-owner", "--dbname", "$DATABASE_URL"],
    }
    assert describe_backup("memory://later")["built"] is False
    backup_source = Path("apps/worker/sentiment_monitor/backup.py").read_text(encoding="utf-8")
    scheduler_source = Path("apps/worker/sentiment_monitor/scheduler.py").read_text(encoding="utf-8")
    assert "subprocess" not in backup_source
    assert "pg_dump" not in scheduler_source


def test_format_log_redacts_secrets(monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "super-secret-token")
    monkeypatch.setenv("DATABASE_URL", "postgres://app_user:secret-pass@postgres.railway.internal:5432/db")
    line = format_log(
        "failed super-secret-token postgres://app_user:secret-pass@postgres.railway.internal:5432/db"
    )
    assert "super-secret-token" not in line
    assert "secret-pass" not in line
    assert "[redacted]" in line


def test_harken_pin_is_unchanged_and_sqlite_is_not_imported():
    pyproject = Path("apps/worker/pyproject.toml").read_text(encoding="utf-8")
    assert "d0710a427dbbe712594ef3a6c25112e1d14cc027" in pyproject
    assert "github.com/VladUZH/harken.git" in pyproject
    source = "\n".join(
        path.read_text(encoding="utf-8")
        for path in Path("apps/worker/sentiment_monitor").rglob("*.py")
    )
    assert "harken.store" not in source
    assert "sqlite3" not in source
    assert "harken.db" not in source


class LoopWorld:
    def __init__(self, jobs, variants, cursor):
        self.jobs = jobs
        self.variants = variants
        self.cursor = cursor
        self.calls = []

    def connect(self):
        return _LoopConn(self)


class _LoopConn:
    def __init__(self, world):
        self.world = world

    def execute(self, sql, params=None):
        self.world.calls.append((sql, params))
        lowered = " ".join(sql.lower().split())
        if "for update skip locked" in lowered:
            rows = []
            for job in self.world.jobs:
                if job.get("status") != "queued":
                    continue
                job["status"] = "claimed"
                rows.append(dict(job))
                if params and len(rows) >= params[0]:
                    break
            return rows
        if "from keyword_variants" in lowered:
            return [{"text": text} for text in self.world.variants]
        if "from source_cursors" in lowered and lowered.startswith("select"):
            return {"incremental_cursor": self.world.cursor}
        if "from x_read_counters" in lowered and "for update" in lowered:
            return 0
        if "from threads_query_log" in lowered and "count" in lowered:
            return 0
        return None

    def commit(self):
        self.world.calls.append(("COMMIT", None))

    def rollback(self):
        self.world.calls.append(("ROLLBACK", None))

    def close(self):
        return None


def _policy_root(tmp_path, approved):
    config = tmp_path / "config"
    config.mkdir()
    flag = "true" if approved else "false"
    (config / "credential-policy.json").write_text(
        '{"approved": %s, "mode": "shared_operator"}' % flag, encoding="utf-8"
    )
    (config / "x-budget.json").write_text('{"approved": %s}' % flag, encoding="utf-8")
    return tmp_path


def _due_job():
    return {
        "id": "job-1",
        "customer_id": "customer-a",
        "project_id": "project-1",
        "kind": "manual",
        "status": "queued",
    }


def test_one_pass_reads_the_cursor_and_commits_it_with_the_mentions(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor="cursor-1")
    seen = {}

    def fetch_x(variant, limit, cursor):
        seen["x"] = (variant, limit, cursor)
        return (
            [{
                "external_id": "100",
                "excerpt": "geprek gembus",
                "url": "https://x.com/i/status/100",
                "author": "ani",
                "posted_at": "2026-11-01T00:00:00+00:00",
                "variant": variant,
            }],
            "cursor-2",
        )

    def fetch_threads(variant):
        seen["threads"] = variant
        return ([], None)

    def stop(seconds):
        seen["slept"] = seconds
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(world.connect, stop, limits, "worker-1", _policy_root(tmp_path, True), fetch_x, fetch_threads)

    assert seen["slept"] == 20
    assert seen["x"] == ("geprek gembus", 10, "cursor-1")
    assert seen["threads"] == "geprek gembus"
    sql_text = "\n".join(sql for sql, _params in world.calls)
    assert "worker_heartbeat" in sql_text
    assert "for update skip locked" in sql_text.lower()
    assert "from keyword_variants" in sql_text.lower()
    mention_at = next(i for i, (sql, _params) in enumerate(world.calls) if "insert into mentions" in sql)
    cursor_at = next(
        i for i, (sql, _params) in enumerate(world.calls) if i > mention_at and "insert into source_cursors" in sql
    )
    commit_at = next(i for i, (sql, _params) in enumerate(world.calls) if i > cursor_at and sql == "COMMIT")
    assert mention_at < cursor_at < commit_at
    assert world.calls[cursor_at][1][-1] == "cursor-2"
    grants = Path("apps/web/src/db/sql/002_schedules_jobs.sql").read_text(encoding="utf-8").lower()
    assert "grant select on keyword_variants to worker_role" in grants


def test_unapproved_pass_defers_without_calling_x_or_threads(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["geprek gembus"], cursor=None)
    calls = []

    def stop(seconds):
        calls.append(seconds)
        raise SystemExit

    limits = load_limits(Path("config/limits.json"), {})
    with pytest.raises(SystemExit):
        serve(
            world.connect,
            stop,
            limits,
            "worker-1",
            _policy_root(tmp_path, False),
            lambda *_args: calls.append("x"),
            lambda *_args: calls.append("threads"),
        )
    assert calls == [20]
    assert any(params and "credential_unapproved" in params for _sql, params in world.calls)
    assert not any("api.x.com" in sql or "graph.threads.com" in sql for sql, _params in world.calls)


def test_fetch_x_with_cursor_keeps_the_harken_cursor(monkeypatch):
    class Page:
        mentions = []
        next_cursor = "cursor-2"

    class Source:
        def __init__(self, bearer_token):
            self.bearer_token = bearer_token

        def fetch_page(self, query, limit=50, *, cursor=None, since=None):
            assert query == "geprek gembus"
            assert cursor == "cursor-1"
            assert limit == 10
            return Page()

    monkeypatch.setattr("sentiment_monitor.collect.XSource", Source)
    from sentiment_monitor.collect import fetch_x_page, fetch_x_with_cursor

    candidates, cursor = fetch_x_with_cursor(
        "geprek gembus", "token", cursor="cursor-1", since=None, limit=10
    )
    assert candidates == []
    assert cursor == "cursor-2"
    assert fetch_x_page("geprek gembus", "token", cursor="cursor-1", since=None, limit=10) == []
```

Write `apps/worker/tests/test_pg_store.py`:

```python
import pytest

from sentiment_monitor.pg_store import PostgresStore


class Tx:
    def __init__(self, fail_on=None):
        self.fail_on = fail_on
        self.statements = []
        self.committed = False
        self.rolled_back = False

    def execute(self, sql, params=None):
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError("insert failed")
        self.statements.append(sql)

    def commit(self):
        self.statements.append("COMMIT")
        self.committed = True

    def rollback(self):
        self.statements.append("ROLLBACK")
        self.rolled_back = True


MENTION = {
    "external_id": "100",
    "excerpt": "geprek gembus",
    "url": "https://x.com/ani/status/100",
    "author": "ani",
    "posted_at": "2026-11-01T00:00:00+00:00",
    "variant": "geprek gembus",
}


def test_cursor_advances_only_with_the_mention_commit():
    tx = Tx()
    PostgresStore(tx).write_mentions_and_cursor(
        customer_id="customer-a",
        project_id="project-1",
        query_key="customer-a:project-1:geprek gembus",
        source="x",
        mentions=[MENTION],
        next_cursor="cursor-2",
    )
    joined = "\n".join(tx.statements)
    assert joined.index("insert into mentions") < joined.index("source_cursors")
    assert joined.index("source_cursors") < joined.index("COMMIT")
    assert "set_config" in joined
    assert tx.committed is True
    assert tx.rolled_back is False


def test_failed_mention_insert_rolls_the_cursor_back():
    tx = Tx(fail_on="insert into mentions")
    with pytest.raises(RuntimeError):
        PostgresStore(tx).write_mentions_and_cursor(
            customer_id="customer-a",
            project_id="project-1",
            query_key="customer-a:project-1:geprek gembus",
            source="x",
            mentions=[MENTION],
            next_cursor="cursor-2",
        )
    assert tx.committed is False
    assert tx.rolled_back is True
    assert "COMMIT" not in tx.statements
    assert not any("source_cursors" in sql for sql in tx.statements)


def test_record_source_success_refuses_to_commit_on_its_own():
    tx = Tx()
    with pytest.raises(RuntimeError):
        PostgresStore(tx).record_source_success(
            "customer-a:project-1:geprek gembus",
            "x",
            [],
            mode="incremental",
            next_cursor="cursor-2",
        )
    assert tx.committed is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from the repository root:

```bash
apps/worker/.venv/bin/pytest apps/worker/tests/test_scheduler.py apps/worker/tests/test_pg_store.py -v
```

Expected: FAIL. `sentiment_monitor.scheduler` or `sentiment_monitor.pg_store` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Write `deploy/postgres-service.txt`:

```
image=postgres:16.15
region=asia-southeast1-eqsg3a
replicas=1
public=false
```

This is the Railway Postgres service. Create it from image `postgres:16.15`, not from an unpinned tag. Region `asia-southeast1-eqsg3a` is Singapore (`asia-southeast1`). One replica, private networking only, no cron schedule.

Write `apps/worker/railway.toml`:

```toml
[build]
builder = "RAILPACK"
watchPatterns = ["/apps/worker/**"]

[deploy]
startCommand = "python -m sentiment_monitor.scheduler"
numReplicas = 1
restartPolicyType = "ALWAYS"
```

Write `apps/web/railway.toml`:

```toml
[build]
builder = "RAILPACK"
watchPatterns = ["/apps/web/**"]

[deploy]
startCommand = "npm run start"
numReplicas = 1
restartPolicyType = "ON_FAILURE"
```

Neither file has a `cronSchedule` key. The worker service has no volume.

Write `apps/worker/sentiment_monitor/backup.py`:

```python
def describe_backup(destination: str) -> dict:
    return {
        "built": False,
        "status": "not_built",
        "cadence": "nightly",
        "destination": destination,
        "command": ["pg_dump", "--format=custom", "--no-owner", "--dbname", "$DATABASE_URL"],
    }
```

`describe_backup` records the nightly dump this plan intends and does not run it. `built` stays false for an empty destination and for any other destination. Do not import `subprocess`. Do not call this function from the scheduler. A follow-up may run the command only after the user sets `BACKUP_DESTINATION` to a real off-Railway target.

Write `apps/worker/sentiment_monitor/pg_store.py`:

```python
class PostgresStore:
    def __init__(self, conn):
        self._conn = conn
        self._open = False
        self._customer_id = None

    def source_state(self, query: str, source: str) -> dict:
        row = self._conn.execute(
            """
            select incremental_cursor, backfill_cursor, last_success_at, last_error
            from source_cursors
            where query_key = %s and source = %s
            """,
            (query, source),
        )
        return row or {}

    def record_source_error(self, query: str, source: str, error: str) -> None:
        if not self._open:
            raise RuntimeError("cursor_outside_mention_transaction")
        self._conn.execute(
            """
            insert into source_cursors (customer_id, query_key, source, last_error)
            values (%s, %s, %s, %s)
            on conflict (query_key, source) do update set last_error = excluded.last_error
            """,
            (self._customer_id, query, source, error),
        )

    def record_source_success(self, query, source, mentions, *, mode, next_cursor, incremental_since=None) -> None:
        del mentions, incremental_since
        if not self._open:
            raise RuntimeError("cursor_outside_mention_transaction")
        if mode == "backfill":
            sql = """
            insert into source_cursors (customer_id, query_key, source, backfill_cursor, last_success_at, last_error)
            values (%s, %s, %s, %s, now(), null)
            on conflict (query_key, source) do update
              set backfill_cursor = excluded.backfill_cursor,
                  last_success_at = excluded.last_success_at,
                  last_error = null
            """
        else:
            sql = """
            insert into source_cursors (customer_id, query_key, source, incremental_cursor, last_success_at, last_error)
            values (%s, %s, %s, %s, now(), null)
            on conflict (query_key, source) do update
              set incremental_cursor = excluded.incremental_cursor,
                  last_success_at = excluded.last_success_at,
                  last_error = null
            """
        self._conn.execute(sql, (self._customer_id, query, source, next_cursor))

    def write_mentions_and_cursor(self, *, customer_id, project_id, query_key, source, mentions, next_cursor) -> None:
        self._open = True
        self._customer_id = customer_id
        try:
            self._conn.execute("begin")
            self._conn.execute("select set_config('app.customer_id', %s, true)", (customer_id,))
            for mention in mentions:
                self._conn.execute(
                    """
                    insert into mentions (
                      id, customer_id, project_id, source, external_id, excerpt, url, author,
                      posted_at, collected_at, matched_variants, scoring_status
                    ) values (
                      gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, now(), %s, 'pending'
                    )
                    on conflict (customer_id, source, external_id) do nothing
                    """,
                    (
                        customer_id,
                        project_id,
                        source,
                        mention["external_id"],
                        mention["excerpt"],
                        mention["url"],
                        mention["author"],
                        mention["posted_at"],
                        [mention["variant"]],
                    ),
                )
            self.record_source_success(
                query_key,
                source,
                mentions,
                mode="incremental",
                next_cursor=next_cursor,
            )
            self._conn.execute("COMMIT")
            self._conn.commit()
        except Exception:
            self._conn.execute("ROLLBACK")
            self._conn.rollback()
            raise
        finally:
            self._open = False
```

`record_source_success` does not commit. Upstream `harken.store.Store.record_source_success` commits its own SQLite connection; `PostgresStore` must not copy that. `test_record_source_success_refuses_to_commit_on_its_own` locks the refusal. `write_mentions_and_cursor` is the only method that commits, and it commits the mention insert and the cursor write together. The success path executes the statement `COMMIT` and then calls `conn.commit()`, which sets `committed` on the scripted transaction. The failure path executes `ROLLBACK` and calls `conn.rollback()`. On a real psycopg connection, keep that statement order inside `with conn.transaction():` set the tenant, insert mentions, then the cursor, and still pass the literal `begin` / `COMMIT` strings through `execute` so the test and the database see one transaction.

Write `apps/worker/sentiment_monitor/scheduler.py`:

```python
import os
from datetime import datetime

from sentiment_monitor.collect_once import gate
from sentiment_monitor.pg_store import PostgresStore
from sentiment_monitor.x_cost import admit_x_read, run_threads

CLAIM_SQL = """
select id, customer_id, project_id, kind
from jobs
where status = 'queued' and run_after <= now()
order by run_after asc, id asc
limit %s
for update skip locked
"""

ENQUEUE_SQL = """
insert into jobs (id, customer_id, project_id, kind, status, run_after, status_detail, created_at)
select gen_random_uuid(), s.customer_id, s.project_id, 'scheduled', 'queued', now(), null, now()
from project_schedules s
where s.enabled
  and s.interval_hours >= %s
  and s.next_run_at is not null
  and s.next_run_at <= now()
  and not exists (
    select 1 from jobs j
    where j.project_id = s.project_id
      and j.kind = 'scheduled'
      and j.status in ('queued', 'claimed')
  )
"""

HEARTBEAT_SQL = """
insert into worker_heartbeat (id, worker_id, last_seen_at)
values (1, %s, now())
on conflict (id) do update
  set worker_id = excluded.worker_id,
      last_seen_at = excluded.last_seen_at
"""

_SECRET_NAMES = (
    "DATABASE_URL",
    "WORKER_DATABASE_URL",
    "X_BEARER_TOKEN",
    "THREADS_ACCESS_TOKEN",
    "TYPESAFE_API_KEY",
    "OPENROUTER_API_KEY",
)


def enqueue_due_sql() -> str:
    return ENQUEUE_SQL


def heartbeat_sql() -> str:
    return HEARTBEAT_SQL


def claim_due_jobs(conn, worker_id: str, limit: int) -> list:
    rows = conn.execute(CLAIM_SQL, (limit,)) or []
    for row in rows:
        conn.execute(
            "update jobs set status = 'claimed', claimed_by = %s, claimed_at = now() where id = %s",
            (worker_id, row["id"]),
        )
    return rows


def record_heartbeat(conn, worker_id: str) -> None:
    conn.execute(HEARTBEAT_SQL, (worker_id,))


def heartbeat_is_stale(last_seen: datetime | None, now: datetime, stale_seconds: int) -> bool:
    if last_seen is None:
        return True
    return (now - last_seen).total_seconds() > stale_seconds


def decide_job(gate_code: int) -> tuple[str, str] | None:
    if gate_code != 0:
        return ("deferred", "credential_unapproved")
    return None


def format_log(message: str) -> str:
    redacted = message
    for name in _SECRET_NAMES:
        value = os.environ.get(name, "")
        if value:
            redacted = redacted.replace(value, "[redacted]")
    return redacted


def enqueue_due_schedules(conn, limits) -> None:
    conn.execute(ENQUEUE_SQL, (limits.schedule_min_interval_hours,))


def _defer(conn, job_id: str, detail: str) -> None:
    conn.execute(
        "update jobs set status = 'deferred', status_detail = %s where id = %s",
        (detail, job_id),
    )


def active_variants_sql() -> str:
    return """
    select text
    from keyword_variants
    where project_id = %s and active
    order by text
    """


def load_active_variants(conn, project_id: str) -> list[str]:
    rows = conn.execute(active_variants_sql(), (project_id,)) or []
    return [row["text"] for row in rows]


def store_source(conn, job, mentions: list, query_key: str, source: str, next_cursor: str | None) -> None:
    PostgresStore(conn).write_mentions_and_cursor(
        customer_id=job["customer_id"],
        project_id=job["project_id"],
        query_key=query_key,
        source=source,
        mentions=mentions,
        next_cursor=next_cursor,
    )


def _call(connect, fn):
    conn = connect()
    try:
        result = fn(conn)
        conn.commit()
        return result
    except Exception as error:
        conn.rollback()
        print(format_log(str(error)))
        raise
    finally:
        conn.close()


def serve(connect, sleep, limits, worker_id: str, root, fetch_x, fetch_threads) -> None:
    while True:
        def claim(conn):
            record_heartbeat(conn, worker_id)
            enqueue_due_schedules(conn, limits)
            jobs = claim_due_jobs(conn, worker_id, limits.max_jobs_per_tick)
            for job in jobs:
                job["variants"] = load_active_variants(conn, job["project_id"])
            return gate(root), jobs

        gate_code, jobs = _call(connect, claim)
        for job in jobs:
            decision = decide_job(gate_code)
            if decision is not None:
                _call(connect, lambda conn, job=job, detail=decision[1]: _defer(conn, job["id"], detail))
                continue
            for variant in job["variants"]:
                key = f"{job['customer_id']}:{job['project_id']}:{variant}"

                def read_cursor(conn, key=key):
                    state = PostgresStore(conn).source_state(key, "x") or {}
                    return state.get("incremental_cursor")

                cursor = _call(connect, read_cursor)
                page = _call(connect, lambda conn, job=job: admit_x_read(conn, job["customer_id"], 10, limits))
                if not isinstance(page, int):
                    _call(connect, lambda conn, job=job, detail=page.detail: _defer(conn, job["id"], detail))
                    break
                mentions, next_cursor = fetch_x(variant, page, cursor)
                threads_result = _call(
                    connect,
                    lambda conn, variant=variant: run_threads(conn, limits, fetch=lambda: fetch_threads(variant)),
                )
                if getattr(threads_result, "detail", None) == "threads_budget":
                    _call(connect, lambda conn, job=job: _defer(conn, job["id"], "threads_budget"))
                    break
                threads_mentions, threads_cursor = threads_result

                def store_page(conn, job=job, mentions=mentions, key=key, next_cursor=next_cursor, threads_mentions=threads_mentions, threads_cursor=threads_cursor):
                    store_source(conn, job, mentions, key, "x", next_cursor)
                    store_source(conn, job, threads_mentions, key, "threads", threads_cursor)
                    conn.execute(
                        "update jobs set status = 'succeeded', status_detail = null where id = %s",
                        (job["id"],),
                    )

                _call(connect, store_page)
        sleep(limits.worker_poll_seconds)


if __name__ == "__main__":
    from pathlib import Path
    import time
    import psycopg
    from sentiment_monitor.limits import load_limits

    root = Path(__file__).resolve().parents[3]
    limits = load_limits(root / "config" / "limits.json")
    worker_id = os.environ.get("WORKER_ID", "worker-1")

    def connect():
        return psycopg.connect(os.environ["WORKER_DATABASE_URL"], autocommit=False)

    def fetch_x(variant: str, limit: int, cursor: str | None):
        from sentiment_monitor.collect import fetch_x_with_cursor
        rows, next_cursor = fetch_x_with_cursor(
            variant, os.environ["X_BEARER_TOKEN"], cursor=cursor, since=None, limit=limit
        )
        mentions = [
            {
                "external_id": row.external_id,
                "excerpt": row.text,
                "url": row.url,
                "author": row.author,
                "posted_at": row.created_at,
                "variant": row.variant,
            }
            for row in rows
        ]
        return mentions, next_cursor

    def fetch_threads(variant: str):
        from sentiment_monitor.sources.threads import ThreadsSource
        page = ThreadsSource(os.environ["THREADS_ACCESS_TOKEN"]).fetch_page(variant, limit=25)
        mentions = [
            {
                "external_id": mention.id,
                "excerpt": mention.text,
                "url": getattr(mention, "url", None),
                "author": getattr(mention, "author", None),
                "posted_at": mention.created_at.isoformat(),
                "variant": variant,
            }
            for mention in page.mentions
        ]
        return mentions, page.next_cursor

    serve(connect, time.sleep, limits, worker_id, root, fetch_x, fetch_threads)
```

In `apps/worker/sentiment_monitor/collect.py`, add `fetch_x_with_cursor` and make `fetch_x_page` return its candidate list. Do not change the Harken pin.

```python
def fetch_x_with_cursor(query: str, bearer_token: str, *, cursor: str | None, since: datetime | None, limit: int):
    page = XSource(bearer_token=bearer_token).fetch_page(query, limit=limit, cursor=cursor, since=since)
    candidates = [
        Candidate(
            source="x",
            external_id=external_id_for(mention),
            variant=query,
            text=mention.text,
            url=mention.url,
            author=mention.author,
            created_at=mention.created_at.isoformat(),
        )
        for mention in page.mentions
    ]
    return candidates, page.next_cursor


def fetch_x_page(query: str, bearer_token: str, *, cursor: str | None, since: datetime | None, limit: int) -> list[Candidate]:
    candidates, _next_cursor = fetch_x_with_cursor(
        query, bearer_token, cursor=cursor, since=since, limit=limit
    )
    return candidates
```

Replace the Task 9 body of `fetch_x_page` with these two functions. Task 9's test still receives a list from `fetch_x_page`.

`parents[3]` is the repository root. `load_limits` with the environment omitted reads Railway variables over the file. `serve` loads active variants, reads `source_state` for the X cursor, and calls `admit_x_read` and `run_threads` before `fetch_x` and `fetch_threads`. `fetch_x` is `(variant, limit, cursor) -> (mentions, next_cursor)`. `fetch_threads` is `(variant) -> (mentions, next_cursor)`. A block report defers the job and does not call the fetch. Each source is written with `store_source`, which calls `write_mentions_and_cursor`, and the job is marked `succeeded` only after both writes. `psycopg.connect` returns a connection; wrap `execute` if the driver returns a cursor, and still send `CLAIM_SQL` unchanged. The loop tests call `serve` once. Their `sleep` raises `SystemExit` after recording `worker_poll_seconds`. They do not open a socket.

- [ ] **Step 4: Run the tests to verify they pass**

Run from the repository root:

```bash
apps/worker/.venv/bin/pytest apps/worker/tests/test_scheduler.py apps/worker/tests/test_pg_store.py -v
```

Expected: PASS. 15 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/pyproject.toml apps/worker/sentiment_monitor/scheduler.py apps/worker/sentiment_monitor/pg_store.py apps/worker/sentiment_monitor/backup.py apps/worker/sentiment_monitor/collect.py apps/worker/railway.toml apps/web/railway.toml apps/worker/tests/test_scheduler.py apps/worker/tests/test_pg_store.py deploy/postgres-service.txt
git commit -m "feat: poll due jobs and commit Harken cursors with mentions"
```

---

## Risks

### Threads keyword search

The official keyword-search page (`https://developers.facebook.com/documentation/threads/keyword-search`, read 1 Nov 2026) allows:

- `GET https://graph.threads.com/v1.0/keyword_search`
- Permissions `threads_basic` and `threads_keyword_search`. Without approval for `threads_keyword_search`, search runs only on posts owned by the authenticated user. After approval, public posts are searchable.
- A maximum of 2,200 queries per user in a rolling 24 hours, shared across apps. Repeat queries count. Queries that return no results do not count. Sensitive or offensive keywords return an empty array.
- `search_type` of `TOP` (default) or `RECENT`, `search_mode` of `KEYWORD` (default) or `TAG`, `limit` default 25 and maximum 100, plus `since` and `until`.

If Meta denies the permission or the app review never finishes, the adapter still has nothing public to read. The worker records `authorization_failed` or `unavailable`, the dashboard says collection failed, and it does not show that state as zero mentions. There is no scraper fallback. The spec forbids substituting unsupported scraping. Two-source launch stays blocked. An X-only launch happens only when the user sets `reduced_source_launch` to `x_only_approved`.

The same page does not document a paging cursor. Task 10 ignores `cursor` and uses `since`. A full page sets `truncated` so the UI does not claim the page was complete. How to retrieve the next public page is an open question.

An empty array is also the documented response for a sensitive keyword, and the response has no separate error flag. Task 11 therefore does not treat a Threads empty array as a confirmed zero. Distinguishing a true empty search from a sensitive-keyword block is an open question.

### X pay-per-use cost

Official pages read on 1 Nov 2026:

- `https://docs.x.com/x-api/getting-started/pricing.md`
  - Pay-per-usage. Credits are bought in advance. There is no subscription in that description.
  - Reads are charged per resource returned. **Posts: Read is $0.005 per resource.**
  - Pay-per-usage plans are capped at **3 million Post reads per monthly billing cycle**.
  - The same page lists a spending limit: when the limit set in the console is reached, requests are blocked until the next billing cycle. This plan does not choose that dollar amount.
  - Deduplication is described as a soft guarantee inside a 24-hour UTC day. Our counter in Task 12 counts every post returned and does not assume the soft dedup will reduce the bill.
  - The page says prices are subject to change. Re-read it before anyone approves `x_cost_understood`.
  - Recent search of public posts is not in that page's Owned Reads table. Owned Reads at $0.001 do not apply to `GET /2/tweets/search/recent` for arbitrary public posts. Harken calls that recent-search endpoint.
- `https://docs.x.com/x-api/fundamentals/rate-limits.md`
  - `GET /2/tweets/search/recent`: 450 requests per 15 minutes per app, 300 per 15 minutes per user. Default 10 results, maximum 100, query length 512.
  - Exceeding a limit returns 429 until the window resets. Task 11 maps 429 to `rate_limited`.

Decided 1 Nov 2026: one shared operator X account that we manage pays. Task 12 checks Postgres counters before any X call and stops with `x_customer_cap` or `x_global_cap`. The committed defaults are 20000 reads a month global and 2000 a month per customer. Those defaults are pending user confirmation. The X console spending limit is still pending, and this plan does not state a dollar amount for it. `approved: false` in `config/x-budget.json` still blocks a live call.

### Jev Indonesian accuracy

TypeSafe's model page (`https://docs.typesafe.ai/models`, read 1 Nov 2026) says English is the primary training language and other languages are not equally well supported. The spec already says Indonesian quality is a launch gate, not an established capability. Task 19 computes relevance, sentiment, topic agreement, and uncertain-routing recall against a labelled file the user supplies, including whatever informal rows they mark. The committed criteria file has null thresholds and `approved: false`. This plan sets no accuracy number. Launch stays blocked until the user writes the thresholds and `python eval/gate.py` exits 0.

Jev pricing observed on that same model page: Jev 1.14 (`jev-1.14.0`) is $0.042 per million input tokens and output tokens are free. OpenRouter's model page `https://openrouter.ai/typesafe/jev-1.14` showed the same input price on 1 Nov 2026. Re-check both before budgeting. Neither number is a per-customer operating cost. TypeSafe account rate limits are visible only in the console; they are not known here.

The proposed fallback switch (network failure, 402, 408, 429, 500, 502, 503, 504) is implemented so it can be tested. Production leaves it off until `jev_fallback_rule` is true. Whether that switch is the one the user wants is an open question copied from the spec.

## Open questions

Updated 1 Nov 2026 with the user's answers and the team-lead decisions. Full reasoning and sources: `docs/superpowers/plans/2026-11-01-open-questions.md`. Where that note still describes an earlier option, this plan wins. Do not replace a pending item with an estimate, a price target, a timeline, or an accuracy number. The defaults below are the values the tasks implement until the user changes them.

Status: **Decided**, **Deferred**, **Research** (still needs outside facts), **Sign-off** (decided, approval still required), **Pending** (user confirmation still open, default already in force).

### Still pending, with defaults

| Item | Status | Default while it stays pending |
| --- | --- | --- |
| Limit values | Pending user confirmation | X post reads `20000` a month global and `2000` a month per customer. Threads reserve `1500` of the platform `2200` per rolling 24 hours. Scheduled collections at least `6` hours apart. Manual runs at least `900` seconds apart per customer. At most `5` jobs per worker pass. Poll `20` seconds, allowed range 15–30. Heartbeat stale after `90` seconds. |
| Hobby or Pro | Pending | Unset. No Railway config in this plan selects a tier. Hobby is $5/month including $5 usage. Pro is $20/month including $20 usage. |
| Data residency | Pending | Singapore, Railway region `asia-southeast1-eqsg3a` (`asia-southeast1`). Whether a customer or the PDP Law requires storage in Indonesia is still research. Railway has no Indonesia region. |
| Backup destination | Pending | `BACKUP_DESTINATION` empty. The nightly `pg_dump` is **not built**. |

1. **Decided (method).** SME validation: recruit from the user's network, starting with the example brand owner. One session per owner; the length and the purchase-value and usability thresholds are the user's.
2. **Deferred.** Pricing model and operating-cost limit, until a live app exists. Hosting cost is Railway's subscription plus measured usage. This plan does not state a monthly total.
3. **Research / Decided.** Meta approval of `threads_keyword_search`: research (App Review). Decided: one shared rolling-24-hour counter in Postgres, checked before every Threads query. The reserve default is `1500` of `2200` (see the pending table).
4. **Decided.** A Threads empty array is shown as "no results or blocked keyword", never zero. A variant that is always empty is flagged.
5. **Research.** Threads paging: use `RECENT` with narrow `since`/`until` windows and split full pages. Verify `paging.cursors.after` with a live token.
6. **Decided / Pending.** One shared operator X account that we manage pays. Per-customer X accounts are out of v1. The cap defaults are in the pending table. The X console spending limit is still pending, and this plan does not state a dollar amount for it.
7. **Decided (process).** Confidence thresholds are set from the Indonesian evaluation results, not in advance.
8. **Decided (process) / Research.** Labelled real posts including slang and false matches, two labellers, thresholds set by the user before scoring. Dataset size and thresholds are open.
9. **Decided (starter).** Topic labels: rasa/kualitas produk, harga, pelayanan, pengiriman/waktu tunggu, kebersihan, lokasi/akses, promo, fallback lainnya. Validate before `topic_labels`.
10. **Decided.** The multi-label counting rule in Task 5 is approved, and the UI explains it.
11. **Decided / Research.** No high-impact badge in v1. X `public_metrics` needs research before any later rule.
12. **Decided.** The overview formula is approved.
13. **Decided / Pending.** Collection is trigger-based. See Collection triggers and scheduling. Timezone Asia/Jakarta. Daily trend bucket. Coverage is what recent search returns. Interval defaults are in the pending table. The X recent-search lookback needs research.
14. **Decided / Research / Pending.** Indonesian only and mobile-first in v1. Backups are a nightly `pg_dump` to off-Railway storage, not built until `BACKUP_DESTINATION` is set. Retention, deletion, and privacy need a PDP Law review.
15. **Decided / Pending.** Railway, Singapore (`asia-southeast1`). See Deployment on Railway. Plan tier and data residency are in the pending table. In-app caps are enforced first. The Railway hard spend limit is only a backstop.
16. **Decided (pilot).** No SLA is acceptable for the pilot. The fallback status list is accepted, with each fallback logged to the operator. Research: what TypeSafe's 402 means.
17. **Research.** TypeSafe account rate limits, from the console.
18. **Research.** TypeSafe hosting location. Measure latency from a Railway Singapore service.
19. **Research.** TypeSafe retention versus our obligations.
20. **Decided.** Credential mode is `shared_operator` with `approved` false. v1 does not include `secrets.ts` or any per-customer token encryption.
21. **Decided.** Keep `source_post_unavailable` distinct from a scoring failure. Mark a post unavailable only on an explicit fetch failure.
22. **Deferred.** Team size, staffing, and timeline. Team features are out of v1.
23. **Sign-off.** The user accepted the stack, including Railway. CTO sign-off is required before Task 1.
24. **Decided.** Repository `sentiment-monitor`, private. The GitHub owner still needs confirming.
25. **Decided.** The Indonesian explanation sentences stay as written here until a native-speaker review and owner testing.
26. **Decided.** An always-on worker (1 replica) claims due jobs with `SELECT ... FOR UPDATE SKIP LOCKED`. There is no Railway cron service. Harken cursors are Postgres rows written in the same transaction as the mentions. Harken stays at `d0710a427dbbe712594ef3a6c25112e1d14cc027`, unmodified. Poll default is in the pending table.

## Spec acceptance criteria

| Spec acceptance criterion | Tasks |
| --- | --- |
| AC-1. Example variants enter collection without the full brand name. Empty or duplicate variants cannot be saved. | Task 1, Task 2, Task 8, Task 9, Task 10, Task 15 |
| AC-2. Unrelated "tempe gembus" posts are excluded or sent to review, not confirmed. Error rates are agreed before launch. | Task 4, Task 14, Task 19 |
| AC-3. A successfully processed mention has relevance and, where relevant, sentiment, topics, and confidence. Failed scoring is never neutral. | Task 4, Task 13, Task 14, Task 16 |
| AC-4. The dashboard has every required results component, source links, stable filters, and explicit empty, pending, and error states. | Task 5, Task 11, Task 15, Task 16, Task 22 |
| AC-5. Low confidence goes to Not sure. A correction is stored, stays distinct from the original judgment, and updates the displayed aggregates. | Task 4, Task 5, Task 14, Task 17 |
| AC-6. An eligible attention item appears once, increments the unread indicator once, mark-as-seen clears it, and a failed update is visible. | Task 6, Task 17 |
| AC-7. v1 has no reply drafts, auto-replies, text-generation calls, social posting, or external notification delivery. | Task 15, Task 17, Task 20 |
| AC-8. Launch is blocked until Indonesian and informal evaluation meets criteria the user sets. The dataset and the numbers stay open until then. | Task 19, Task 20 |
| AC-9. Two-source launch is blocked until Threads access is demonstrated and X access, cost, and limits are understood. A reduced-source launch requires an explicit decision. | Task 10, Task 11, Task 12, Task 20, Task 22 |

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-01-sentiment-monitor-mvp.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

Implementation does not start until the stack review gate is accepted. This planning session writes no application code.
