# Empirical Search Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ScrapeCreators route table with the route set proven by the 9 Nov 2026 empirical run, add the Threads civil-date window, the joined-hashtag matching rule, and honest provider-reported credit accounting.

**Architecture:** A single fixed route table in `apps/worker/sentiment_monitor/sources/routes.py` remains the source of truth for platform/intent routes, request parameters, and request counts. Threads routes get a computed `start_date`/`end_date` window. Instagram and TikTok fetch loops issue all unconditional routes and carry accumulated counts/credits when any route fails. Instagram hashtag page 2 is a conditional route fetched only when page 1 passes a named literal-match threshold and exposes a cursor. `relevance.literal_match_status` accepts explicit platform hashtag lists and treats a joined hashtag as a literal match for a multi-word phrase. The web mirrors the route counts for disclosure. No migration and no schema column change.

**Tech Stack:** Python 3.12 (pytest), Next.js 16 / TypeScript / Vitest, PostgreSQL 16 (disposable local only).

**Spec:** `/workspace/sc-research/impl/routes-20261109/brief.txt` plus `/workspace/sc-research/empirical-20261109/RESULTS.md` and `ledger.jsonl`.

## Global Constraints

- Only touch `/workspace/elvsentiment-wt-routes`; local commits only; no amend/rebase/reset/`--no-verify`.
- No provider/paid/network calls of any kind. All app/test entry points run through the `env -i` wrapper with Python/Node external transport blocked.
- No new migrations. `011_search_intent_and_relevance.sql` sha256 must stay `8f6f5be086837e76711d7af80fee5f20df3103ec6cc0e44346c32393c5f1d0b8`; 001–011 untouched.
- Do not change scoring, F5, the atomic store, RLS, dedup, sanitized logs, undated handling, or partial-failure counting.
- Tests use synthetic opener stubs only. Fixtures derive from `raw/*.json`, trimmed, with no credits_remaining/balance, signed media URLs, tokens, API keys, authorization headers, cookies, or unneeded personal data.
- Threads date format is `YYYY-MM-DD` (ledger: `start_date=2026-11-02`, `end_date=2026-11-10` for a 9 Nov 23:31 WIB run).
- Threads window rule: `today = collected_at` converted to Asia/Jakarta (fixed UTC+7); `end_date = today + 1 day`; `start_date = end_date - 8 days`. This is the 8-day window ending tomorrow and reproduces the ledger. No split window.
- Never quote phrases. Never send `region`. Never send `sort_by` at all (therefore never combine `sort_by=relevance` with `region`).
- Credits are always provider-reported `credits_charged`; missing is unknown (`None`), explicit `0` is known zero. Never assume one credit per request.
- Preserve `route_ids` provenance on deduped mentions; associations stay one row per mention/keyword/route.

## Route Table (final)

| Platform | Intent | Route id | Path | Parameters |
|---|---|---|---|---|
| Threads | phrase | `threads.keyword` | `/v1/threads/search` | `query=<phrase>`, `start_date`, `end_date` |
| Threads | hashtag | `threads.hashtag_text` | `/v1/threads/search` | `query=<literal #tag>`, `start_date`, `end_date` |
| Instagram | phrase | `instagram.reels` | `/v2/instagram/reels/search` | `query=<phrase>`, `date_posted=last-week` |
| Instagram | phrase | `instagram.hashtag_from_phrase` | `/v1/instagram/search/hashtag` | `hashtag=<spaces removed>`, `date_posted=last-week` |
| Instagram | hashtag | `instagram.hashtag` | `/v1/instagram/search/hashtag` | `hashtag=<term>`, `date_posted=last-week` |
| Instagram | hashtag | `instagram.hashtag_page2` | `/v1/instagram/search/hashtag` | page-1 params + `cursor=<page-1 cursor>`; conditional |
| TikTok | phrase | `tiktok.keyword` | `/v1/tiktok/search/keyword` | `query=<phrase>`, `date_posted=this-week` |
| TikTok | phrase | `tiktok.top` | `/v1/tiktok/search/top` | `query=<phrase>`, `publish_time=this-week` |
| TikTok | phrase | `tiktok.keyword_page2` | `/v1/tiktok/search/keyword` | `query=<phrase>`, `date_posted=this-week`, `cursor=30` |
| TikTok | hashtag | `tiktok.hashtag` | `/v1/tiktok/search/hashtag` | `hashtag=<term>` |
| TikTok | hashtag | `tiktok.hashtag_keyword` | `/v1/tiktok/search/keyword` | `query=#<term>`, `date_posted=this-week` |

Request counts (maximum, including the conditional Instagram page 2):
Threads phrase 1 / hashtag 1; Instagram phrase 2 / hashtag 2; TikTok phrase 3 / hashtag 2.
All three platforms: phrase 6, hashtag 5, one phrase + one hashtag 11. UI says "hingga N permintaan" and never claims credits.

Instagram page-2 threshold: `INSTAGRAM_PAGE2_LITERAL_MIN_PERCENT = 60` and `INSTAGRAM_PAGE2_MIN_PAGE_SIZE = 5`. Fetch page 2 only when the page-1 payload has a non-empty `cursor`, page-1 parsed post count is at least 5, and `literal_count * 100 >= total * 60`. Empty page, tiny page, missing cursor, or below-threshold page means no page-2 request.

## Review Focus

- A phrase containing a quote character must still be sent verbatim, not quoted: `Kopi "Kenangan"` reaches the provider as text, never as `"Kopi Kenangan"`.
- A UTC instant just after 17:00 UTC is already the next Jakarta civil day; the Threads window must roll forward, not stay on the UTC date.
- Instagram hashtag page 1 with a cursor but fewer than 5 posts must not spend a page-2 request.
- An explicit `credits_charged: 0` from an empty response must log `0`, while a missing field must log `-`; neither may be treated as one credit.
- A TikTok post whose description lacks the phrase but whose `text_extra` contains `timnasindonesia` must be `literal_match` for phrase `timnas indonesia`, while `Indonesian` must still not match `Indonesia`.

---

### Task 1: Threads civil-date window

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/routes.py`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py`
- Test: `apps/worker/tests/test_routes.py`, `apps/worker/tests/test_threads_source.py`

**Interfaces:**
- Produces: `threads_date_window(now: datetime | str | None = None) -> tuple[str, str]`
- Produces: `JAKARTA = timezone(timedelta(hours=7))`, `THREADS_WINDOW_DAYS`
- Changes: `request_params(route, keyword, *, now=None)`; threads routes carry `date_window="threads_start_end"`.

- [ ] **Step 1: Write failing tests** for `threads_date_window("2026-11-09T16:31:00Z") == ("2026-11-02", "2026-11-10")`, `threads_date_window("2026-11-09T18:00:00Z") == ("2026-11-03", "2026-11-11")`, Threads request params include both dates for phrase and hashtag, and the phrase value contains no quote.
- [ ] **Step 2: Run RED** and save `logs/red-threads-dates.log` with the true exit code.
- [ ] **Step 3: Implement** the Jakarta date window and threads params; pass `now=collected_at` from `fetch_threads_mentions`.
- [ ] **Step 4: Run GREEN** and save `logs/green-threads-dates.log`.
- [ ] **Step 5: Commit** `feat(worker): use Threads civil-date window`.

### Task 2: Instagram phrase hashtag route and conditional page 2

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/routes.py`
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py`
- Test: `apps/worker/tests/test_routes.py`, `apps/worker/tests/test_instagram_source.py`

**Interfaces:**
- Produces: `INSTAGRAM_PAGE2_LITERAL_MIN_PERCENT = 60`, `INSTAGRAM_PAGE2_MIN_PAGE_SIZE = 5`, `should_fetch_instagram_page2(literal_count, total, cursor) -> bool`
- Produces: route ids `instagram.hashtag_from_phrase` and conditional `instagram.hashtag_page2`
- Consumes: `literal_match_status` and normalized `hashtags` from Task 4; before Task 4, page-2 tests may use text-only matches.

- [ ] **Step 1: Write failing tests** that phrase intent calls reels plus hashtag with `hashtag=kopikenangan` and `date_posted=last-week`; hashtag intent calls page 1 only below threshold; calls page 2 with `cursor=2` at/above threshold; omits page 2 for empty page, missing cursor, and fewer than 5 posts; page-2 failure preserves page-1 counts/credits.
- [ ] **Step 2: Run RED**, save `logs/red-instagram-routes.log`.
- [ ] **Step 3: Implement** the route-table entries and the Instagram loop with conditional page 2.
- [ ] **Step 4: Run GREEN**, save `logs/green-instagram-routes.log`.
- [ ] **Step 5: Commit** `feat(worker): add Instagram phrase tag route and conditional page 2`.

### Task 3: TikTok extra routes

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/routes.py`
- Test: `apps/worker/tests/test_routes.py`, `apps/worker/tests/test_tiktok_source.py`, `apps/worker/tests/test_scheduler.py`, `apps/worker/tests/test_postgres16.py`

**Interfaces:**
- Produces: route ids `tiktok.keyword_page2`, `tiktok.hashtag_keyword`.
- Consumes: existing `fetch_tiktok_mentions` loop and `request_params(route, keyword)`.

- [ ] **Step 1: Write failing tests** that phrase intent issues keyword, top, keyword-page-2 in order with `cursor=30` only on page 2; top never gets a cursor; hashtag intent issues hashtag then keyword `query=%23kopi` with `date_posted=this-week`; no URL contains `region=` or `sort_by=`.
- [ ] **Step 2: Run RED**, save `logs/red-tiktok-routes.log`.
- [ ] **Step 3: Implement** the two routes and `extra_params`.
- [ ] **Step 4: Run GREEN**, save `logs/green-tiktok-routes.log`; update dependent route-count expectations.
- [ ] **Step 5: Commit** `feat(worker): add TikTok page-2 and hashtag keyword routes`.

### Task 4: Joined-hashtag matching rule

**Files:**
- Modify: `apps/worker/sentiment_monitor/relevance.py`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py`, `instagram.py`, `tiktok.py`
- Modify: `apps/worker/sentiment_monitor/pg_store.py`
- Test: `apps/worker/tests/test_relevance.py`, `apps/worker/tests/test_pg_store.py`, source fixture tests

**Interfaces:**
- Produces: `hashtags_in_text(text: str) -> list[str]`
- Changes: `literal_match_status(text, keyword, intent, *, hashtags: Sequence[str] | None = None)`.
- Normalized mentions carry `hashtags: list[str]` from platform fields (TikTok `text_extra`/`challenges`, optional IG/Threads fields); text-derived hashtags are added inside relevance.

- [ ] **Step 1: Write failing tests** that `#timnasindonesia` and explicit hashtag `timnasindonesia` match phrase `timnas indonesia`; bare `timnasindonesia` does not; `Indonesian` does not match `Indonesia`; accented `#cafe` matches `café`; empty text with explicit hashtags is honest; hashtag intent still matches; `pg_store` passes explicit hashtags and stores the computed status.
- [ ] **Step 2: Run RED**, save `logs/red-joined-hashtag.log`.
- [ ] **Step 3: Implement** accent-folded hashtag equality, text-derived hashtags, platform hashtag extraction, and `pg_store` wiring. Do not add a matched-field column or value.
- [ ] **Step 4: Run GREEN**, save `logs/green-joined-hashtag.log`.
- [ ] **Step 5: Commit** `feat(worker): count joined hashtags as literal phrase matches`.

### Task 5: Provider-reported zero-credit accounting

**Files:**
- Test: `apps/worker/tests/test_threads_source.py`, `test_instagram_source.py`, `test_tiktok_source.py`, `test_scheduler.py`
- Modify only if a test exposes a fixed-credit assumption.

- [ ] **Step 1: Write failing/regression tests** for empty results with `credits_charged: 0` (known zero), empty results with the field absent (unknown), and a scheduler log line that renders `credits_charged=0` for zero and `credits_charged=-` for unknown.
- [ ] **Step 2: Run RED or prove current behaviour fails the assertion**, save `logs/red-zero-credit.log`.
- [ ] **Step 3: Fix any fixed-credit assumption**, otherwise leave accounting unchanged and record why.
- [ ] **Step 4: Run GREEN**, save `logs/green-zero-credit.log`.
- [ ] **Step 5: Commit** `test(worker): pin provider-reported zero-credit accounting`.

### Task 6: Web request disclosure

**Files:**
- Modify: `apps/web/src/domain/keyword-intent.ts`
- Modify: `apps/web/src/domain/keyword-intent.test.ts`
- Modify: `apps/web/src/components/monitor/settings-form.tsx`
- Modify: `apps/web/src/components/monitor/settings-form.test.tsx`

**Interfaces:**
- Changes: `ROUTE_COUNT = {threads: {phrase:1,hashtag:1}, instagram: {phrase:2,hashtag:2}, tiktok: {phrase:3,hashtag:2}}`
- UI label: `hingga N permintaan per pengumpulan`, plus a note that Instagram hashtag page 2 is conditional and credits appear only when reported.

- [ ] **Step 1: Write failing tests** for phrase-all 6, hashtag-all 5, mixed 11, and the rendered "hingga 11 permintaan per pengumpulan".
- [ ] **Step 2: Run RED**, save `logs/red-web-requests.log`.
- [ ] **Step 3: Implement** the table and copy.
- [ ] **Step 4: Run GREEN**, save `logs/green-web-requests.log`.
- [ ] **Step 5: Commit** `feat(web): disclose empirical request counts`.

### Task 7: Secret-free fixtures

**Files:**
- Create: `apps/worker/tests/fixtures/scrapecreators/threads_timnas.json`
- Create: `apps/worker/tests/fixtures/scrapecreators/instagram_hashtag_page1.json`
- Create: `apps/worker/tests/fixtures/scrapecreators/instagram_hashtag_page2.json`
- Create: `apps/worker/tests/fixtures/scrapecreators/tiktok_keyword_timnas.json`
- Create: `apps/worker/tests/fixtures/scrapecreators/tiktok_hashtag_timnas.json`
- Test: fixture-driven tests in the source test files.

- [ ] **Step 1: Build trimmed fixtures** from `raw/*.json`, keeping only id/author/text/timestamp/hashtag fields needed.
- [ ] **Step 2: Grep the fixture directory** for key/authorization/cookie/token/credits_remaining/signed-URL markers and save `logs/fixture-secret-scan.log`.
- [ ] **Step 3: Add fixture-driven tests** with opener stubs proving real payload shapes normalize and match.
- [ ] **Step 4: Run RED then GREEN**, save logs.
- [ ] **Step 5: Commit** `test(worker): add secret-free ScrapeCreators fixtures`.

### Task 8: Final verification

- [ ] Run every gate in the brief on the final commit; record command, cwd, true exit code, exact counts, and 011 sha in `/workspace/sc-research/impl/routes-20261109/notes.md`.
- [ ] Confirm `git status --short` empty, 001–011 untouched, disposable PG stopped and removed.
- [ ] Do not claim QA passed or go live.

## Self-Review

- **Spec coverage:** Threads dates (Task 1), IG phrase hashtag (Task 2), IG hashtag page 2 (Task 2), TikTok phrase page 2 (Task 3), TikTok hashtag keyword (Task 3), matching rule (Task 4), request counts/UI (Task 6), zero credits (Task 5), fixtures (Task 7), gates (Task 8).
- **Boundaries:** Page-2 threshold tests cover just below/at/above 60%, empty page, missing cursor, and minimum page size.
- **Type consistency:** `request_params(route, keyword, *, now=None)`, `literal_match_status(..., *, hashtags=None)`, `should_fetch_instagram_page2(literal_count, total, cursor)` are used consistently by later tasks.
- **Review focus:** Each line maps to a test in Tasks 1, 2, 4, or 5.
