# Search Intent QA Repair Notes

Date: 2026-11-09
Worktree: `/workspace/elvsentiment-wt-search-intent`
Branch: `feat/search-intent-relevance`
Original QA target: `08cb148d3448635ec9edefd4d47db5072c5aca5f`
Code repair candidate: `c721e3b` (docs added in the following commit)
QA evidence read: `/workspace/elvsentiment-qa-20261109-08cb148` (read-only)
Repair scratch/logs: `/workspace/sc-research/impl/repair-20261109`

This file records the repair cycle, not a new independent QA pass. Independent QA
must re-run on the exact final HEAD.

## Finding dispositions

| Finding | Status | Repair |
|---|---|---|
| F1 undated retention | Fixed | 011 drops the `mentions.posted_at` NOT NULL; store persists NULL; UI/feed labels `Waktu postingan tidak tersedia`; date-windowed dashboard counts exclude undated rows instead of fabricating a date. |
| F2 route provenance | Fixed | `dedupe_mentions` merges every `route_id` into `route_ids`; `PostgresStore` writes one association per route. Actual fetch → `_unpack_fetched` → dedupe → worker store covered. |
| F3 caption/status coherence | Fixed | Conflict lookup now selects the retained `excerpt`; text-match status is derived from the retained/displayed excerpt (first-text policy). No excerpt rewrite. |
| F4 parent integrity | Fixed | Composite FKs enforce `(project_id, customer_id) → projects` and `(mention_id, customer_id, project_id, source) → mentions`; loader association join also requires project and source match. Integrity hardening; no cross-tenant post-body leak was demonstrated or claimed. |
| F5 candidate-count ambiguity | Documented, not changed | Dashboard and Sebutan intentionally reuse each screen's existing row/bucket filters. For the same explicit date/source they can differ when historical scoring buckets differ. Scoring eligibility and historical visibility were not changed. |
| F6 partial-failure telemetry | Fixed | `carry_attempt_context` accepts the known pre-window parsed count; TikTok passes its route total, so stale-first-route + malformed-second reports `parsed=1`, current HTTP/credits, and the original cause. No status borrowing or credit double-count. |
| F7 cleanup | Done | Removed unused endpoint/region constants and renamed the stale Threads region test. |
| B1 baseline global DELETE | Out of scope, unchanged | `worker_role` still has the baseline DELETE grants on `jobs`, `project_schedules`, `source_cursors` (3 grants). New association table, `mentions`, and `source_status` have no DELETE grant. Global no-DELETE is NOT claimed as passing. |
| B2 lifecycle escapes | Out of scope, unchanged | The same 16 initialization/claim-tick fault escapes observed on base 48fad3c and old final remain; this branch did not alter lifecycle behavior. Not rerun as a repair gate. |

## Exact final verification

All app/test commands ran with `env -i` isolation and copied transport guards
(`block/sitecustomize.py`, `block-node.cjs`) under repair scratch. No provider
or external network calls were made. PG clusters were repair-owned only.

| Check | CWD | Command (summary) | Exit | Result |
|---|---|---|---|---|
| Worker no-DB | worktree | `env -i ... pytest -q -p no:cacheprovider apps/worker/tests` | 0 | 223 passed, 21 skipped |
| Worker real PG | worktree | same + `POSTGRES_TEST_URL=...port=55461` | 0 | 244 passed, 0 skipped |
| Web unit | `apps/web` | `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=20000` | 0 | 318 passed, 13 skipped; 56 files passed, 2 skipped |
| Web real PG | `apps/web` | vitest `src/db/postgres16.integration.test.ts src/db/scoring-postgres16.integration.test.ts` with `POSTGRES_TEST_URL=...55492`, `POSTGRES_TEST_LOG_PATH` | 0 | 13 passed, 0 skipped |
| Typecheck | `apps/web` | `npm run typecheck` | 0 | clean |
| Lint | `apps/web` | `npm run lint` | 0 | 0 errors, 1 pre-existing warning (`scripts/seed-screenshots.mts:62`) |
| Offline build | `apps/web` | `npm run build` | 0 | 20 static pages, 11 emitted files |
| Real migration runner | scratch | `migrate-evidence.mjs` (production `migrate()`, NOSUPERUSER qa_admin) | 0 | 11 ledger rows; second run no-op |
| 001–010 identity | worktree | sha256 current vs `git show 48fad3c:...` | 0 | all ten byte-identical |
| 011 checksum | worktree | sha256 | — | `8f6f5be086837e76711d7af80fee5f20df3103ec6cc0e44346c32393c5f1d0b8` |
| Repair boundary probe | scratch | `probes/verify_fixes.py` | 0 | F1/F2/F3/F4/F6 all PASS with real SCRAM worker/app identities |
| Managed transaction | scratch | `probes/managed_transaction_probe.py` | 0 | 13/13 stages PASS (atomic rows/cursor, commit receipts, job/health, one log) |
| Strict QA contracts | scratch | `pytest probes/test_qa_contracts.py` | 1 | 10 passed, 1 failed — only the retained global B1 DELETE audit |
| Synthetic matrix | scratch | `probes/matrix_verify.py` | 0 | 176 endpoint, 126 credit, 64 label, 19 relevance, 56 freshness; F6 counted parsed=1 |
| Independent UI/role probe | scratch | copied `qa-independent-repro.test.tsx` | 1 | 3 passed, 1 failed — only F5 (`Kandidat 4/2/1` vs `2/1/0`) |

Logs are under `/workspace/sc-research/impl/repair-20261109/logs/`:
`final-worker-nodb.log`, `final-worker-pg.log`, `final-web-unit.log`,
`final-web-pg.log`, `final-typecheck.log`, `final-lint.log`, `final-build.log`,
`final-migration.log`, `final-migration-rerun.log`, `final-verify-fixes.log`,
`final-managed-transaction.log`, `final-contracts.log`, `final-matrix.log`,
`final-web-independent.log`.

## Migration detail

The unreleased `011_search_intent_and_relevance.sql` now also:

- `alter table mentions alter column posted_at drop not null;`
- unique `projects (id, customer_id)`;
- unique `mentions (id, customer_id, project_id, source)`;
- composite association FKs for project/customer and mention/customer/project/source.

`001`–`010` were not edited and remain byte-identical to `48fad3c`.

## Limitations / non-claims

- F5 remains a documented product/QA clarification, not a code change.
- B1 and B2 remain baseline/out-of-scope; the global DELETE audit is still red by design and is not claimed passing.
- The successful-fetch `dropped_out_of_window` count is still discarded by `_unpack_fetched` and not logged; F6 fixed the failure-path `parsed` value, not this separate visibility observation.
- No provider documentation or live provider behavior was re-verified. No deployment, migration application, push, merge, or production action was performed.
- Independent QA is not marked passed. The parent must re-run it on the exact final SHA.
