# Cari to Pantau Review UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal** — Let a user review an eligible Cari post, save a manual queue decision in their active project, and undo it from the search.

**Architecture** — Reuse the existing Cari admission rules for one result at a time. Persist manual routing in a tenant-scoped table applied by the project's existing mention presenter. Continue using the worker's deterministic and OpenCode judgments as the automatic evidence.

**Tech stack** — Next.js server actions, React, Base UI, PostgreSQL 16, Vitest, Testing Library.

**Spec** — [ELVsentiment UI and UX Refresh](../specs/2026-11-26-elvsentiment-ux-refresh-design.md)

## Global constraints

- Use the existing active project and safe import rules.
- Keep the manual decision distinct from the automatic judgment. Undo restores the prior manual choice or the automatically derived queue.
- Interactive targets in the redesigned areas have a 44 by 44 px minimum hit area. Dialogs restore focus and support Escape.
- Retain the Indonesian interface. Verify at 320, 390, 768, and 1,280 px.
- Preserve source eligibility, existing review corrections, automatic judgments, billing, and provider dispatch. Keep the X provider investigation outside this release.
- Read `apps/web/AGENTS.md` before writing code. Use the existing Cari and Pantau triage flags and the project opt-in.

## Review focus

- A same-tenant result ID from a different search or an expired result is rejected. Task 1.
- An indexed post or a post with no active matching variant cannot be imported. Task 1.
- An Undo from another tab races with a later manual route. The latest choice wins. Task 2.
- A worker judgment finishes after a person routes the mention. The saved route and judgment both remain available. Task 2.
- The review dialog opens on a newly paged result and closes without resetting the list or its scroll position. Task 3.

Run targeted Vitest commands from the repo root. Each task gets its own commit after its checks pass.

### Task 1 — Eligible one-post admission

**Files** — Modify `apps/web/src/monitor/search/seed-project.ts` and `seed-project.test.ts`. Create `apps/web/src/monitor/search/review-result.ts` and `review-result.test.ts`.

**Interfaces** — In `review-result.ts` define `ReviewKey = { searchId: string; resultId: string; projectId: string }` and `ReviewDestination = "attention" | "ambiguous"`. Export `resolveReviewResult(db: Queryable, customerId: string, key: ReviewKey)` with a discriminated success of `{ ok: true; evidence: SnapshotResult; mentionId: string | null }` or failure of `{ ok: false; error: "not_found" | "ineligible" }`. Export `admitReviewResult(db: Queryable, customerId: string, key: ReviewKey)` with success `{ ok: true; mentionId: string }` and the same failure. Both receive the current customer transaction.

- [ ] Add failing cases for wrong tenant, same tenant but wrong search, expired snapshot, nonmatching variant, indexed or unsupported post, an eligible post outside the bulk seed cap, and an existing project mention reusing its ID.
- [ ] Extract the shared row eligibility and evidence mapping from bulk seeding. Keep the 20-post bulk cap on project creation. Apply the same finished-search, answered source, opted-in project, enabled native platform, valid identity, and active variant checks to the explicitly selected result. Include result ID and all ownership checks in queries. Revalidate eligibility on write, admit at most one mention, and use the existing canonical uniqueness key for a concurrent duplicate. Do not change source support as part of this task.
- [ ] Run `npm test --prefix apps/web -- src/monitor/search/seed-project.test.ts src/monitor/search/review-result.test.ts`. Confirm seeded project behavior and exclusions still pass.
- [ ] Commit as `feat: resolve eligible Cari posts for project review`.

### Task 2 — Persist manual routing and conditional Undo

**Files** — Create `apps/web/src/db/sql/023_pantau_manual_routing.sql`, `apps/web/src/monitor/search/review-routing.ts`, and `review-routing.test.ts`. Modify `apps/web/src/monitor/mention-store.ts`, `present.ts`, `apps/web/src/app/cari/start-action.ts`, and `apps/web/src/db/postgres16.integration.test.ts`. Add `apps/web/src/monitor/present.test.ts` if the mention presenter has no existing focused tests.

**Interfaces** — Define `ManualRoute = { destination: ReviewDestination | null; revision: string | null }`. Export `readCariReviewAction(key: ReviewKey)` returning eligibility, mention judgment, and current manual route. Export `routeCariResultAction(input: ReviewKey & { destination: ReviewDestination; expectedRevision: string | null; requestId: string })` and `undoCariRouteAction(input: { projectId: string; mentionId: string; revision: string })`. Write success returns `{ ok: true; mentionId: string; route: ManualRoute }`. Return stable errors for `unauthenticated`, `disabled`, `not_found`, `ineligible`, and `conflict`.

- [ ] Add failing PostgreSQL tests for cross-tenant IDs, double-submit with one request ID, stale concurrent writes, and stale Undo. Add presenter cases for both destinations, restoring the previous manual route, a worker judgment changing after routing, and an explicit irrelevant owner correction retaining its effect.
- [ ] Store destination, previous destination, and revision keyed by mention. Use the existing mention identity columns for a cascading ownership foreign key and forced tenant RLS. Grant the app role only the required writes. A route write combines admission and compare-and-set in one transaction. A repeated request ID replays the current result, while a conflicting revision never overwrites it. Undo compares the latest revision and restores the previous destination with a fresh revision, retaining a nullable row when the manual decision is cleared. Check authenticated tenant and project at each action. Undo uses the saved mention identity so it still works after Cari snapshot expiry.
- [ ] Load the route in `readStoredMentions` and apply it in `presentMention` to the existing attention and uncertainty queues. Manual attention maps to an included item needing attention, and manual ambiguity maps to `not_sure`. Preserve the automatic reason, evidence, and sentiment. An explicit irrelevant owner correction takes precedence and prevents a new manual route. Derive the row's unread state from the existing read marker.
- [ ] Run `npm test --prefix apps/web -- src/monitor/search/review-routing.test.ts src/monitor/present.test.ts`. Run `npm test --prefix apps/web -- src/db/postgres16.integration.test.ts` with `POSTGRES_TEST_URL` pointing to disposable PostgreSQL 16. Confirm the RLS and concurrency tests ran and passed.
- [ ] Commit as `feat: persist manual Pantau routing with undo`.

### Task 3 — Review dialog and queue presentation

**Files** — Create `apps/web/src/components/monitor/cari/result-review-dialog.tsx` and its colocated test. Modify `apps/web/src/components/monitor/cari/results-list.tsx`, `search-screen.tsx`, `apps/web/src/app/cari/[id]/page.tsx`, and `apps/web/src/components/monitor/mentions-view.tsx` and `mention-detail.tsx`. Extend the Cari result and screen tests.

**Interfaces** — Pass the current workspace project ID into `SearchDetail` as `reviewProjectId?: string | null`. Pass the selected result ID and search ID into the review dialog. Consume the three actions from Task 2 and continue using `monitorAsProjectAction` for onboarding.

- [ ] Add failing tests for pending and existing judgments, disabled routing for an ineligible result, no project with an onboarding action, both manual choices, a stale write, successful Undo, and focus returning to the same card after dialog close. Check existing queue labels and counts against a manual move.
- [ ] Add `Tinjau` to supported Cari cards. Show the post, platform, original link, and the available verified excerpt and reason. For a pending or absent judgment show its current state. Offer the two explicit queue actions and a status message with `Urungkan` on success. Keep the current search, platform filter, and replies open while the user reviews a paged result. Apply the shared visual treatment and a manual-decision label to the affected Pantau list and detail views.
- [ ] Run `npm test --prefix apps/web -- src/components/monitor/cari/result-review-dialog.test.tsx src/components/monitor/cari/results-list.test.tsx src/components/monitor/cari/search-screen.test.tsx`. In browser fixtures verify the moved post appears once in the expected queue, survives reload, and returns to its automatic queue after Undo.
- [ ] Commit as `feat: review Cari posts from search results`.

## Staging release gate

- [ ] Run the full web test suite, lint, typecheck, and production build from the Cari release gate. Run the real PostgreSQL 16 integration tests against a disposable database.
- [ ] Apply the additive web migration via the existing Railway staging pre-deploy migration runner. Verify the migration and active web SHA before testing the workflow in a staging project opted into Pantau triage.
- [ ] Test saved routing, worker completion, a second-tab conflict, Undo, expiry, and a tenant isolation fixture. Confirm queue counts, keyboard and mobile focus, and absence of any extra search action. Record the previous web SHA and verify that rolling back the web build leaves manual routing rows available for the next release.
