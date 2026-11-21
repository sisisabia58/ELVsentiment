# Cari Platform Pagination and Original Post Links Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement and verify each task.

**Goal.** Let people open original posts from Cari and request another page from one social platform without rerunning the whole search.

**Baseline.** `feature/cari-pantau-triage` at `0617b9e`. Cari snapshots already include a stored post URL. `ResultsList` renders titles as plain text. The ScrapeAtlas Instagram and X adapters can receive a cursor, but the generic fetch and search snapshot paths do not persist or expose a usable continuation.

**Design.** Ship original-post links independently. For “+ More,” reuse the existing worker, source route, filters, relevance checks, canonical identity, and provider cost ledger. Keep the feature in the existing Cari interface. Start with confirmed continuation routes and expand platform coverage from captured fixtures and staging evidence.

## Product behavior

- Make the heading and thumbnail area a single keyboard-accessible link when a verified original post URL exists. Use the platform’s normal HTTPS permalink in a new tab with `noopener noreferrer`. The phone or operating system can decide whether to open its native app. Keep replies and their controls outside that link.
- Put one “+ More” action per eligible source in the coverage panel and a “Cari lagi di TikTok” action in the TikTok results view, with equivalent platform names elsewhere. Both surfaces share the same request state. Keep “show more already loaded” free and distinct if result previews are introduced.
- A request fetches one more page from the selected platform using the saved query, intent, date, language, sort, and provider route. Existing posts stay visible while it runs. Merge unique relevant hits into the same search, update source totals and ranking, and preserve existing row IDs and citation anchors.
- Keep price and new user-facing charges out of this release. Limit extra requests per source and tenant, and record the provider’s reported usage separately, including zero and unknown.
- Do not add comments or regenerate the existing AI summary automatically on a page fetch. Label the existing summary as based on the original results once additions are visible. Protect previous citations and scope counts from the saved evidence rather than the expanded result total.
- A result without a usable permalink stays readable. A search without a verified continuation, including older searches without saved cursor data, still supports original links. An expired or exhausted continuation shows a clear unavailable state.

## Route proof before enabling

| Platform | ScrapeAtlas request contract from the checked API spec | Enable in Cari when |
|---|---|---|
| TikTok | `/v1/tiktok/search/keyword` accepts `cursor` and `search_id` | Native continuation pair is verified and both are carried together |
| Instagram | `/v1/instagram/search/posts` accepts `cursor` | The response supplies a usable token. Verify behavior for web-index results independently |
| X | `/v1/twitter/search/posts` accepts `cursor` | The response supplies a usable token and the route can continue the same query |
| YouTube | `/v1/youtube/search` accepts `continuationToken` | A first-page and second-page fixture prove the actual response mapping |
| Reddit | `/v1/reddit/search` accepts `after` | A first-page and second-page fixture prove the actual response mapping |
| Facebook | `/v1/facebook/hashtag` accepts `cursor` | Only on eligible hashtag searches when a token exists |
| LinkedIn | `/v1/linkedin/search/posts` accepts `cursor` | Native or web-index continuation is verified for the returned result mode |
| Threads | `/v1/threads/search` documents date bounds and lacks a continuation token | Evaluate separately whether a bounded search for older posts can preserve the filters without gaps or repeated pages |

The table records API capabilities. A route returning a usable continuation in practice is a separate requirement. Verify with current provider documentation and bounded staging runs for `mandalika parfum` and a Facebook hashtag. No provider calls are needed to deliver original-post links.

## Task 1. Open original posts

**Files.** Add `apps/web/src/monitor/search/post-permalink.ts`. Modify `apps/web/src/components/monitor/cari/results-list.tsx`, `quote-source.ts`, and provider normalizers under `apps/worker/sentiment_monitor/providers/` only where a reliable native URL needs to be recovered. Extend `results-list.test.tsx` and existing citation/adapter suites.

- [x] Add failing fixtures for a TikTok video URL, X and Reddit aliases, missing or malformed links, and a host-lookalike or URL with credentials. Assert the post link has the original destination, works by keyboard, and keeps replies outside the anchor. Test that invalid links retain the internal citation fallback.
- [x] Implement shared `originalPostHref(platform: string, url: string | null): string | null` using parsed HTTPS URLs, approved platform host boundaries, and known post paths. Resolve reliable next-best canonical links from validated provider identity fields only. Leave uncertain links unlinked. Internally link to `#hasil-*` for citations without a verified permalink.
- [x] Run the result list, AI summary, conversation breakdown, and touched worker adapter tests. Check the mobile touch target and underlying href. Keep this change separately releasable.

## Task 2. Capture and validate continuations

**Files.** Extend `providers/canonical.py`, `providers/fetch.py`, and `providers/scrapeatlas_sources.py`. Add focused cases under `apps/worker/tests/`. Update `instant_search.py` to save a usable continuation from the initial route. Add the next numbered additive web DB migration.

- [ ] Add first- and second-page fixtures per route. Assert exact outgoing cursor and companion fields, preservation of query and route filters, and exhaustion on missing or repeated tokens. Check that Facebook phrase searches and Threads have no button eligibility.
- [x] Persist continuation data per tenant, search, platform and provider route. Pass only the persisted server-side values to the provider. Apply a size and lifetime bound. Keep tokens and companion values out of browser payloads and logs. Continue the original route even when a page yielded no displayed posts if the continuation is verified.
- [ ] Confirm a second-page fixture contains new canonical identities before enabling each route. Record any search mode with partial provider coverage. Run the provider and real PostgreSQL migration tests.

## Task 3. Queue and merge one additional page

**Files.** Add `apps/web/src/monitor/search/more-source.ts` and `apps/worker/sentiment_monitor/instant_search_more.py`. Modify `apps/web/src/app/cari/start-action.ts`, `apps/web/src/monitor/search/load.ts`, and `apps/worker/sentiment_monitor/scheduler.py`. Reuse the existing search ledger and canonical post persistence path.

- [x] Write database regressions for search ownership, expiration, duplicate requests from two tabs, a stale worker claim, provider usage settlement, zero unique hits, and provider failure after dispatch. Verify that retries or refreshes cannot automatically resend a billable request with an uncertain outcome.
- [x] Implement one active request per search, platform, and continuation, plus a tenant-level admission check in one transaction. Use a short leased worker job, never extend the initial search deadline, and publish only availability and state to the browser. Persist ledger outcome, cursor advancement, deduplication, and refreshed counts consistently under concurrency. Preserve source settings and evidence IDs. A provider failure must leave prior results readable.
- [x] Verify the same relevance, date, sort and language behavior as the initial result set. Test that a successful page containing duplicates and weak matches appends only net-new eligible results and creates a single receipt. Verify flag-off and tenant row isolation.

## Task 4. Add controls and verify staging

**Files.** Extend `apps/web/src/components/monitor/cari/{search-screen,progress-panel,results-list}.tsx` and their existing test files.

- [ ] Add tests for both entry points, the absence of a price label, single-click pending state, selecting another platform mid-fetch, updated counts, exhausted/failed states, and the original-summary label.
- [x] Implement the two entry points with shared state, keyboard support, an accessible status message, and polling until the page job settles. Keep the existing screen usable during a fetch and preserve the selected platform and scroll position.
- [ ] Run a mobile and desktop browser walkthrough with fixtures. Confirm the TikTok link opens the correct post externally, returning to the original tab preserves the results, “+ More” does not call other sources, added results survive refresh/history, and rapid clicks yield one request. Check the same workflow with a missing URL, expired cursor, empty page, and exhausted platform.
- [ ] After rollout authorization, run bounded real-provider checks on staging with `mandalika parfum` and a hashtag. Inspect one additional page per verified platform before enabling it, link quality, duplicate behavior, and both the Cari receipt and provider ledger. Leave unverified continuation routes disabled.

## Verification status

Local PostgreSQL and Chromium fixtures covered both controls, one TikTok request per click, an extra matching post, an empty matching page, preserved prior results, exhausted state, safe permalink navigation, and persistence after reload. Browser viewports were 1280px and 390px. The retained search used the original filters. API responses omitted the raw cursor and companion. The worker recorded provider usage and kept the original customer credit count.

ScrapeAtlas continuation behavior against live staging remains a release check. The feature defaults to disabled.
