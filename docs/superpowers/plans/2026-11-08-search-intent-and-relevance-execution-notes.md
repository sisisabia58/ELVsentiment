# Execution notes — search intent and deterministic text relevance

Plan: `docs/superpowers/plans/2026-11-08-search-intent-and-relevance.md`
Worktree: `/workspace/elvsentiment-wt-search-intent`
Branch: `feat/search-intent-relevance`
Base: `48fad3c`

## Migrations

- `apps/web/src/db/sql/011_search_intent_and_relevance.sql` was added.
- Existing migrations `001`–`010` were not modified.
- Registration is automatic: both `apps/web/src/db/migrate.ts` (`applyMigration`) and
  `apps/web/src/db/production-migrate.mjs` (`migrateLocked`) read every `*.sql` file
  from `apps/web/src/db/sql/` in sorted order. There is no separate filename list or
  checksum manifest to update; the checksum tests read the directory at run time.

## Minimal corrections to plan details

1. **Task 4 — obsolete two-route Instagram tests.** The plan removes the second
   Instagram route but the existing test file asserted a reels-plus-hashtag sequence.
   The obsolete two-endpoint tests were rewritten as single-route equivalents that keep
   coverage for dedupe, counts, accepted payload keys, malformed/missing lists, credits,
   response status, transport failure, and read timeout.
2. **Task 9 — X intent provenance location.** The plan named
   `apps/worker/sentiment_monitor/collect.py:48-73`, but `fetch_x_with_cursor` returns a
   frozen `Candidate` dataclass, not mention dicts. The `intent` and `route_id` keys are
   therefore attached in `scheduler.__main__.fetch_x`, where the mention dictionaries are
   built from candidates. `Candidate` is unchanged.
3. **Task 10 — review path fixture.** `presentMention` now requires
   `StoredMention.associationStatuses`. `apps/web/src/monitor/mutations.ts` constructs a
   `StoredMention` directly, so it now supplies `associationStatuses: []` (legacy /
   unassessed). This file was not listed in the plan but was required to keep existing
   review tests and types valid.
4. **Task 11 — expected row order.** The plan's `save-sources` test expected
   `#lama` before `#kopi` after `order by text`; PostgreSQL's default C collation sorts
   `#kopi` first. The expected array was corrected to the actual database order. Stored
   intents are unchanged.
5. **Task 11 — Workspace fixture.** `mentions-empty.test.tsx` constructs a `Workspace`
   literal and needed the new required `keywordIntents: {}` field.

No proposed behavior was widened beyond the approved defaults.
