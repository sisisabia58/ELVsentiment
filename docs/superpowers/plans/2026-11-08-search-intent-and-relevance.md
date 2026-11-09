# Search Intent and Deterministic Text Relevance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **PROPOSED DEFAULT — FOR USER REVIEW.** Nothing in this plan is approved behavior. Every route, intent rule, schema change, UI count, and copy string below is a proposed default for the user to accept, reject, or change before implementation. Planning only: this document does not authorize migrations, deploys, provider calls, merges, or pushes.

**Goal:** Give each monitored keyword an explicit `phrase` or `hashtag` intent, route every selected platform through a fixed documented endpoint whitelist, and attach a deterministic per-keyword text-match status to every stored candidate while preserving existing data, tenant isolation, and truthful collection telemetry.

**Architecture:** A small pure keyword-intent and route-whitelist contract lives in the worker and is mirrored in the web for display and request-count disclosure. Each ScrapeCreators fetch uses only the routes for its `(platform, intent)` pair, stops sending `region`, and keeps coarse documented date windows where the provider documents them. The worker computes `literal_match | no_literal_match | unknown_text` from stored text at write time and stores one association row per mention-keyword-route inside the existing atomic mention+cursor transaction. The web reads those associations, derives `legacy_unassessed` when none exist, and shows honest `Kandidat`, `Cocok teks`, and `Belum pasti` counts without deleting candidates or changing the meaning of pending scoring.

**Tech Stack:** Python 3.12, pytest, psycopg 3, urllib; TypeScript, Next.js 16, React 19, Vitest, PGlite; PostgreSQL 16.

**Spec:** `/workspace/sc-research/plan/brief.md` (secrets-free planning brief for this plan). The brief is the source of proposed defaults; it is not approved product behavior.

## Global Constraints

- This planning session writes only this plan file. It does not edit code, run tests/builds/migrations, make network or provider calls, read `.env`, or commit/push.
- All behavior in this plan is `PROPOSED DEFAULT — FOR USER REVIEW`. The user must approve each proposed default before implementation.
- Migrations `001` through `010` stay byte-identical. The only future migration is the additive `011_search_intent_and_relevance.sql` described by code block in Task 7; do not create it during planning.
- `app_user` and `worker_role` keep `FORCE ROW LEVEL SECURITY`. Tenant context stays `set_config('app.customer_id', ..., true)`. No cross-tenant dedup and no new cross-tenant visibility.
- The mention+cursor write stays one atomic transaction. The durable commit receipt, `CommitOutcomeUnknown` handling, and one-success-line behavior stay unchanged.
- Collection telemetry keeps its existing meaning: `returned`, `parsed`, `deduplicated`, `saved`, `http_status='-'` when unknown, and `credits_charged` only when the provider reports a value. Do not invent credit prices or quotas.
- Logs stay sanitized: no keyword text, post text, URLs, API keys, headers, request URLs, or raw exception strings.
- Non-matching candidates are never deleted. Existing rows get no destructive relevance backfill and no paid refetch.
- Phrase keywords remain the default. Existing rows migrate as `phrase`. A keyword becomes `hashtag` only when the user explicitly enters a leading `#` in a new or edited keyword; no automatic phrase-to-hashtag conversion exists.
- Threads has no hashtag search endpoint. Threads date parameters are not sent until the provider format is verified; no fake Threads pagination is added.
- Instagram `/v1/instagram/search/popular` exists but is not added by this plan. It remains a future optional route.
- The scoring service is not deployed in production. This plan only adds a scoring-eligibility contract and honest pending counts; it does not deploy scoring.
- Tests never make provider/network calls. Mock the `opener` / fetch callables only. Web tests run under Node 24 (`npx -y node@24`). PG16 integration runs only against a disposable non-superuser `pgserver` through `POSTGRES_TEST_URL`; `POSTGRES_TEST_LOG_PATH` is optional.
- Worker tests use the existing `.tooling/venv`; `apps/worker/.venv` does not exist. Run them from the repo root as `PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest ...`.
- Commit once per task during future implementation. Do not push. Every production action (migration, deploy, merge) needs separate user approval.
- Temporary files belong under `.tooling/`.

## Review Focus

- A phrase keyword that is a substring of a longer word (`Indonesia` versus `Indonesian`) must be `no_literal_match`, never `literal_match`.
- A hashtag keyword must match compact tag forms (`#BankMandiri`, `bankmandiri`) but not the spaced phrase (`bank mandiri`), and phrase intent must not match the compact form.
- The same provider post collected for two projects of one customer must be visible and independently labelled in both projects without weakening cross-tenant isolation.
- Empty or missing post text must be `unknown_text`, not `no_literal_match`, and must never cause deletion or a zero-candidate claim.
- Legacy mentions with no association rows must render as `Belum dinilai (data lama)` / undecided, never as non-matching, and must still count as candidates.
- The local 8-day overlap window will drop provider-returned items older than 8 days; today every returned item is saved. This is a behavior change that needs explicit user review before implementation.

---

## Proposed Defaults for Review

These are decisions the implementer cannot infer from the brief. Each is explicitly unapproved until the user signs off.

1. **Keyword intent.** `phrase` is the default. Existing `keyword_variants` rows migrate as `phrase` even if their text begins with `#`. New or edited keywords become `hashtag` only when the user types a leading `#`; the stored text preserves that tag. Justification: preserving legacy behavior and avoiding silent route changes.
2. **Threads with hashtag intent.** Use `GET /v1/threads/search` with the literal `#tag` text query and show the plain-language label `Threads tidak punya pencarian tagar; tagar dicari sebagai teks.` Justification: skipping would hide data the user explicitly asked to monitor, and no hashtag endpoint exists. This is a text search, not a hashtag search.
3. **Instagram.** Phrase intent uses only `GET /v2/instagram/reels/search` (Google-indexed reels limitation disclosed in settings). Hashtag intent uses only `GET /v1/instagram/search/hashtag`. Do not call both routes for one keyword.
4. **TikTok.** Phrase intent preserves current coverage with `GET /v1/tiktok/search/keyword` plus `GET /v1/tiktok/search/top`. Hashtag intent uses `GET /v1/tiktok/search/hashtag`. Preserve phrase coverage by default to avoid hidden loss.
5. **Region cleanup.** Stop sending `region` to Threads and Instagram. Also stop sending it to TikTok because the provider documents `region` as proxy location only. This is contract cleanup, not a relevance fix.
6. **Relevance.** Normalize with NFKC, casefold, and whitespace collapse. Phrase matching uses Unicode-aware non-word boundaries, so `Indonesia` matches `indonesia` and `#Indonesia`, not `Indonesian`. Hashtag matching compacts whitespace and punctuation and allows an optional leading `#`, so hashtag intent for `Bank Mandiri` matches `#BankMandiri` and `bankmandiri`, not `bank mandiri`. `C++` matches `c++`, not `c++17` or `c ++`. Empty text is `unknown_text`. This is called `text match`, never `semantically verified`.
7. **Data model.** Keep every candidate. Add a `keyword_variants.intent` column and a `mention_keyword_associations` table carrying per-keyword status plus route id, intent, and collected time. Change mention uniqueness from `(customer_id, source, external_id)` to `(customer_id, project_id, source, external_id)` so the same post in two projects of one customer is two rows, not one. This is per-customer-per-project dedup, not global dedup. On conflict, union `matched_variants` instead of keeping only the first keyword.
8. **Legacy rows.** Existing mentions keep their data and have no association rows. The web derives `legacy_unassessed` when no association row exists. No destructive backfill and no paid refetch.
9. **UI counts and scoring eligibility.** `Kandidat` = all rows in the active filter. `Cocok teks` = at least one association is `literal_match`. `Belum pasti` = no `literal_match` and at least one association is `unknown_text` or no association exists. `Tidak cocok teks` is a per-row label but not a headline count. The same pure count function is used in Sebutan and the dashboard with each screen's active filters. Scoring eligibility stays unchanged: every stored candidate remains eligible for scoring through its existing `scoring_status`, and text match never removes a candidate from scoring or from the pending count. Pending scoring copy is unchanged.
10. **Freshness.** Instagram routes send `date_posted=last-week`. TikTok keyword sends `date_posted=this-week`; TikTok top sends `publish_time=this-week`; TikTok hashtag sends no undocumented date parameter. Routes with a coarse window keep items posted within 8 days of collection (one day of overlap) and always keep undated items. Threads sends no date parameter. Provider ID dedup remains. **Behavior change for explicit user review:** the local 8-day window will drop provider-returned items older than 8 days, whereas today every returned item is saved.
11. **Request disclosure.** Show `N permintaan per pengumpulan` for selected ScrapeCreators platforms, where `N` is the sum of fixed route counts per keyword. Credits appear only when the provider reports them. X request accounting is unchanged and not included in this ScrapeCreators count.
12. **Partial failure.** Keeping sibling routes when one route fails remains an explicit gated decision outside this plan. The current fetch fails the source attempt when a route fails; this plan does not change that behavior.

## Milestones and Task Map

- **M1 — routing and intent contract:** Tasks 1, 2, 3, 4, 5, 9.
- **M2 — deterministic relevance engine:** Task 6.
- **M3 — data model and store:** Tasks 7, 8.
- **M4 — UI counts and settings:** Tasks 10, 11.
- **M5 — QA gate and independent review:** Task 12.

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `apps/worker/sentiment_monitor/intent.py` | Canonical keyword text, explicit intent parsing, `Keyword(str)` carrier, hashtag compacting. |
| Create | `apps/worker/sentiment_monitor/sources/routes.py` | Fixed `(platform, intent)` route whitelist, request params, coarse-window overlap helper, request count. |
| Create | `apps/worker/sentiment_monitor/relevance.py` | Pure NFKC/casefold/boundary text-match statuses. |
| Modify | `apps/worker/sentiment_monitor/sources/scrapecreators.py` | Omit `region` unless explicitly supplied. |
| Modify | `apps/worker/sentiment_monitor/sources/threads.py` | Intent-aware Threads route, route provenance, no region. |
| Modify | `apps/worker/sentiment_monitor/sources/instagram.py` | Phrase-only reels or hashtag-only route, route provenance, no region. |
| Modify | `apps/worker/sentiment_monitor/sources/tiktok.py` | Phrase keyword+top or hashtag route, documented date params, route provenance, no region. |
| Modify | `apps/worker/sentiment_monitor/pg_store.py` | Project-scoped mention upsert, `matched_variants` union, association upsert in the mention/cursor transaction. |
| Modify | `apps/worker/sentiment_monitor/scheduler.py` | Load stored intents, pass `Keyword`, log route plan count, preserve telemetry. |
| Create | `apps/worker/tests/test_intent.py` | Intent parsing and `Keyword` tests. |
| Create | `apps/worker/tests/test_routes.py` | Route whitelist, params, overlap, request-count tests. |
| Create | `apps/worker/tests/test_relevance.py` | Boundary, hashtag, empty-text, and punctuation tests. |
| Modify | `apps/worker/tests/test_scrapecreators.py` | No-region default and explicit-region compatibility. |
| Modify | `apps/worker/tests/test_threads_source.py` | Threads phrase/hashtag route tests. |
| Modify | `apps/worker/tests/test_instagram_source.py` | Phrase-only and hashtag-only route tests. |
| Modify | `apps/worker/tests/test_tiktok_source.py` | Phrase two-route and hashtag one-route tests. |
| Modify | `apps/worker/tests/test_pg_store.py` | Atomic association, union, and status tests. |
| Modify | `apps/worker/tests/test_postgres16.py` | Two-project same-post and tenant-isolation coverage. |
| Modify | `apps/worker/tests/test_scheduler.py` | Intent loading and collection-plan log tests. |
| Create | `apps/web/src/domain/keyword-intent.ts` | Web mirror of intent parsing, hashtag compacting, labels, request count. |
| Create | `apps/web/src/domain/keyword-intent.test.ts` | Web intent/request-count tests. |
| Create | `apps/web/src/monitor/relevance.ts` | `TextMatch` type, status mapping, count function, labels. |
| Create | `apps/web/src/monitor/relevance.test.ts` | Mapping and count tests. |
| Create | `apps/web/src/components/monitor/text-match-summary.tsx` | Shared honest count summary. |
| Create | `apps/web/src/components/monitor/text-match-summary.test.tsx` | Summary copy and number tests. |
| Create | `apps/web/src/db/sql/011_search_intent_and_relevance.sql` | Future additive migration; described in Task 7 only during planning. |
| Create | `apps/web/src/db/search-intent-schema.test.ts` | PGlite schema, intent, project-scoped uniqueness, association tests. |
| Modify | `apps/web/src/ingest/mentions.ts` | Project-scoped dedup query; `matched_variants` union. |
| Create | `apps/web/src/ingest/mentions.test.ts` | Same-post-two-projects web ingestion test. |
| Modify | `apps/web/src/monitor/load.ts` | Read keyword intents and association statuses. |
| Modify | `apps/web/src/monitor/present.ts` | Derive and expose `textMatch`. |
| Modify | `apps/web/src/monitor/dashboard.ts` | Add text-match counts to the dashboard model. |
| Modify | `apps/web/src/components/dashboard-screen.tsx` | Render shared text-match summary. |
| Modify | `apps/web/src/components/monitor/mentions-view.tsx` | Render shared summary and per-row label. |
| Modify | `apps/web/src/components/monitor/settings-form.tsx` | Intent labels, Threads disclosure, request count. |
| Modify | `apps/web/src/app/proyek/[id]/pengaturan/page.tsx` | Pass keyword intents to settings. |
| Modify | `apps/web/src/projects/handlers.ts` | Persist intent; accept legacy strings and explicit keyword objects. |
| Modify | `apps/web/src/app/proyek/actions.ts` | Carry keyword intent objects through the server action. |
| Modify | `apps/web/src/projects/save-sources.test.ts` | Intent persistence tests. |
| Modify | `apps/web/src/components/monitor/settings-form.test.tsx` | Intent label and request-count tests. |
| Modify | `apps/web/src/monitor/monitor.test.ts` | Loader/present/dashboard text-match tests. |
| Modify | `apps/web/src/components/dashboard-screen.test.tsx` | Dashboard summary test and fixture update. |

---

### Task 1: Worker keyword intent and fixed route whitelist

**Files:**
- Create: `apps/worker/sentiment_monitor/intent.py`
- Create: `apps/worker/sentiment_monitor/sources/routes.py`
- Test: `apps/worker/tests/test_intent.py`
- Test: `apps/worker/tests/test_routes.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VALID_INTENTS = ("phrase", "hashtag")`.
- Produces: `canonical_keyword_text(raw: str) -> str`.
- Produces: `parse_keyword(raw: str, intent: str | None = None) -> tuple[str, str]`.
- Produces: `hashtag_term(raw: str) -> str`.
- Produces: `class Keyword(str)` with attribute `intent: str`.
- Produces: `Route` dataclass with `id, source, intent, path, query_param, date_param, date_value, disclosure`.
- Produces: `routes_for(source: str, keyword: Keyword) -> tuple[Route, ...]`.
- Produces: `request_params(route: Route, keyword: Keyword) -> dict[str, str]`.
- Produces: `within_overlap(posted_at: str | None, collected_at: str, route: Route) -> bool`.
- Produces: `scrapecreators_request_count(keywords: list[Keyword], sources: list[str]) -> int`.

- [ ] **Step 1: Write the failing intent and route tests**

Create `apps/worker/tests/test_intent.py`:

```python
from sentiment_monitor.intent import Keyword, hashtag_term, parse_keyword


def test_explicit_intent_wins_even_when_text_starts_with_hash():
    assert parse_keyword("#lama", "phrase") == ("#lama", "phrase")
    assert parse_keyword("#baru", None) == ("#baru", "hashtag")
    assert parse_keyword("Kopi  Kenangan", "hashtag") == ("Kopi Kenangan", "hashtag")


def test_a_lone_hash_is_a_phrase_not_a_hashtag():
    assert parse_keyword("#") == ("#", "phrase")


def test_keyword_is_a_string_that_carries_intent():
    keyword = Keyword("#Kopi", "hashtag")
    assert keyword == "#Kopi"
    assert keyword.intent == "hashtag"
    assert isinstance(keyword, str)


def test_hashtag_term_compacts_unicode_letters_digits_and_underscore():
    assert hashtag_term("#Kopi Kenangan!") == "kopikenangan"
    assert hashtag_term("  @kopi_kenangan ") == "kopi_kenangan"
    assert hashtag_term("#CAFÉ") == "café"
```

Create `apps/worker/tests/test_routes.py`:

```python
from sentiment_monitor.intent import Keyword
from sentiment_monitor.sources.routes import (
    request_params,
    routes_for,
    scrapecreators_request_count,
    within_overlap,
)


def test_route_whitelist_is_fixed_per_platform_and_intent():
    assert [r.id for r in routes_for("threads", Keyword("kopi", "phrase"))] == ["threads.keyword"]
    assert [r.id for r in routes_for("threads", Keyword("#kopi", "hashtag"))] == ["threads.hashtag_text"]
    assert [r.id for r in routes_for("instagram", Keyword("kopi", "phrase"))] == ["instagram.reels"]
    assert [r.id for r in routes_for("instagram", Keyword("#kopi", "hashtag"))] == ["instagram.hashtag"]
    assert [r.id for r in routes_for("tiktok", Keyword("kopi", "phrase"))] == ["tiktok.keyword", "tiktok.top"]
    assert [r.id for r in routes_for("tiktok", Keyword("#kopi", "hashtag"))] == ["tiktok.hashtag"]
    assert routes_for("threads", Keyword("#kopi", "hashtag"))[0].disclosure == (
        "Threads has no hashtag search; searched as text"
    )


def test_request_params_use_documented_windows_and_never_region():
    phrase = Keyword("Kopi Kenangan", "phrase")
    assert request_params(routes_for("threads", phrase)[0], phrase) == {"query": "Kopi Kenangan"}
    assert request_params(routes_for("instagram", phrase)[0], phrase) == {
        "query": "Kopi Kenangan",
        "date_posted": "last-week",
    }
    tiktok_keyword, tiktok_top = routes_for("tiktok", phrase)
    assert request_params(tiktok_keyword, phrase) == {
        "query": "Kopi Kenangan",
        "date_posted": "this-week",
    }
    assert request_params(tiktok_top, phrase) == {
        "query": "Kopi Kenangan",
        "publish_time": "this-week",
    }


def test_hashtag_params_are_compact_but_threads_keeps_the_literal_hash():
    hashtag = Keyword("#Kopi Kenangan", "hashtag")
    assert request_params(routes_for("instagram", hashtag)[0], hashtag) == {
        "hashtag": "kopikenangan",
        "date_posted": "last-week",
    }
    assert request_params(routes_for("tiktok", hashtag)[0], hashtag) == {"hashtag": "kopikenangan"}
    assert request_params(routes_for("threads", hashtag)[0], hashtag) == {"query": "#Kopi Kenangan"}


def test_request_count_is_keywords_times_fixed_routes():
    keywords = [Keyword("kopi", "phrase"), Keyword("#kopi", "hashtag")]
    assert scrapecreators_request_count(keywords, ["threads", "instagram", "tiktok"]) == 7
    assert scrapecreators_request_count([Keyword("kopi", "phrase")], ["x"]) == 0


def test_local_overlap_keeps_undated_and_threads_items():
    threads = routes_for("threads", Keyword("kopi", "phrase"))[0]
    instagram = routes_for("instagram", Keyword("kopi", "phrase"))[0]
    assert within_overlap(None, "2026-11-08T00:00:00Z", threads) is True
    assert within_overlap("2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z", instagram) is True
    assert within_overlap("2026-10-30T00:00:00Z", "2026-11-08T00:00:00Z", instagram) is False
    assert within_overlap("2020-01-01T00:00:00Z", "2026-11-08T00:00:00Z", threads) is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_intent.py apps/worker/tests/test_routes.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'sentiment_monitor.intent'` and the same for `sentiment_monitor.sources.routes`.

- [ ] **Step 3: Implement `intent.py` and `routes.py`**

`intent.py` implements the exact signatures with `unicodedata.normalize("NFKC", ...)`, `str.casefold()`, and `ch.isalnum() or ch == "_"` for hashtag compacting. `Keyword.__new__` rejects any intent outside `VALID_INTENTS` with `ValueError("keyword_intent")`.

`routes.py` uses this exact route table (the values are the proposed contract):

```python
_ROUTES = {
    ("threads", "phrase"): (
        Route("threads.keyword", "threads", "phrase", "/v1/threads/search", "query"),
    ),
    ("threads", "hashtag"): (
        Route(
            "threads.hashtag_text",
            "threads",
            "hashtag",
            "/v1/threads/search",
            "query",
            disclosure="Threads has no hashtag search; searched as text",
        ),
    ),
    ("instagram", "phrase"): (
        Route(
            "instagram.reels",
            "instagram",
            "phrase",
            "/v2/instagram/reels/search",
            "query",
            "date_posted",
            "last-week",
        ),
    ),
    ("instagram", "hashtag"): (
        Route(
            "instagram.hashtag",
            "instagram",
            "hashtag",
            "/v1/instagram/search/hashtag",
            "hashtag",
            "date_posted",
            "last-week",
        ),
    ),
    ("tiktok", "phrase"): (
        Route(
            "tiktok.keyword",
            "tiktok",
            "phrase",
            "/v1/tiktok/search/keyword",
            "query",
            "date_posted",
            "this-week",
        ),
        Route(
            "tiktok.top",
            "tiktok",
            "phrase",
            "/v1/tiktok/search/top",
            "query",
            "publish_time",
            "this-week",
        ),
    ),
    ("tiktok", "hashtag"): (
        Route("tiktok.hashtag", "tiktok", "hashtag", "/v1/tiktok/search/hashtag", "hashtag"),
    ),
}
```

`request_params` uses `hashtag_term` for `query_param == "hashtag"`, keeps the literal `#` for `threads.hashtag_text`, and otherwise uses `str(keyword)`. It never adds `region`. `within_overlap` uses `WINDOW_DAYS = {"last-week": 8, "this-week": 8}` and treats missing/unparseable timestamps as keep. `scrapecreators_request_count` sums `len(routes_for(source, keyword))` only for `SCRAPECREATORS_SOURCES = ("threads", "instagram", "tiktok")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command. Expected: all Task 1 tests PASS.

- [ ] **Step 5: Commit (future implementation only; do not run during planning)**

```bash
git add apps/worker/sentiment_monitor/intent.py apps/worker/sentiment_monitor/sources/routes.py apps/worker/tests/test_intent.py apps/worker/tests/test_routes.py
git commit -m "feat(worker): add keyword intent and fixed route whitelist"
```

---

### Task 2: Web keyword intent contract

**Files:**
- Create: `apps/web/src/domain/keyword-intent.ts`
- Test: `apps/web/src/domain/keyword-intent.test.ts`

**Interfaces:**
- Consumes: no earlier task.
- Produces: `type KeywordIntent = "phrase" | "hashtag"`.
- Produces: `type Keyword = { text: string; intent: KeywordIntent }`.
- Produces: `parseKeyword(raw: string): Keyword`.
- Produces: `normalizeHashtag(raw: string): string`.
- Produces: `keywordLabel(intent: KeywordIntent): "Kata kunci" | "Tagar"`.
- Produces: `requestCount(keywords: readonly Keyword[], sources: readonly string[]): number`.

- [ ] **Step 1: Write the failing web intent tests**

Create `apps/web/src/domain/keyword-intent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { keywordLabel, normalizeHashtag, parseKeyword, requestCount } from "./keyword-intent";

describe("keyword intent", () => {
  it("keeps an explicit hashtag and does not convert a phrase", () => {
    expect(parseKeyword("  #Kopi   Kenangan ")).toEqual({ text: "#Kopi Kenangan", intent: "hashtag" });
    expect(parseKeyword("Kopi Kenangan")).toEqual({ text: "Kopi Kenangan", intent: "phrase" });
    expect(parseKeyword("#")).toEqual({ text: "#", intent: "phrase" });
  });

  it("normalizes a hashtag for provider requests", () => {
    expect(normalizeHashtag("#Kopi Kenangan!")).toBe("kopikenangan");
    expect(normalizeHashtag("  @kopi_kenangan ")).toBe("kopi_kenangan");
    expect(normalizeHashtag("#CAFÉ")).toBe("café");
  });

  it("labels intent in plain Indonesian", () => {
    expect(keywordLabel("phrase")).toBe("Kata kunci");
    expect(keywordLabel("hashtag")).toBe("Tagar");
  });

  it("counts keywords times fixed ScrapeCreators routes", () => {
    expect(
      requestCount(
        [
          { text: "kopi", intent: "phrase" },
          { text: "#kopi", intent: "hashtag" },
        ],
        ["threads", "instagram", "tiktok"],
      ),
    ).toBe(7);
    expect(requestCount([{ text: "kopi", intent: "phrase" }], ["x"])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
(cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run src/domain/keyword-intent.test.ts)
```

Expected: FAIL with a module-resolution error for `./keyword-intent`.

- [ ] **Step 3: Implement `keyword-intent.ts`**

Use `canonicalKeywordText = raw.trim().replace(/\s+/g, " ")`. `parseKeyword` returns `hashtag` only when the canonical text starts with `#` and has length greater than one. `normalizeHashtag` uses NFKC, `toLocaleLowerCase("id-ID")`, strips leading `#`, and keeps Unicode letters, numbers, and `_`. `requestCount` uses this fixed proposed table:

```ts
const ROUTE_COUNT: Record<string, Record<"phrase" | "hashtag", number>> = {
  threads: { phrase: 1, hashtag: 1 },
  instagram: { phrase: 1, hashtag: 1 },
  tiktok: { phrase: 2, hashtag: 1 },
};
```

Return `0` for every source not in that table (`x` stays outside this ScrapeCreators count).

- [ ] **Step 4: Run the test to verify it passes**

Run the same command. Expected: PASS.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/web/src/domain/keyword-intent.ts apps/web/src/domain/keyword-intent.test.ts
git commit -m "feat(web): add keyword intent contract"
```

---

### Task 3: ScrapeCreators region cleanup and intent-aware Threads fetching

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/scrapecreators.py:123-166`
- Modify: `apps/worker/sentiment_monitor/sources/threads.py:25-124`
- Test: `apps/worker/tests/test_scrapecreators.py`
- Test: `apps/worker/tests/test_threads_source.py`

**Interfaces:**
- Consumes: `Keyword`, `routes_for`, `request_params`, `within_overlap` from Task 1.
- Produces: `fetch_scrapecreators_json(..., region: str | None = None, ...)` adds `region` only when not `None`.
- Produces: `fetch_threads_mentions(variant: str, api_key: str, collected_at: str, *, intent: str | None = None, opener=...) -> dict`.
- Every returned Threads mention carries `route_id`, and `_unpack_fetched` later carries `intent`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/tests/test_scrapecreators.py`:

```python
def test_region_is_omitted_by_default_and_added_only_when_requested():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response('{"posts": []}')

    fetch_scrapecreators_json("/v1/threads/search", {"query": "kopi"}, "key", opener=opener)
    fetch_scrapecreators_json("/v1/threads/search", {"query": "kopi"}, "key", region="ID", opener=opener)
    assert "region=" not in seen[0]
    assert "region=ID" in seen[1]
```

Add to `apps/worker/tests/test_threads_source.py`:

```python
def test_threads_phrase_uses_keyword_route_without_region():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"posts": [{"pk": "th-1"}]}))

    result = fetch_threads_mentions("Kopi Kenangan", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert len(seen) == 1
    assert seen[0].startswith("https://api.scrapecreators.com/v1/threads/search?")
    assert "query=Kopi+Kenangan" in seen[0]
    assert "region=" not in seen[0]
    assert result["mentions"][0]["route_id"] == "threads.keyword"


def test_threads_hashtag_uses_literal_text_search_with_route_provenance():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"posts": []}))

    result = fetch_threads_mentions("#Kopi", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    assert "query=%23Kopi" in seen[0]
    assert "region=" not in seen[0]
    assert result["mentions"] == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_scrapecreators.py apps/worker/tests/test_threads_source.py -v
```

Expected: FAIL because `region=ID` is still appended by default and `fetch_threads_mentions` has no `intent` parameter or `route_id` provenance.

- [ ] **Step 3: Implement the region cleanup and Threads route**

In `scrapecreators.py`, change the signature to `region: str | None = None` and build params with `merged_params = dict(params); if region is not None: merged_params["region"] = region`.

In `threads.py`, build a `Keyword` with `Keyword(variant, intent)` when `variant` is a plain string, otherwise reuse the `Keyword` instance. Resolve `route = routes_for("threads", keyword)[0]`, call `fetch_scrapecreators_json(route.path, request_params(route, keyword), ...)`, and add `item["route_id"] = route.id` to every normalized item. Filter with `within_overlap(item["posted_at"], collected_at, route)` before deduping. `ThreadsSource.fetch_page` passes `intent=getattr(query, "intent", "phrase")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command. Expected: all Task 3 tests PASS, and the existing Threads transport/status/credit tests still PASS after their `region=ID` assertions are changed to `assert "region=" not in url`.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/worker/sentiment_monitor/sources/scrapecreators.py apps/worker/sentiment_monitor/sources/threads.py apps/worker/tests/test_scrapecreators.py apps/worker/tests/test_threads_source.py
git commit -m "feat(worker): route Threads by intent and drop region"
```

---

### Task 4: Intent-aware Instagram fetching

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/instagram.py:86-175`
- Test: `apps/worker/tests/test_instagram_source.py`

**Interfaces:**
- Consumes: `Keyword`, `routes_for`, `request_params`, `within_overlap` from Task 1; `fetch_scrapecreators_json` from Task 3.
- Produces: `fetch_instagram_mentions(variant: str, api_key: str, collected_at: str, *, intent: str | None = None, opener=...) -> dict`.
- Produces: exactly one route per call: `instagram.reels` for phrase, `instagram.hashtag` for hashtag.

- [ ] **Step 1: Write the failing tests**

Replace the old two-route Instagram expectations with these single-route tests in `apps/worker/tests/test_instagram_source.py`:

```python
def test_instagram_phrase_calls_only_reels_without_region():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"reels": [{"pk": "ig-1", "caption": "Kopi"}]}))

    result = fetch_instagram_mentions("Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert len(seen) == 1
    assert seen[0].startswith("https://api.scrapecreators.com/v2/instagram/reels/search?")
    assert "query=Kopi" in seen[0]
    assert "date_posted=last-week" in seen[0]
    assert "region=" not in seen[0]
    assert result["mentions"][0]["route_id"] == "instagram.reels"


def test_instagram_hashtag_calls_only_hashtag_with_compact_term():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"posts": [{"pk": "ig-2", "caption": "#Kopi"}]}))

    result = fetch_instagram_mentions("#Kopi Kenangan", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    assert len(seen) == 1
    assert seen[0].startswith("https://api.scrapecreators.com/v1/instagram/search/hashtag?")
    assert "hashtag=kopikenangan" in seen[0]
    assert "date_posted=last-week" in seen[0]
    assert "region=" not in seen[0]
    assert result["mentions"][0]["route_id"] == "instagram.hashtag"


def test_instagram_drops_a_stale_item_only_when_the_route_has_a_window():
    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        return Response(
            json.dumps(
                {
                    "reels": [
                        {"pk": "fresh", "taken_at": 1794096000},
                        {"pk": "stale", "taken_at": 1791417600},
                    ]
                }
            )
        )

    result = fetch_instagram_mentions("Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert [item["external_id"] for item in result["mentions"]] == ["fresh"]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_instagram_source.py -v
```

Expected: FAIL because Instagram still calls both reels and hashtag, sends `region=ID`, and has no `intent` parameter.

- [ ] **Step 3: Implement the single-route Instagram fetch**

Remove the unconditional reels-plus-hashtag sequence. Resolve `route = routes_for("instagram", keyword)[0]`; call only that route with `request_params`; normalize with `route_id`; filter with `within_overlap`; dedupe; return the same result envelope and the same `returned`/`parsed`/`deduplicated`/`credits_charged`/`http_status` keys. Update the local `_instagram` test helper to serve the single requested route instead of two payloads. Keep `normalize_hashtag` for compatibility, but the route params use `hashtag_term`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command. Expected: all Task 4 tests PASS. Delete assertions that assume two requests for every keyword; the remaining transport, timeout, malformed-envelope, credit, and status tests must still PASS for the single route.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/worker/sentiment_monitor/sources/instagram.py apps/worker/tests/test_instagram_source.py
git commit -m "feat(worker): route Instagram by keyword intent"
```

---

### Task 5: Intent-aware TikTok fetching

**Files:**
- Modify: `apps/worker/sentiment_monitor/sources/tiktok.py:58-118`
- Test: `apps/worker/tests/test_tiktok_source.py`

**Interfaces:**
- Consumes: `Keyword`, `routes_for`, `request_params`, `within_overlap` from Task 1; `fetch_scrapecreators_json` from Task 3.
- Produces: `fetch_tiktok_mentions(variant: str, api_key: str, collected_at: str, *, intent: str | None = None, opener=...) -> dict`.
- Produces: phrase = `tiktok.keyword` then `tiktok.top`; hashtag = `tiktok.hashtag` only.

- [ ] **Step 1: Write the failing tests**

Update the TikTok request tests and add a hashtag test in `apps/worker/tests/test_tiktok_source.py`:

```python
def test_tiktok_phrase_calls_keyword_and_top_with_documented_windows_without_region():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"search_item_list": []}))

    fetch_tiktok_mentions("Kopi", "key", "2026-11-08T00:00:00Z", intent="phrase", opener=opener)
    assert len(seen) == 2
    assert seen[0].startswith("https://api.scrapecreators.com/v1/tiktok/search/keyword?")
    assert "date_posted=this-week" in seen[0]
    assert seen[1].startswith("https://api.scrapecreators.com/v1/tiktok/search/top?")
    assert "publish_time=this-week" in seen[1]
    assert all("region=" not in url for url in seen)


def test_tiktok_hashtag_calls_only_the_hashtag_route():
    seen = []

    class Response(io.StringIO):
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(json.dumps({"search_item_list": [{"aweme_id": "tt-1", "desc": "#Kopi"}]}))

    result = fetch_tiktok_mentions("#Kopi", "key", "2026-11-08T00:00:00Z", intent="hashtag", opener=opener)
    assert len(seen) == 1
    assert seen[0].startswith("https://api.scrapecreators.com/v1/tiktok/search/hashtag?")
    assert "hashtag=kopi" in seen[0]
    assert "region=" not in seen[0]
    assert result["mentions"][0]["route_id"] == "tiktok.hashtag"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_tiktok_source.py -v
```

Expected: FAIL because TikTok still uses a hard-coded keyword+top loop, sends `region=ID`, and has no hashtag route or `intent` parameter.

- [ ] **Step 3: Implement the route loop**

Resolve `routes = routes_for("tiktok", keyword)`, iterate exactly those routes, call each with `request_params`, normalize with `route_id`, filter with `within_overlap`, accumulate counts, and dedupe. Phrase keeps two routes; hashtag keeps one. Remove `region` from every call. For the hashtag route, reuse `_extract_tiktok_list` with its existing key tuple.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command. Expected: all Task 5 tests PASS, including the existing malformed-list and partial-failure tests after their `region=ID` assertions are removed and `date_posted`/`publish_time` assertions are added.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/worker/sentiment_monitor/sources/tiktok.py apps/worker/tests/test_tiktok_source.py
git commit -m "feat(worker): route TikTok by keyword intent"
```

---

### Task 6: Deterministic text-match engine

**Files:**
- Create: `apps/worker/sentiment_monitor/relevance.py`
- Test: `apps/worker/tests/test_relevance.py`

**Interfaces:**
- Consumes: no earlier task.
- Produces: `MATCH_STATUSES = ("literal_match", "no_literal_match", "unknown_text")`.
- Produces: `normalize_match_text(value: str) -> str`.
- Produces: `literal_match_status(text: str, keyword: str, intent: str) -> str`.

- [ ] **Step 1: Write the failing relevance tests**

Create `apps/worker/tests/test_relevance.py`:

```python
import pytest

from sentiment_monitor.relevance import literal_match_status, normalize_match_text


def test_normalization_uses_nfkc_casefold_and_whitespace_collapse():
    assert normalize_match_text("  ＫＯＰＩ\tKenangan  ") == "kopi kenangan"


def test_phrase_matches_case_and_hash_prefix_but_not_a_longer_word():
    assert literal_match_status("Saya suka Indonesia", "Indonesia", "phrase") == "literal_match"
    assert literal_match_status("#Indonesia", "Indonesia", "phrase") == "literal_match"
    assert literal_match_status("Indonesian food", "Indonesia", "phrase") == "no_literal_match"


def test_phrase_multi_word_does_not_match_compact_hashtag():
    assert literal_match_status("Bank Mandiri buka cabang", "Bank Mandiri", "phrase") == "literal_match"
    assert literal_match_status("#BankMandiri", "Bank Mandiri", "phrase") == "no_literal_match"
    assert literal_match_status("bankmandiri", "Bank Mandiri", "phrase") == "no_literal_match"


def test_hashtag_intent_matches_compact_forms_but_not_the_spaced_phrase():
    assert literal_match_status("#BankMandiri", "Bank Mandiri", "hashtag") == "literal_match"
    assert literal_match_status("bankmandiri", "Bank Mandiri", "hashtag") == "literal_match"
    assert literal_match_status("bank mandiri", "Bank Mandiri", "hashtag") == "no_literal_match"


def test_punctuation_and_symbol_boundaries_are_defined():
    assert literal_match_status("C++", "C++", "phrase") == "literal_match"
    assert literal_match_status("C++17", "C++", "phrase") == "no_literal_match"
    assert literal_match_status("C ++", "C++", "phrase") == "no_literal_match"


@pytest.mark.parametrize("text", ["", "   ", "\n\t"])
def test_empty_text_is_unknown_not_unmatched(text):
    assert literal_match_status(text, "Kopi", "phrase") == "unknown_text"
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_relevance.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'sentiment_monitor.relevance'`.

- [ ] **Step 3: Implement `relevance.py`**

`normalize_match_text` returns `" ".join(unicodedata.normalize("NFKC", value).casefold().split())`. Phrase matching uses `re.compile(rf"(?<!\w){re.escape(phrase)}(?!\w)", re.UNICODE)` after stripping one leading `#` from the keyword. Hashtag matching compacts the keyword to Unicode alphanumerics plus `_` and uses `re.compile(rf"(?<!\w)#?{re.escape(term)}(?!\w)", re.UNICODE)`. Return `unknown_text` for empty text or an empty comparison term; otherwise `literal_match` or `no_literal_match`.

- [ ] **Step 4: Run the test to verify it passes**

Run the same command. Expected: all Task 6 tests PASS.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/worker/sentiment_monitor/relevance.py apps/worker/tests/test_relevance.py
git commit -m "feat(worker): add deterministic text-match status"
```

---

### Task 7: Additive migration 011 and schema test

**Files:**
- Create: `apps/web/src/db/sql/011_search_intent_and_relevance.sql` (future implementation only; described here)
- Test: `apps/web/src/db/search-intent-schema.test.ts`

**Interfaces:**
- Consumes: existing `customers`, `projects`, `keyword_variants`, `mentions`.
- Produces: `keyword_variants.intent` default `'phrase'`.
- Produces: mention uniqueness `(customer_id, project_id, source, external_id)`.
- Produces: table `mention_keyword_associations` with status constraint and RLS policies.

- [ ] **Step 1: Write the failing PGlite schema test**

Create `apps/web/src/db/search-intent-schema.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "./migrate";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PROJECT_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";

async function seed(db: ReturnType<typeof pgliteQueryable>) {
  await db.query("insert into customers (id, customer_id, created_at) values ($1, $1, now())", [CUSTOMER]);
  await db.query(
    "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, 'A', now())",
    [PROJECT_A, CUSTOMER],
  );
  await db.query(
    "insert into projects (id, customer_id, brand_name, created_at) values ($1, $2, 'B', now())",
    [PROJECT_B, CUSTOMER],
  );
}

const INSERT_MENTION = `insert into mentions
  (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
  values (gen_random_uuid(), $1, $2, 'threads', 'same-post', 'kopi', null, null, now(), now(), array['kopi'], 'pending')`;

describe("search intent schema", () => {
  it("adds keyword intent, project-scoped mention uniqueness, and associations", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    await seed(db);
    const oldConstraint = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conname = 'mentions_customer_id_source_external_id_key'",
    );
    expect(oldConstraint.rows[0]?.n).toBe(0);
    const newConstraint = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conname = 'mentions_customer_id_project_id_source_external_id_key'",
    );
    expect(newConstraint.rows[0]?.n).toBe(1);
    await db.query(
      `insert into keyword_variants (id, customer_id, project_id, text, active, created_at, intent)
       values (gen_random_uuid(), $1, $2, '#kopi', true, now(), 'hashtag')`,
      [CUSTOMER, PROJECT_A],
    );
    const keywords = await db.query<{ intent: string }>(
      "select intent from keyword_variants where project_id = $1",
      [PROJECT_A],
    );
    expect(keywords.rows[0]?.intent).toBe("hashtag");

    await db.query(INSERT_MENTION, [CUSTOMER, PROJECT_A]);
    await db.query(INSERT_MENTION, [CUSTOMER, PROJECT_B]);
    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from mentions where customer_id = $1",
      [CUSTOMER],
    );
    expect(count.rows[0]?.n).toBe(2);
    await expect(db.query(INSERT_MENTION, [CUSTOMER, PROJECT_A])).rejects.toThrow();

    await db.query(
      `insert into mention_keyword_associations
         (id, customer_id, project_id, mention_id, keyword_text, intent, route_id, source, status, collected_at)
       select gen_random_uuid(), $1, $2, m.id, '#kopi', 'hashtag', 'instagram.hashtag', 'instagram', 'literal_match', now()
       from mentions m where m.project_id = $2`,
      [CUSTOMER, PROJECT_A],
    );
    const association = await db.query<{ status: string }>(
      "select status from mention_keyword_associations where project_id = $1",
      [PROJECT_A],
    );
    expect(association.rows[0]?.status).toBe("literal_match");

    // PGlite does not model role logins here. Task 8's
    // test_postgres16_worker_association_rejects_other_customer asserts that a
    // worker-context insert for a different customer is rejected by the
    // tenant-scoped worker policy.
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
(cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run src/db/search-intent-schema.test.ts)
```

Expected: FAIL because the `intent` column, the project-scoped unique constraint, and `mention_keyword_associations` do not exist.

- [ ] **Step 3: Create `011_search_intent_and_relevance.sql` with this exact proposed content**

```sql
-- PROPOSED DEFAULT — FOR USER REVIEW.
-- Add explicit keyword intent, project-scoped mention identity, and
-- per-keyword text-match associations. Existing rows keep working.

alter table keyword_variants
  add column intent text not null default 'phrase';

alter table keyword_variants
  add constraint keyword_variants_intent_check
  check (intent in ('phrase', 'hashtag'));

alter table mentions drop constraint if exists mentions_customer_id_source_external_id_key;

alter table mentions
  add constraint mentions_customer_id_project_id_source_external_id_key
  unique (customer_id, project_id, source, external_id);

create table mention_keyword_associations (
  id uuid primary key,
  customer_id uuid not null references customers (id),
  project_id uuid not null references projects (id),
  mention_id uuid not null references mentions (id) on delete cascade,
  keyword_text text not null,
  intent text not null,
  route_id text not null,
  source text not null,
  status text not null,
  collected_at timestamptz not null,
  constraint mention_keyword_associations_intent_check
    check (intent in ('phrase', 'hashtag')),
  constraint mention_keyword_associations_source_check
    check (source in ('x', 'threads', 'instagram', 'tiktok')),
  constraint mention_keyword_associations_status_check
    check (status in ('literal_match', 'no_literal_match', 'unknown_text')),
  unique (mention_id, keyword_text, route_id)
);

create index mention_keyword_associations_project_status_idx
  on mention_keyword_associations (customer_id, project_id, status);

alter table mention_keyword_associations enable row level security;
alter table mention_keyword_associations force row level security;

grant select on mention_keyword_associations to app_user;
grant select, insert, update on mention_keyword_associations to worker_role;

create policy mention_keyword_associations_tenant on mention_keyword_associations
  for select to app_user
  using (customer_id = current_setting('app.customer_id', true)::uuid);

create policy mention_keyword_associations_worker_select on mention_keyword_associations
  for select to worker_role
  using (customer_id = current_setting('app.customer_id', true)::uuid);

create policy mention_keyword_associations_worker_insert on mention_keyword_associations
  for insert to worker_role
  with check (customer_id = current_setting('app.customer_id', true)::uuid);

create policy mention_keyword_associations_worker_update on mention_keyword_associations
  for update to worker_role
  using (customer_id = current_setting('app.customer_id', true)::uuid)
  with check (customer_id = current_setting('app.customer_id', true)::uuid);
```

`CREATE POLICY` accepts one command per policy, so worker access is expressed as three tenant-scoped policies (`select`, `insert`, `update`). No delete grant is added.

- [ ] **Step 4: Run the test to verify it passes**

Run the same command. Expected: PASS. Existing migration checksum tests must not change because `001` through `010` are untouched.

- [ ] **Step 5: Commit (future implementation only; do not apply the migration to any environment)**

```bash
git add apps/web/src/db/sql/011_search_intent_and_relevance.sql apps/web/src/db/search-intent-schema.test.ts
git commit -m "feat(db): add search intent and mention association schema"
```

---

### Task 8: Worker store writes associations, unions variants, and keeps atomicity

**Files:**
- Modify: `apps/worker/sentiment_monitor/pg_store.py:78-150`
- Modify: `apps/worker/tests/test_pg_store.py`
- Modify: `apps/worker/tests/test_postgres16.py`
- Modify: `apps/web/src/ingest/mentions.ts:20-44`
- Create: `apps/web/src/ingest/mentions.test.ts`

**Interfaces:**
- Consumes: `literal_match_status` from Task 6; schema from Task 7.
- Produces: `write_mentions_and_cursor(..., mentions)` reads optional `intent`, `route_id`, `collected_at` keys.
- Produces: `saved` remains the count of inserted mention rows; conflicts update variants and associations without increasing `saved`.
- Produces: `ingestMention` queries uniqueness by `(customer_id, project_id, source, external_id)` and unions `matched_variants`.

- [ ] **Step 1: Write the failing store and ingest tests**

Add to `apps/worker/tests/test_pg_store.py`:

```python
class AssociationTx(Tx):
    def __init__(self, insert_result, lookup_result):
        super().__init__()
        self.insert_result = insert_result
        self.lookup_result = lookup_result

    def execute(self, sql, params=None):
        result = super().execute(sql, params)
        lowered = sql.lower()
        if "insert into mentions" in lowered:
            return self.insert_result
        if lowered.startswith("select id from mentions"):
            return self.lookup_result
        return result


def test_association_mention_and_cursor_share_one_commit():
    tx = AssociationTx([{"id": "m1"}], None)
    PostgresStore(tx).write_mentions_and_cursor(
        customer_id="customer-a",
        project_id="project-1",
        query_key="customer-a:project-1:kopi",
        source="threads",
        mentions=[{**MENTION, "variant": "kopi", "intent": "phrase", "route_id": "threads.keyword"}],
        next_cursor=None,
    )
    joined = "\n".join(tx.statements).lower()
    assert joined.index("insert into mentions") < joined.index("insert into mention_keyword_associations")
    assert joined.index("insert into mention_keyword_associations") < joined.index("source_cursors")
    assert joined.index("source_cursors") < joined.index("commit")


def test_conflicting_mention_unions_matched_variants_instead_of_keeping_only_the_first():
    tx = AssociationTx([], [{"id": "m1"}])
    PostgresStore(tx).write_mentions_and_cursor(
        customer_id="customer-a",
        project_id="project-1",
        query_key="q",
        source="threads",
        mentions=[{**MENTION, "variant": "kopi", "intent": "phrase", "route_id": "threads.keyword"}],
        next_cursor=None,
    )
    union_sql = next(sql for sql in tx.statements if "matched_variants ||" in sql)
    assert "array_agg(distinct value)" in union_sql


def test_association_status_is_literal_no_literal_or_unknown():
    for excerpt, expected in [
        ("Suka Indonesia", "literal_match"),
        ("Suka Indonesian", "no_literal_match"),
        ("", "unknown_text"),
    ]:
        tx = AssociationTx([{"id": "m"}], None)
        PostgresStore(tx).write_mentions_and_cursor(
            customer_id="customer-a",
            project_id="project-1",
            query_key="q",
            source="threads",
            mentions=[
                {
                    **MENTION,
                    "excerpt": excerpt,
                    "variant": "indonesia",
                    "intent": "phrase",
                    "route_id": "threads.keyword",
                }
            ],
            next_cursor=None,
        )
        _sql, params = next((sql, params) for sql, params in tx.calls if "mention_keyword_associations" in sql)
        assert params[7] == expected
```

Create `apps/web/src/ingest/mentions.test.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { registerOwner } from "../auth/accounts";
import { applyMigration, pgliteQueryable, withCustomer } from "../db/migrate";
import { createProject } from "../projects/handlers";
import { ingestMention } from "./mentions";

describe("mention ingestion", () => {
  it("keeps the same post in two projects of one customer and unions variants per project", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const owner = await registerOwner(db, { email: "ingest@example.com", password: "sandi-panjang" });
    const first = await createProject(db, owner.customerId, "Kopi Satu");
    const second = await createProject(db, owner.customerId, "Kopi Dua");
    const base = {
      customerId: owner.customerId,
      source: "threads" as const,
      externalId: "same-post",
      excerpt: "#Kopi",
      url: null,
      author: "ani",
      postedAt: "2026-11-01T00:00:00.000Z",
    };
    await ingestMention(db, { ...base, projectId: first.projectId, variant: "kopi" });
    const secondInsert = await ingestMention(db, { ...base, projectId: second.projectId, variant: "#kopi" });
    expect(secondInsert.result).toBe("inserted");
    const repeated = await ingestMention(db, { ...base, projectId: first.projectId, variant: "#kopi" });
    expect(repeated.result).toBe("deduped");
    const rows = await withCustomer(db, owner.customerId, () =>
      db.query<{ project_id: string; matched_variants: string[] }>(
        "select project_id, matched_variants from mentions where external_id = 'same-post' order by project_id",
      ),
    );
    expect(rows.rows).toHaveLength(2);
    const firstRow = rows.rows.find((row) => row.project_id === first.projectId);
    expect(firstRow?.matched_variants.sort()).toEqual(["#kopi", "kopi"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_pg_store.py -v
(cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run src/ingest/mentions.test.ts)
```

Expected: FAIL because the store has no association write or variant union, and web ingestion still queries uniqueness without `project_id`.

- [ ] **Step 3: Implement the store and ingest changes**

In `PostgresStore`, keep the existing transaction scope and `set_config`. For each mention:

1. Insert with `on conflict (customer_id, project_id, source, external_id) do nothing returning id`.
2. `saved += _returned_rows(...)` only for the insert result.
3. If no id was returned, run `select id from mentions where customer_id = %s and project_id = %s and source = %s and external_id = %s`.
4. When an id exists, run:

```sql
update mentions
set matched_variants = (
  select array_agg(distinct value)
  from unnest(matched_variants || %s::text[]) as value
)
where id = %s and customer_id = %s
```

5. Upsert:

```sql
insert into mention_keyword_associations (
  id, customer_id, project_id, mention_id, keyword_text, intent, route_id, source, status, collected_at
) values (
  gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, coalesce(%s, now())
)
on conflict (mention_id, keyword_text, route_id) do update
  set intent = excluded.intent,
      status = excluded.status,
      collected_at = excluded.collected_at
```

Pass `status = literal_match_status(excerpt, variant, intent)`, `intent = mention.get("intent") or getattr(mention["variant"], "intent", "phrase")`, and `route_id = mention.get("route_id") or f"{source}.keyword"`. Keep `record_source_success` after all mentions and before commit.

In `ingest/mentions.ts`, change the existing lookup and update predicates to include `project_id`. Keep the update of `matched_variants` as the union of existing and new text; do not write associations from the web path.

Add the PG16 two-project test to `apps/worker/tests/test_postgres16.py`:

```python
def test_postgres16_same_post_is_project_scoped_and_tenant_isolated(pg16):
    conn = pg16
    _seed(conn)
    project_b = "99999999-9999-4999-8999-999999999999"
    conn.execute(
        "insert into projects (id, customer_id, brand_name, created_at) values (%s, %s, 'kedai b', now())",
        (project_b, CUSTOMER_A),
    )
    for project_id in (PROJECT_A, project_b):
        conn.execute(
            """
            insert into mentions
              (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
            values
              (gen_random_uuid(), %s, %s, 'threads', 'same-post', 'kopi', null, null, now(), now(), array['kopi'], 'pending')
            """,
            (CUSTOMER_A, project_id),
        )
    count = conn.execute(
        "select count(*) from mentions where customer_id = %s and external_id = 'same-post'",
        (CUSTOMER_A,),
    ).fetchone()[0]
    assert count == 2
    conn.execute("begin")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_B,))
    conn.execute("set local role app_user")
    assert conn.execute("select count(*) from mentions where external_id = 'same-post'").fetchone()[0] == 0
    conn.rollback()


def test_postgres16_worker_association_rejects_other_customer(pg16):
    conn = pg16
    _seed(conn)
    mention_id = conn.execute(
        """
        insert into mentions
          (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
        values
          (gen_random_uuid(), %s, %s, 'threads', 'worker-policy', 'kopi', null, null, now(), now(), array['kopi'], 'pending')
        returning id
        """,
        (CUSTOMER_A, PROJECT_A),
    ).fetchone()[0]
    conn.commit()
    conn.execute("begin")
    conn.execute("select set_config('app.customer_id', %s::text, true)", (CUSTOMER_A,))
    conn.execute("set local role worker_role")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute(
            """
            insert into mention_keyword_associations
              (id, customer_id, project_id, mention_id, keyword_text, intent, route_id, source, status, collected_at)
            values
              (gen_random_uuid(), %s, %s, %s, 'kopi', 'phrase', 'threads.keyword', 'threads', 'literal_match', now())
            """,
            (CUSTOMER_B, PROJECT_A, mention_id),
        )
    conn.rollback()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the unit tests and, only when a disposable PG16 is available:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_pg_store.py -v
(cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run src/ingest/mentions.test.ts)
POSTGRES_TEST_URL="$POSTGRES_TEST_URL" PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_postgres16.py -v
```

Expected: PASS. The PG16 command skips when `POSTGRES_TEST_URL` is unset; that is still a passing run for local work.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/worker/sentiment_monitor/pg_store.py apps/worker/tests/test_pg_store.py apps/worker/tests/test_postgres16.py apps/web/src/ingest/mentions.ts apps/web/src/ingest/mentions.test.ts
git commit -m "feat: store per-keyword relevance and project-scoped mentions"
```

---

### Task 9: Worker scheduler carries intent, keeps telemetry, and logs the route plan

**Files:**
- Modify: `apps/worker/sentiment_monitor/scheduler.py:402-433,522-570,766-1000,1186-1242`
- Modify: `apps/worker/sentiment_monitor/collect.py:48-73`
- Test: `apps/worker/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `Keyword` from Task 1; `scrapecreators_request_count` from Task 1; store changes from Task 8.
- Produces: `load_active_variants(conn, project_id) -> list[Keyword]`.
- Produces: `serve(...)` logs one `collection_plan job_id=<id> project_id=<id> keywords=<n> routes=<n>` line per processed job.
- Existing `returned`, `parsed`, `deduplicated`, `saved`, `http_status`, and `credits_charged` lines keep their existing format.

- [ ] **Step 1: Write the failing scheduler tests**

Add to `apps/worker/tests/test_scheduler.py`:

```python
def test_load_active_variants_returns_keywords_with_stored_intent():
    class Conn:
        def execute(self, sql, params=None):
            return [
                {"text": "#kopi", "intent": "hashtag"},
                {"text": "kopi", "intent": "phrase"},
            ]

    variants = load_active_variants(Conn(), "project-1")
    assert [(str(item), item.intent) for item in variants] == [
        ("#kopi", "hashtag"),
        ("kopi", "phrase"),
    ]


def test_collection_plan_logs_keywords_and_fixed_route_count(tmp_path):
    world = LoopWorld(jobs=[_due_job()], variants=["kopi"], cursor=None)
    world.sources = ["threads", "instagram", "tiktok"]
    lines = []

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
            lambda _variant: {"mentions": []},
            log=lines.append,
            fetch_instagram=lambda _variant: {"mentions": []},
            fetch_tiktok=lambda _variant: {"mentions": []},
        )

    assert any(
        "collection_plan" in line and "keywords=1" in line and "routes=4" in line
        for line in lines
    )
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_scheduler.py -k "load_active_variants or collection_plan" -v
```

Expected: FAIL because `load_active_variants` returns plain strings without intent and no `collection_plan` line is emitted.

- [ ] **Step 3: Implement the scheduler plumbing**

Change `active_variants_sql()` to select `text, intent`. Change `load_active_variants` to return `Keyword(row["text"], row.get("intent") or "phrase")`; fake rows without `intent` remain `phrase`, preserving existing tests. In `__main__`, pass `intent=getattr(variant, "intent", "phrase")` to `fetch_threads_mentions`, `fetch_instagram_mentions`, and `fetch_tiktok_mentions`. In `fetch_x_with_cursor`, put `"intent": getattr(query, "intent", "phrase")` and `"route_id": "x.keyword"` into each X mention dict. In `_unpack_fetched`, add `row["intent"] = row.get("intent") or getattr(variant, "intent", "phrase")`.

After `sources` is computed and before the variant loop, build `plan_keywords = [Keyword(str(item), getattr(item, "intent", "phrase")) for item in job["variants"]]`, compute `routes = scrapecreators_request_count(plan_keywords, sources)`, and emit exactly one sanitized line:

```python
_safe_log(
    log,
    lambda: format_log(
        f"collection_plan job_id={job['id']} project_id={job['project_id']} "
        f"keywords={len(plan_keywords)} routes={routes}"
    ),
)
```

Do not add route counts to `_log_collection`; keep the F1-F4 line format unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run the targeted command and then the full scheduler file:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_scheduler.py -k "load_active_variants or collection_plan" -v
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests/test_scheduler.py -v
```

Expected: PASS. Existing scheduler tests still see string-compatible `Keyword` values and unchanged telemetry lines.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/worker/sentiment_monitor/scheduler.py apps/worker/sentiment_monitor/collect.py apps/worker/tests/test_scheduler.py
git commit -m "feat(worker): carry keyword intent through collection"
```

---

### Task 10: Web relevance counts and consistent display

**Files:**
- Create: `apps/web/src/monitor/relevance.ts`
- Create: `apps/web/src/monitor/relevance.test.ts`
- Create: `apps/web/src/components/monitor/text-match-summary.tsx`
- Create: `apps/web/src/components/monitor/text-match-summary.test.tsx`
- Modify: `apps/web/src/monitor/present.ts:11-61,80-181`
- Modify: `apps/web/src/monitor/load.ts:156-210,293-307,378-403`
- Modify: `apps/web/src/monitor/dashboard.ts:20-41,76-189`
- Modify: `apps/web/src/components/dashboard-screen.tsx:20-52,202-256`
- Modify: `apps/web/src/components/monitor/mentions-view.tsx:1-37,85-136,266-307`
- Test: `apps/web/src/monitor/monitor.test.ts`
- Test: `apps/web/src/components/dashboard-screen.test.tsx`

**Interfaces:**
- Consumes: association rows from Task 7/8.
- Produces: `type TextMatch = "literal_match" | "no_literal_match" | "unknown_text" | "legacy_unassessed"`.
- Produces: `textMatchOf(statuses: readonly string[]): TextMatch`.
- Produces: `type TextMatchCounts = { candidates: number; literal: number; unknown: number }`.
- Produces: `textMatchCounts(mentions: readonly { textMatch: TextMatch }[]): TextMatchCounts`.
- Produces: `TEXT_MATCH_LABEL` and `TextMatchSummary`.
- Produces: `StoredMention.associationStatuses: string[]` and `PresentedMention.textMatch: TextMatch`.
- Produces: `DashboardModel.textMatch: TextMatchCounts`.

- [ ] **Step 1: Write the failing web relevance tests**

Create `apps/web/src/monitor/relevance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { textMatchCounts, textMatchOf } from "./relevance";
import type { PresentedMention } from "./present";

function mention(textMatch: PresentedMention["textMatch"]): PresentedMention {
  return { textMatch } as PresentedMention;
}

describe("text match", () => {
  it("maps association statuses to one honest result", () => {
    expect(textMatchOf([])).toBe("legacy_unassessed");
    expect(textMatchOf(["no_literal_match"])).toBe("no_literal_match");
    expect(textMatchOf(["no_literal_match", "literal_match"])).toBe("literal_match");
    expect(textMatchOf(["no_literal_match", "unknown_text"])).toBe("unknown_text");
  });

  it("counts candidates, literal matches, and undecided rows", () => {
    expect(
      textMatchCounts([
        mention("literal_match"),
        mention("no_literal_match"),
        mention("unknown_text"),
        mention("legacy_unassessed"),
      ]),
    ).toEqual({ candidates: 4, literal: 1, unknown: 2 });
  });
});
```

Create `apps/web/src/components/monitor/text-match-summary.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TextMatchSummary } from "./text-match-summary";

afterEach(cleanup);

describe("text match summary", () => {
  it("shows the three proposed counts and the honest caption", () => {
    render(<TextMatchSummary counts={{ candidates: 12, literal: 7, unknown: 3 }} />);
    expect(screen.getByText("Kandidat 12 · Cocok teks 7 · Belum pasti 3")).toBeTruthy();
    expect(screen.getByText("Pencocokan teks, bukan verifikasi makna.")).toBeTruthy();
  });
});
```

Add to `apps/web/src/monitor/monitor.test.ts` in the `stored` helper and tests:

```ts
// Inside stored(): add this field to the returned object.
associationStatuses: [],

// New tests.
it("keeps a legacy mention unassessed instead of calling it unmatched", () => {
  expect(presentMention(stored({ associationStatuses: [] }), approved).textMatch).toBe("legacy_unassessed");
  expect(presentMention(stored({ associationStatuses: ["literal_match"] }), approved).textMatch).toBe("literal_match");
});

it("counts candidates, literal matches, and undecided rows in the same range", () => {
  const now = new Date("2026-11-01T03:00:00.000Z");
  const rows = [
    presentMention(stored({ id: "a", associationStatuses: ["literal_match"] }), approved),
    presentMention(stored({ id: "b", associationStatuses: ["no_literal_match"] }), approved),
    presentMention(stored({ id: "c", associationStatuses: ["unknown_text"] }), approved),
    presentMention(stored({ id: "d", associationStatuses: [] }), approved),
  ];
  const model = buildDashboard({
    mentions: rows,
    range: "7",
    source: "all",
    now,
    attentionUnread: 0,
    uncertainOpen: 0,
    partial: false,
  });
  expect(model.textMatch).toEqual({ candidates: 4, literal: 1, unknown: 2 });
});
```

Add a loader test in the `workspace loader` block:

```ts
it("loads association statuses and keeps a mention with none as legacy", async () => {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  const owner = await registerOwner(db, { email: "relevance@example.com", password: "sandi-panjang" });
  const project = await createProject(db, owner.customerId, "Kopi Uji");
  const matched = randomUUID();
  const legacy = randomUUID();
  await withCustomer(db, owner.customerId, async () => {
    for (const [id, external] of [
      [matched, "matched"],
      [legacy, "legacy"],
    ] as const) {
      await db.query(
        `insert into mentions (id, customer_id, project_id, source, external_id, excerpt, url, author, posted_at, collected_at, matched_variants, scoring_status)
         values ($1, $2, $3, 'threads', $4, 'Kopi', null, 'ani', '2026-11-01T00:00:00.000Z', '2026-11-01T00:05:00.000Z', array['kopi'], 'pending')`,
        [id, owner.customerId, project.projectId, external],
      );
    }
  });
  await db.query(
    `insert into mention_keyword_associations
       (id, customer_id, project_id, mention_id, keyword_text, intent, route_id, source, status, collected_at)
     values (gen_random_uuid(), $1, $2, $3, 'kopi', 'phrase', 'threads.keyword', 'threads', 'literal_match', now())`,
    [owner.customerId, project.projectId, matched],
  );
  const workspace = await loadWorkspace(
    db,
    owner.customerId,
    project.projectId,
    new Date("2026-11-01T03:00:00.000Z"),
    readLimits(),
  );
  const byId = new Map(workspace.mentions.map((item) => [item.id, item.textMatch]));
  expect(byId.get(matched)).toBe("literal_match");
  expect(byId.get(legacy)).toBe("legacy_unassessed");
});
```

Update `touchModel()` in `apps/web/src/components/dashboard-screen.test.tsx` to include:

```ts
textMatch: { candidates: 7, literal: 4, unknown: 2 },
```

Add a dashboard render test:

```tsx
it("shows the proposed text-match counts without claiming semantic verification", () => {
  render(
    <DashboardScreen
      {...base}
      brandName="QA Test Brand"
      model={touchModel()}
      collection={null}
    />,
  );
  expect(screen.getByText("Kandidat 7 · Cocok teks 4 · Belum pasti 2")).toBeTruthy();
  expect(screen.getByText("Pencocokan teks, bukan verifikasi makna.")).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
(cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run src/monitor/relevance.test.ts src/components/monitor/text-match-summary.test.tsx src/monitor/monitor.test.ts src/components/dashboard-screen.test.tsx)
```

Expected: FAIL because `monitor/relevance.ts`, `TextMatchSummary`, `associationStatuses`, `textMatch`, and `DashboardModel.textMatch` do not exist.

- [ ] **Step 3: Implement the relevance types, loader, and shared summary**

`monitor/relevance.ts` implements the mapping in this order: any `literal_match` -> `literal_match`; empty list -> `legacy_unassessed`; any `unknown_text` -> `unknown_text`; otherwise `no_literal_match`. `TEXT_MATCH_LABEL` is:

```ts
export const TEXT_MATCH_LABEL: Record<TextMatch, string> = {
  literal_match: "Cocok teks",
  no_literal_match: "Tidak cocok teks",
  unknown_text: "Belum pasti",
  legacy_unassessed: "Belum dinilai (data lama)",
};
```

In `load.ts`, select `assoc.statuses as association_statuses` through:

```sql
left join lateral (
  select array_agg(distinct a.status) as statuses
  from mention_keyword_associations a
  where a.mention_id = m.id and a.customer_id = m.customer_id
) assoc on true
```

Add `associationStatuses: asTextArray(row.association_statuses)` in `toStored`. In `present.ts`, add `textMatch: textMatchOf(row.associationStatuses)` to the base fields. In `dashboard.ts`, compute `const textMatch = textMatchCounts(current);` from the already range/source-filtered `current` rows and return it. In `dashboard-screen.tsx`, add a `Panel title="Relevansi teks"` containing `<TextMatchSummary counts={props.model?.textMatch ?? { candidates: 0, literal: 0, unknown: 0 }} />`. In `mentions-view.tsx`, compute `const textMatch = textMatchCounts(searched);` (the same query/sentiment/source/range-filtered rows used by the list), render `<TextMatchSummary counts={textMatch} />` above the list, and add `{TEXT_MATCH_LABEL[mention.textMatch]}` as a badge in `MentionLine`. The dashboard counts use the same rows its score already uses; the Sebutan counts use the same rows its list already uses, including its stored-text query filter. Undated rows follow each screen's existing list rule.

`TextMatchSummary` renders exactly:

```tsx
<p className="tabular-nums">
  Kandidat {formatNumber(counts.candidates)} · Cocok teks {formatNumber(counts.literal)} · Belum pasti {formatNumber(counts.unknown)}
</p>
<p className="mt-1 text-xs text-muted-foreground">Pencocokan teks, bukan verifikasi makna.</p>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command. Expected: PASS. Then run the full web suite to catch any fixture that now needs `associationStatuses` or `textMatch`. The existing pending/scoring tests must remain unchanged, proving text match does not alter scoring eligibility or the pending count.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/web/src/monitor/relevance.ts apps/web/src/monitor/relevance.test.ts apps/web/src/components/monitor/text-match-summary.tsx apps/web/src/components/monitor/text-match-summary.test.tsx apps/web/src/monitor/present.ts apps/web/src/monitor/load.ts apps/web/src/monitor/dashboard.ts apps/web/src/components/dashboard-screen.tsx apps/web/src/components/monitor/mentions-view.tsx apps/web/src/monitor/monitor.test.ts apps/web/src/components/dashboard-screen.test.tsx
git commit -m "feat(web): show honest text-match counts"
```

---

### Task 11: Settings persist intent and disclose request count

**Files:**
- Modify: `apps/web/src/projects/handlers.ts:30-168`
- Modify: `apps/web/src/app/proyek/actions.ts:11-30`
- Modify: `apps/web/src/monitor/load.ts:12-21,51-71,270-292,309-312,378-403`
- Modify: `apps/web/src/components/monitor/settings-form.tsx:13-113`
- Modify: `apps/web/src/app/proyek/[id]/pengaturan/page.tsx:33-40`
- Test: `apps/web/src/projects/save-sources.test.ts`
- Test: `apps/web/src/components/monitor/settings-form.test.tsx`

**Interfaces:**
- Consumes: `parseKeyword`, `keywordLabel`, `requestCount` from Task 2; `keyword_variants.intent` from Task 7.
- Produces: `type KeywordInput = string | { text: string; intent: KeywordIntent }`.
- Produces: `saveProjectConfiguration` accepts `variants: KeywordInput[]`.
- Produces: `replaceActiveVariants` writes `(text, intent)`.
- Produces: `Workspace.keywordIntents: Record<string, KeywordIntent>`.
- Produces: settings copy `{N} permintaan per pengumpulan` and the Threads disclosure.

- [ ] **Step 1: Write the failing settings and persistence tests**

Add to `apps/web/src/projects/save-sources.test.ts`:

```ts
it("stores explicit intent and keeps a legacy hash keyword as a phrase", async () => {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  const owner = await registerOwner(db, { email: "intent@example.com", password: "sandi-panjang" });
  const project = await createProject(db, owner.customerId, "Kedai Contoh");
  const saved = await saveProjectConfiguration(
    db,
    owner.customerId,
    {
      projectId: project.projectId,
      brandName: "Kedai Contoh",
      variants: [
        { text: "#Kopi", intent: "hashtag" },
        { text: "#lama", intent: "phrase" },
      ],
      sources: ["x"],
      schedule: { mode: "off", intervalHours: 6 },
    },
    readLimits(),
    { x: true, threads: false },
  );
  expect(saved.ok).toBe(true);
  const rows = await withCustomer(db, owner.customerId, () =>
    db.query<{ text: string; intent: string }>(
      "select text, intent from keyword_variants where project_id = $1 order by text",
      [project.projectId],
    ),
  );
  expect(rows.rows).toEqual([
    { text: "#lama", intent: "phrase" },
    { text: "#kopi", intent: "hashtag" },
  ]);
});
```

Add to `apps/web/src/components/monitor/settings-form.test.tsx`:

```tsx
it("shows intent in plain words, the Threads disclosure, and the request count", () => {
  render(
    <SettingsForm
      projectId="p1"
      brandName="QA Test Brand"
      keywords={["kopi", "#kopi"]}
      keywordIntents={{ kopi: "phrase", "#kopi": "hashtag" }}
      sources={["threads", "instagram", "tiktok"]}
      schedule={{ mode: "off", intervalHours: 6 }}
      credentials={{ x: false, threads: true, instagram: true, tiktok: true }}
    />,
  );
  expect(screen.getByText("Kata kunci: kopi")).toBeTruthy();
  expect(screen.getByText("Tagar: #kopi")).toBeTruthy();
  expect(screen.getByText("7 permintaan per pengumpulan")).toBeTruthy();
  expect(screen.getByText("Threads tidak punya pencarian tagar; tagar dicari sebagai teks.")).toBeTruthy();
  expect(screen.getByText("Instagram frasa mencari reel yang terindeks Google; tagar memakai pencarian tagar.")).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
(cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run src/projects/save-sources.test.ts src/components/monitor/settings-form.test.tsx)
```

Expected: FAIL because handlers accept only strings, settings has no intent labels/request count/disclosure, and `Workspace.keywordIntents` does not exist.

- [ ] **Step 3: Implement intent persistence and settings UI**

In `handlers.ts`, add `KeywordInput` and a helper `asKeywords(values)` that normalizes text with `normalizeVariant` and preserves an explicit `intent`; a plain string uses `parseKeyword(text)`. Validate the extracted texts with `validateVariantList`, keep `effectOfKeywordEdit`, and pass `Keyword[]` to `replaceActiveVariants`. `replaceActiveVariants` inserts `intent` alongside `text` and updates both columns on conflict. `saveActiveVariants` uses the same helper.

In `load.ts`, query `select text, intent from keyword_variants where project_id = $1 and active order by created_at, text`, keep `keywords: string[]`, and add `keywordIntents: Record<string, KeywordIntent>` in both the no-project and normal return paths. In the settings page, pass `keywordIntents={workspace.keywordIntents}`.

In `actions.ts`, change the input type to `variants: KeywordInput[]`.

In `settings-form.tsx`, keep local state as `Keyword[]`. Initialize each existing keyword with `props.keywordIntents?.[text] ?? parseKeyword(text).intent`. On add, use `parseKeyword(draft)` and reject duplicate `text` after `normalizeVariant`. Render each chip as `{keywordLabel(item.intent)}: {item.text}`. On submit, send `variants: keywords`. Compute `const requests = requestCount(keywords, workingSources(sources, props.credentials));` and render `{requests} permintaan per pengumpulan` with the caption `Jumlah ini adalah kata kunci × rute tetap; kredit hanya ditampilkan bila penyedia melaporkannya.` Add the exact Threads disclosure string and the exact Instagram limitation string from the test in the keyword panel.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command, then the full web suite and typecheck. Expected: PASS.

- [ ] **Step 5: Commit (future implementation only)**

```bash
git add apps/web/src/projects/handlers.ts apps/web/src/app/proyek/actions.ts apps/web/src/monitor/load.ts apps/web/src/components/monitor/settings-form.tsx apps/web/src/app/proyek/[id]/pengaturan/page.tsx apps/web/src/projects/save-sources.test.ts apps/web/src/components/monitor/settings-form.test.tsx
git commit -m "feat(web): persist keyword intent and disclose request count"
```

---

### Task 12: Milestone QA gate and independent review

**Files:**
- Modify: none during planning.
- Verify: the files changed by Tasks 1-11.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: a reviewable QA record. No production action is authorized by this task.

- [ ] **Step 1: Run the worker suite**

Run:

```bash
PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest apps/worker/tests -q
```

Expected: all worker tests PASS. The historical baseline was 205 tests before this work; the count is higher now. No provider calls are made.

- [ ] **Step 2: Run the web suite, typecheck, lint, and build under Node 24**

Run:

```bash
(cd apps/web && npx -y node@24 node_modules/vitest/vitest.mjs run)
(cd apps/web && npx -y node@24 node_modules/.bin/next typegen)
(cd apps/web && npx -y node@24 node_modules/typescript/bin/tsc --noEmit)
(cd apps/web && npx -y node@24 node_modules/eslint/bin/eslint.js .)
(cd apps/web && npx -y node@24 node_modules/.bin/next build)
```

Expected: all web tests PASS (the historical baseline was 300 tests plus 13 integration skips; new tests increase the count), typecheck and lint are clean, and the production build succeeds. PG integration files skip when `POSTGRES_TEST_URL` is unset; that is expected locally.

- [ ] **Step 3: Run the disposable PG16 integration gate when a server is available**

Start a disposable non-superuser PG16 under `.tooling/` and run:

```bash
env -i PATH=/usr/bin:/bin HOME=$PWD/.tooling POSTGRES_TEST_URL="$POSTGRES_TEST_URL" POSTGRES_TEST_LOG_PATH="$PWD/.tooling/postgres.log" PYTHONPATH=apps/worker .tooling/venv/bin/python -m pytest -q -p no:cacheprovider apps/worker/tests/test_postgres16.py
```

Expected: PASS, including the same-post-two-projects test, tenant isolation, and migration application. Stop and remove the disposable server afterward. Do not point this at production.

- [ ] **Step 4: Manual QA checklist (no provider calls required for the first four items)**

- A phrase keyword produces one Threads request, one Instagram reels request, and two TikTok requests (keyword + top); a hashtag keyword produces one request per platform.
- Request URLs contain no `region=` parameter.
- Threads hashtag search shows the disclosure `Threads tidak punya pencarian tagar; tagar dicari sebagai teks.` and does not claim a hashtag endpoint.
- Instagram phrase search shows the reels/Google-indexed limitation; Instagram hashtag search uses the hashtag route only.
- `Indonesia` versus `Indonesian`, `Bank Mandiri` versus `#BankMandiri`/`bankmandiri`, and `C++` versus `C++17` produce the statuses in Task 6.
- An empty caption is `Belum pasti`, not `Tidak cocok teks`, and its mention remains visible.
- A legacy mention with no association row shows `Belum dinilai (data lama)` and remains counted in `Kandidat`.
- Sebutan and the dashboard show the same `Kandidat`/`Cocok teks`/`Belum pasti` numbers for the same range, source, sentiment, and query filters.
- The same provider post collected for two projects of one customer appears in both projects with independent labels; a different customer still cannot see it.
- Credits show only when the provider reported a value; no price or quota is invented.
- Pending scoring copy and the meaning of `Menunggu penilaian` are unchanged.

- [ ] **Step 5: Independent QA and production approval gate**

Dispatch an independent QA Tester to review the future implementation against this plan and the brief. QA records findings; it does not deploy. Every production action (applying migration 011, deploying the worker, deploying the web app, merging the branch) needs a separate explicit user approval. Do not run the migration, deploy, merge, or push as part of this plan's verification.

- [ ] **Step 6: Final commit (future implementation only) if the user asks for it**

```bash
git add apps/worker apps/web docs/superpowers/plans/2026-11-08-search-intent-and-relevance.md
git commit -m "feat: add search intent and deterministic text relevance"
```

---

## Deferred and Explicitly Out of Scope

- Keeping sibling routes when one ScrapeCreators route fails is a gated decision. This plan keeps the current fail-the-source-attempt behavior.
- Instagram `/v1/instagram/search/popular` is not added. It remains a future optional route.
- Threads date parameters are not used until the provider date format, timezone, and inclusivity are verified. No Threads cursor or fake pagination is added.
- Semantic or AI relevance routing is out of scope. The only output is deterministic `text match`; the UI never says `semantically verified`.
- Scoring-service deployment is out of scope. Only the scoring-eligibility contract and honest pending counts are defined.
- No destructive backfill, no paid refetch, no deletion of non-matching candidates, and no invented credit pricing or quotas.
- The existing Sebutan search box continues to filter already-stored mention text; it does not issue provider searches.
