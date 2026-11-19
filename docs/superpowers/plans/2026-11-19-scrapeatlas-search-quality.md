# ScrapeAtlas Search Quality Implementation Plan

> **For agentic workers**
>
> Use Superpowers' executing-plans skill for inline implementation or its subagent-driven-development skill for delegated implementation. Track progress using the checkboxes below.

**Goal**

Make ScrapeAtlas the sole external collection provider and keep weak matches out of Cari Sekarang results and AI evidence.

**Architecture**

Choose documented ScrapeAtlas routes using paired query evaluations. Reuse the normalized post types across instant search and scheduled collection while preserving their separate deadlines, budgets, and persistence contracts. Apply one query relevance policy before display, comment enrichment, and AI evidence selection.

**Tech stack**

Python worker, Next.js web app, PostgreSQL, pytest, Vitest, and Chromium.

**Product decisions**

Hide weak matches completely. Retire ScrapeCreators and centralize collection on ScrapeAtlas. Keep the summary concise, in Indonesian, and grounded in evidence about the actual query. The previous local filter fix remains part of pre-deployment QA.

## What we verified

- The branch configuration defaults Threads, TikTok, and Instagram to ScrapeCreators. Provider rows in PostgreSQL can override these defaults, so the actual routes used by the screenshot's run still need confirmation from its route ledger.
- The existing ScrapeAtlas TikTok adapter uses `GET /v1/tiktok/search/keyword`. ScrapeAtlas also documents `GET /v1/tiktok/search/top`. The current Facebook adapter uses hashtag lookup, which has narrower coverage than a phrase search.
- ScrapeAtlas documents `GET /v1/instagram/search/posts` and `GET /v1/twitter/search/posts`. The public API catalog reviewed does not document a route equivalent to the dashboard's multi-source Search social. Route and result parity require evidence.
- The worker retains `no_match` rows after ranking. The AI loader can sample those rows, and the current prompt explicitly invites reporting unrelated material.

[Application routing defaults](https://github.com/sisisabia58/ELVsentiment/blob/feature/cari-sekarang/config/cari-providers.json) · [ScrapeAtlas API catalog](https://scrapeatlas.com/docs/llms.txt) · [OpenAPI spec](https://scrapeatlas.com/docs/openapi.json)

## Task 1 — Benchmark retrieval before choosing routes

**Inspect**

`config/cari-providers.json`, `apps/worker/sentiment_monitor/providers/scrapeatlas_sources.py`, `apps/worker/sentiment_monitor/providers/fetch.py`, and the read-only route ledger for the reported instant search if its ID is available.

- [ ] Record the dashboard's visible post IDs or canonical URLs from the supplied examples and label them for `tukuliling kopi`. Add `kopi keliling` as a generic control and an uncommon synthetic query as a zero-match control.
- [ ] Compare the documented TikTok Top and keyword routes using equivalent query, locale, date window, and page budget where supported. Check Threads relevance versus recent settings, Instagram post search, and existing source routes. For Facebook, record whether the hashtag route can support each query intent. Check X and any web coverage separately before offering either as active coverage.
- [ ] For each route, record the top 10 available posts, direct matches, dashboard example IDs recovered, total usable results, latency, and provider credits. Split losses into records missing from the raw response, records dropped by normalization, and records ranked below weaker items. Use sanitized fixtures for repeatable tests. Run paid comparisons only in a controlled environment with an agreed credit limit.
- [ ] Select routes using direct-match precision and benchmark recall, with cost and latency as constraints. If neither TikTok route retrieves enough direct matches, test a second bounded page or a query variant anchored on the distinctive term before adding extra default calls. Document source gaps and the tested parameters.

## Task 2 — Centralize collection and migrate routing

**Modify**

`config/cari-providers.json`, worker `providers/capabilities.py`, `providers/fetch.py`, `providers/scrapeatlas_sources.py`, `providers/comments.py` as needed, scheduled collection through `scheduler.py`, `collect_once.py` and `sources/`, web `monitor/search/platforms.ts`, `monitor/search/provider-settings.ts`, provider settings UI, deployment configuration, README, and environment examples. Add a provider-settings migration after the current migration head.

- [ ] Add adapter contract tests backed by sanitized responses. Pin URLs, parameter names, cursor semantics, and canonical output including IDs, timestamps, engagement, media, and comments. Test failures, empty responses, and malformed records independently.
- [ ] Route instant search and comments through ScrapeAtlas. Route scheduled collection through verified ScrapeAtlas endpoints while preserving cursor isolation, job status, request caps, and actual credit accounting. Mark unsupported source or query modes unavailable with truthful UI status. Retire official X collection only after verifying the ScrapeAtlas X route and its scheduled collection behavior.
- [ ] Migrate persisted active ScrapeCreators and legacy X routes to verified ScrapeAtlas capabilities. Preserve intentional `off` choices. Clear legacy fallbacks and reject new ScrapeCreators selections at the database, web, and worker boundaries. Preserve historical source provenance, audit entries, and billing rows. Test migration against seeded legacy and already-migrated settings.
- [ ] Remove unreachable ScrapeCreators adapters, settings, gates, and credential requirements once both collection paths pass. Keep deployed credentials during the rollback window and retire them after cutover verification.

## Task 3 — Reject weak matches before storage or enrichment

**Modify**

`apps/worker/sentiment_monitor/providers/canonical.py`, `apps/worker/sentiment_monitor/instant_search.py`, `apps/web/src/monitor/search/load.ts` if needed for saved searches, and the Cari results and progress components.

- [ ] Add regression fixtures for direct brand mentions, `#tukuliling`, branded variants, generic coffee captions, unrelated cafés, and generic `kopi keliling` results. Include the sample where `Tukuliling` appears without `kopi`. Keep query interpretation general and test a second brand, a hashtag, and a generic multiword query.
- [ ] Use the existing normalization and ranking rules for stable matches, with an explicit entity-anchor path for identifiable brand queries. A generic word or broad category alone never meets a brand query. Apply the same eligibility gate for all sort modes after normalization and date filtering, before per-platform counting, ranking and comment collection.
- [ ] Verify zero accepted matches produce a successful search with zero eligible results and no comment or AI spend. Verify relevance sorting presents the best eligible results and reported counts agree across results, tabs, receipt, and history.
- [ ] Protect historical data. Apply the same eligibility policy to legacy results when stored evidence supports it. If it does not, show the saved receipt and a rerun action without displaying unverifiable results or their old summary. Exercise old URLs and keep the original provenance and ledger intact.

## Task 4 — Generate a concise, grounded Indonesian summary

**Modify**

`apps/worker/sentiment_monitor/instant_search.py` evidence loading and `instant_ai.py` prompts and validation. Update `ai-summary.tsx`, `conversation-breakdown.tsx`, `quote-source.ts`, and their tests under `apps/web/src/components/monitor/cari/` as needed.

- [ ] Test mixed input with useful replies, off-topic replies under relevant posts, noisy platforms, and too little evidence. Reject references outside the retained evidence sample and retain exact quote validation.
- [ ] Select direct matches and relevant replies independently of the user's display sort. Balance the evidence across sources that have relevant material, and keep sampled IDs and counts accurate after truncation. Use the same evidence policy for summary, per-source claims, and follow-up questions.
- [ ] Ask for two or three natural Indonesian sentences that lead with the strongest supported finding. Require source references for main claims and display those references with the summary. Show a clear insufficient-evidence state when the sample is too thin to support a useful conclusion.
- [ ] Verify summaries on the benchmark fixtures. For `tukuliling kopi`, MRT convenience or vending issues can appear when supported by the sample. Generic coffee sellers and unrelated cafés cannot appear as evidence or conclusions.

### Bottom conversation summary

- [ ] Verify **Kutipan** includes short, word-for-word excerpts from relevant posts or replies, categorized as praise, concern, observation, or question when present. Check that the author and platform come from the cited record, that duplicate excerpts are suppressed, and that clicking each citation opens the correct source or its parent post.
- [ ] Verify **Topik utama** contains distinct, query-specific themes. Each theme needs a supported stance, a concise explanation, and clickable evidence. Derive its count from distinct valid supporting posts and replies, using an evidence label that reflects those units. Derive the platform list from those same references. Suppress themes with no valid evidence and leave empty categories unfilled.
- [ ] Verify **Sikap per platform** labels match the cited material. The current UI assigns a platform's summary stance to every result from that platform and presents the totals as percentages. Show qualitative platform labels until actual per-item classifications and a clearly stated denominator are available. Test a platform with many posts and only one classified summary.
- [ ] Use the screenshots as a review benchmark for the kind of evidence expected. For `tukuliling kopi`, look for themes such as commuter convenience, MRT locations, and empty machines or failed dispensing when the retained evidence supports them. A Toyota or mobile-café theme qualifies only when the source explicitly connects it to Tukuliling. Generic coffee businesses and unrelated cafés must stay out of both quotes and themes.

## Task 5 — Verify the cutover before deploying

- [ ] Run the web suite, worker suite against disposable PostgreSQL 16, and evaluation suite. Record any baseline failures and require clean results for the changed paths. Run browser QA for all three search filters, zero results, source failures, relevant replies, summary citations, and a saved search. Scroll to the bottom summary and review quotes, themes, and platform stance on desktop and mobile. Trace every visible quote and theme to its source, reconcile support counts and platform labels, and verify the section behaves correctly when evidence is sparse.
- [ ] In an approved staging run, execute `tukuliling kopi` and `kopi keliling` with a fixed request budget. Review top results and citations against the labeled evidence, confirm no outbound calls to retired providers, inspect actual provider and app-credit accounting, and run a scheduled collection cycle.
- [ ] Ship the filter fix and quality changes only after staging review. Document deployment order for web, worker, and migration, and verify a rollback path that restores compatible service versions and routing without rewriting historical ledger entries.
