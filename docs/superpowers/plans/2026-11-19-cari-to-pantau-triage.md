# Cari sekarang to Pantau Triage Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkboxes for tracking.

**Goal.** Turn a finished Cari sekarang search into a monitoring project that can surface actionable complaints and review uncertain mentions.

**Architecture.** Carry the origin search through the existing onboarding wizard. On save, import eligible posts into the project and let the existing Python worker classify both imported posts and future collections. Reuse Cari's relevance matcher and OpenCode transport, then present the result through the existing Pantau inbox and correction paths.

**Stack.** Next.js server actions, Postgres RLS, the Python scheduler, and the existing OpenCode JSON client. Baseline is `fix/scrapeatlas-search-quality` at `37b1e03`.

**Design brief.** The Nov 19 request sets the scope. This plan proposes explicit import consent during project setup, current project sources, and a staging pilot. Its routing rules and pilot limits are proposed defaults for review.

## Global constraints

- Carry only visible posts with stable native IDs from a finished, unexpired, current-relevance search owned by the active tenant. Older snapshots can still prefill ordinary setup. Respect the owner's final keyword variants and selected sources. Normalize phrase and hashtag intent as Cari does.
- Seed up to 20 posts in saved relevance order, with a stable tie-breaker. Use the intersection of selected, available monitoring sources and sources in the snapshot. This pilot covers Threads, Instagram, and TikTok. Replies remain available on the original search.
- Use `canonical.text_relevance` for both seed and scheduled candidates, including stored titles and hashtags when available. Keep ordinary positive, factual, and non-actionable mentions in Sebutan.
- A literal match against any owner-confirmed project variant qualifies as a strong match. In the pilot, confirm `tukuliling` as a variant alongside `tukuliling kopi` so a direct brand mention can qualify even when it omits “kopi.” The wizard must not automatically turn a generic descriptor into a standalone variant.
- Keep AI classification off the interactive search path. Reuse OpenCode with a separate structured prompt and background job. Import does not trigger a second ScrapeAtlas search or charge another Cari credit. Scheduled collections retain their existing controls.
- Pending and provider-failure states must remain visible as such. Preserve existing owner actions and previous judgments. Projects outside the pilot follow their existing processing path.
- Keep JEV outside the pilot. Start behind a server-side `PANTAU_FILTER_TRIAGE_ENABLED` flag, off by default. Limit model admissions to 20 per pilot project per rolling 24 hours, counting attempts before dispatch. Defer excess work visibly.

## Routing contract

| Relevance and classification | Project destination |
|---|---|
| Literal match and a clear firsthand actionable complaint with a verified excerpt | Perlu perhatian and Sebutan |
| All-words or entity-anchor match with a potential complaint, sparse text, or genuinely unclear sentiment or actionability | Belum yakin |
| Relevant praise, factual material, or clearly non-actionable discussion | Sebutan |
| No match in available post text or title | Excluded from review queues and sentiment totals |
| Queued, malformed AI response, or unavailable classifier | Pending, retrying, or failed according to processing state |

A mixed post can qualify for Perlu perhatian when its complaint independently meets the evidence rule. Praise in the same post remains visible. A quote, repost, or hearsay does not qualify on its own. Store an issue category such as payment or stock when supported by the post. Distinguish missing text from a verified non-match. For uncertain items, identify whether the ambiguity concerns relevance or the interpretation of the complaint. Apply owner confirmation and corrections before deriving counts and badges.

## Review focus

- An expired, unauthorized, or cross-tenant search cannot be imported. A user can still finish ordinary project setup if the seed becomes unavailable.
- A repeated save or simultaneous scheduled collection creates one mention and one classifier job per project, platform, and canonical post ID.
- A generic coffee complaint cannot enter the Tukuliling inbox or inflate its sentiment counts.
- Malformed output, an invented excerpt, or a stalled worker cannot appear as a settled negative result.
- Owner corrections win over retries and late model results. Dashboard counts, badges, and detail pages agree.

## Task 1. Preserve the origin and import posts through onboarding

**Files.** Modify `apps/web/src/app/cari/actions.ts`, `apps/web/src/app/cari/start-action.ts`, `apps/web/src/monitor/onboarding-draft.ts`, `apps/web/src/app/onboarding/page.tsx`, and `apps/web/src/components/monitor/onboarding-wizard.tsx`. Add `apps/web/src/monitor/search/seed-project.ts` and migration `apps/web/src/db/sql/019_pantau_filter_triage.sql`.

**Interface.** Carry `originSearchId` in the existing customer-scoped onboarding draft only when initiated from Cari. Define `seedProjectFromSearch(input: { db: Queryable; customerId: string; projectId: string; searchId: string }): Promise<{ added: number; alreadyPresent: number; skipped: number }>`. Read finalized variants and sources on the server. Task 2 consumes the imported mention and its stored evidence.

- [ ] Extend `apps/web/src/app/cari/start-action.test.ts` and `apps/web/src/components/monitor/onboarding-wizard.test.tsx` to cover draft resumption, explicit import consent, final source changes, and normal onboarding without a search origin.
- [ ] Add `apps/web/src/monitor/search/seed-project.test.ts` with authenticated, foreign-tenant, expired, empty, undated, over-cap, and repeated or concurrent import fixtures. Expect 20 seed posts maximum, one original platform ID per project, zero imports on consent withdrawal, and zero new provider requests. Preserve permalink, original author, published date when available, and Cari provenance.
- [ ] Run the tests and confirm failure on the missing draft field/import. Implement the server-side handoff with the existing customer transaction and project+source+external-ID dedup key. Persist a project-level pilot opt-in on successful confirmation and make retries reuse the same project for the same onboarding attempt. Add RLS and constrained worker permissions for new metadata.
- [ ] Run from `apps/web`: `npx vitest run src/app/cari/start-action.test.ts src/components/monitor/onboarding-wizard.test.tsx src/monitor/search/seed-project.test.ts`. Commit the passing handoff and migration.

## Task 2. Filter and classify mentions in the worker

**Files.** Add `apps/worker/sentiment_monitor/mention_triage.py` and `apps/worker/tests/test_mention_triage.py`. Modify `apps/worker/sentiment_monitor/scheduler.py`, `apps/worker/sentiment_monitor/pg_store.py`, and `apps/web/src/scoring/jobs.ts`. Reuse `apps/worker/sentiment_monitor/providers/canonical.py` and `apps/worker/sentiment_monitor/opencode.py`.

**Interface.** Define `triage_mention(mention: TriageInput, client: OpenCodeClient) -> TriageDecision`, where input contains the selected project terms, post text, optional title and hashtags. Persist decision origin, relevance tier, sentiment (positive, negative, neutral, mixed, or unclear), actionability, reason, verified excerpt, and model version in a dedicated judgment keyed by mention. Record attempts and claim leases separately from the judgment. Task 3 consumes the latest verified decision or processing state.

- [ ] Add fixture tests for clear Tukuliling complaints, generic coffee posts, borderline matches, reposts and hearsay, mixed praise/complaint, missing text, false quotes, and quota/provider failure. Assert that `Saldo kepotong di Tukuliling, minumannya nggak keluar` qualifies with the confirmed `tukuliling` variant, that a definite no-match makes zero model calls, and that unsubstantiated outputs never create attention.
- [ ] Add scheduler/storage tests for seeded and scheduled copies of the same post, two worker claims, stale leases, the 20-attempt cap, and late results after a newer claim. Assert one current judgment and no model work for disabled projects. Cover the legacy scorer's claim and stale-reclaim paths so they cannot pick up pilot mentions, and confirm non-pilot projects retain existing behavior.
- [ ] Run the new tests to verify the missing worker path fails. Implement a bounded background poll using the existing worker-role connection and claim pattern. Commit claims and budget reservations before model calls. Validate schema and substring evidence before persistence. Use the source post as untrusted input, track safe failure codes, and retry transient failures up to three attempts with backoff. Keep instant search polling independent. Use the existing scheduled-source data when it carries corroborating title/hashtags and use the excerpt alone when it does not.
- [ ] Run `python -m pytest apps/worker/tests/test_mention_triage.py apps/worker/tests/test_scheduler.py` in the worker environment and `npx vitest run src/scoring/jobs.test.ts` from `apps/web`. Commit the passing worker path.

## Task 3. Route verified decisions into the existing inboxes

**Files.** Modify `apps/web/src/monitor/load.ts`, `apps/web/src/monitor/present.ts`, and `apps/web/src/monitor/mutations.ts`. Reuse `apps/web/src/app/dasbor/perlu-perhatian/page.tsx` and `apps/web/src/app/dasbor/belum-yakin/page.tsx`. Extend `apps/web/src/monitor/monitor.test.ts`.

**Interface.** Extend `StoredMention` with optional filter-triage state and evidence. Resolve it in the existing `presentMention(row, policy)` path for both loading and review mutations. Reuse the existing bucket, unread, and correction consumers.

- [ ] Add test fixtures for a direct complaint, mixed but actionable feedback, a borderline complaint, a non-actionable post, pending work, and provider failure. Assert queue membership, nav counts, and reason/permalink consistency. Assert dismissing, confirming, or correcting a row updates both counts and detail consistently and takes precedence over a late model result.
- [ ] Run the workflow tests to verify failure. Wire the shared projection and existing actions so judgment provenance and the reason are visible when needed. Keep mixed labels available on mention detail. Exclude mixed and uncertain pilot rows from any legacy aggregate that cannot represent them and show the actual included count.
- [ ] From `apps/web`, run `npx vitest run src/monitor/monitor.test.ts src/components/monitor/cari/search-screen.test.tsx` and `npx tsc --noEmit`. Commit the inbox integration.

## Task 4. Verify the workflow and pilot it in staging

- [ ] Run the focused suites from Tasks 1–3 and a Chromium fixture walkthrough on desktop and mobile. Start at Cari, import eligible posts through project setup, open both inboxes, make an owner correction, and verify the change persists after refresh. Repeat with import declined and with an expired search.
- [ ] When rollout is authorized, deploy the additive migration before enabling the staging worker flag. Use one test tenant and one Tukuliling project. Confirm the handoff makes zero ScrapeAtlas requests, and run one scheduled collection to verify both intake paths reach the same queues. Reopen the original search and confirm the result and summary are still readable.
- [ ] Review 30 owner-labeled posts before wider rollout, including firsthand complaints, weak matches, mixed posts, and out-of-brand mentions. Record actionable precision and missed complaints separately, review-queue volume, cost per classified mention, and elapsed time to inbox. Require zero unrelated or unsupported alerts in the pilot fixture and zero duplicate jobs. Decide classifier thresholds and rollout readiness from the observed results.
- [ ] Exercise flag-off in staging. Verify it stops new pilot imports and AI admissions while preserving judgments, review history, and queued pilot work for later resumption. Keep pilot mentions out of the legacy claim path while paused.
