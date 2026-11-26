# Cari UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal** — Make Cari sekarang, its results, and Riwayat readable and fast to use on a phone while refreshing the shared workspace style.

**Architecture** — Rework the existing Cari components around their current snapshots and server actions. Keep viewport-dependent behavior in CSS and accessible dialogs. Build on existing evidence, permalink, filter validation, and pagination logic.

**Tech stack** — Next.js 16, React 19, Tailwind CSS 4, Base UI, Vitest, Testing Library.

**Spec** — [ELVsentiment UI and UX Refresh](../specs/2026-11-26-elvsentiment-ux-refresh-design.md)

## Global constraints

- Retain ELVsentiment blue, Inter, and the Indonesian interface.
- Use a single reading column below 768 px and a secondary summary column from 1,024 px.
- Interactive targets in the redesigned areas have a 44 by 44 px minimum hit area.
- Use CSS motion from 150 to 250 ms, with 180 ms as the default. Reduced motion removes these effects.
- Verify at 320, 390, 768, and 1,280 px, with keyboard navigation and reduced motion included.
- Preserve existing requests, billing, saved history, and provider settings. Read `apps/web/AGENTS.md` and its Next.js references before editing code.

## Review focus

- A long unbroken keyword fits at 320 px with a reachable submit button. Task 1.
- Opening mobile filters and dismissing with Escape restores focus and keeps the current selection. Task 2.
- A snapshot with a valid post and pending summary still displays the post. Task 3.
- A pagination response adds results while the reader is halfway down the list. Task 4.
- A summary cites a reply outside the initially visible reply set and an unresolved evidence ID. Task 5.

Run targeted Vitest commands from the repo root. Each task gets its own commit after its checks pass.

### Task 1 — Shared visual system and responsive shell

**Files** — Modify `apps/web/src/app/globals.css`, `apps/web/src/components/monitor/shell.tsx`, `apps/web/src/components/monitor/cari/search-screen.tsx`, and `apps/web/src/components/monitor/cari/history-list.tsx`. Extend `shell.test.tsx` in the shell directory.

**Interfaces** — Keep the `WorkspaceShell`, `SearchScreen`, and `SearchDetail` props. Define shared CSS tokens `--motion-duration: 180ms` and `--workspace-header-height`, and a reduced-motion rule scoped to the new workspace effects.

- [ ] Add `mobile drawer preserves active navigation and restores focus`, which opens the drawer, asserts the current link has `aria-current="page"`, dismisses with Escape, and asserts focus returns to its trigger. Capture the 320 px keyword layout before the change.
- [ ] Apply the surface, spacing, and typography refresh. Use one mobile drawer for existing navigation and keep the desktop sidebar. Make long receipt values wrap, set grid children to `min-width: 0`, and use the same spacing in history and search.
- [ ] Run `npm test --prefix apps/web -- src/components/monitor/shell.test.tsx src/components/monitor/cari/history-list.test.tsx`. Check in a browser that the page width equals viewport width at 320 and 390 px with a 160-character unbroken query. Verify touch target dimensions and keyboard focus after closing the drawer.
- [ ] Commit as `feat: refresh ELVsentiment workspace layout`.

### Task 2 — Sticky search and mobile filter sheet

**Files** — Modify `apps/web/src/components/monitor/cari/search-form.tsx`, `search-screen.tsx`, and their colocated tests. Create `apps/web/src/components/monitor/cari/search-filter-sheet.tsx`.

**Interfaces** — Add `compact?: boolean` to `SearchForm`. Define `SearchFilterSheet({ filters, onChange, onReset }: { filters: SearchFilters; onChange: (filters: SearchFilters) => void; onReset: () => void })`. Reuse `DEFAULT_FILTERS`, option constants, and `SearchFormInput` from the current flow.

- [ ] Add `mobile filter edits stay in the next search draft`, which selects a date and language, removes only the language chip, and submits exactly one `startSearchAction` call with the selected date and default language. Add `reset clears the draft filters` and `Escape restores filter trigger focus`.
- [ ] Add the sticky compact form to results, initialized from the snapshot once per search ID. Keep the receipt bound to saved filters. Reuse one draft state for desktop controls, mobile sheet, and chips. On mobile use a dialog with three labeled radio groups, Escape and close, and focus restoration. Changes apply locally and submit only through the form. Ensure the sticky form accounts for the shell header and safe-area inset.
- [ ] Run `npm test --prefix apps/web -- src/components/monitor/cari/search-form.test.tsx src/components/monitor/cari/search-screen.test.tsx`. Check an Android Chrome viewport with the on-screen keyboard if available, including submitting with Enter and removing a single chip.
- [ ] Commit as `feat: add responsive Cari search and filters`.

### Task 3 — Compact progress, motion, and recovery

**Files** — Modify `apps/web/src/components/monitor/cari/progress-panel.tsx`, `search-screen.tsx`, `apps/web/src/app/globals.css`, and the existing progress and search-screen tests.

**Interfaces** — Keep `ProgressPanel` and `SearchSnapshot` props. Read existing `status`, source `state` and `safeDetail`, and the polling stale signal. Keep `MoreSourceControl` working when source details are expanded.

- [ ] Add `first posts stay visible through pending and stale states` and `empty, indexed zero, and failed source use distinct copy`. Assert a positive result renders beside the pending labels and persists when polling stops, and that indexed zero and failure have distinct textual status.
- [ ] Show count and status text first. Make the source panel user-controlled after the first results arrive, preserve a user's disclosure choice, and retain the compact source/comment/AI indicators. Collapse optional map detail on mobile. Animate bar width and newly visible content once, with zero animation under reduced motion. Reuse existing rerun or pagination actions where eligible and keep all retries explicit.
- [ ] Run `npm test --prefix apps/web -- src/components/monitor/cari/progress-panel.test.tsx src/components/monitor/cari/search-screen.test.tsx`. Verify normal and reduced-motion polling in a browser and check that retry is absent for a failed source without a retry action.
- [ ] Commit as `feat: improve Cari progress and recovery states`.

### Task 4 — Result cards and Cari lagi

**Files** — Modify `apps/web/src/components/monitor/cari/results-list.tsx`, `more-source-control.tsx`, `progress-panel.tsx`, and the colocated result, progress, and search-screen tests.

**Interfaces** — Keep `ResultsList`, `MoreSourceActions.request(platform, generation)`, and canonical result IDs. Reuse the existing permalink validation and internal citation link helpers.

- [ ] Add `original post link names its platform and preserves local citations` and `Cari lagi dispatches once and announces additions`. Assert the verified href and local anchor, one action on rapid duplicate clicks, and a polite added count after completion. In a browser fixture append results while scrolled and assert the same visible result remains within 8 px of its prior viewport offset.
- [ ] Lay out the title, thumbnail, source, author, date, and metrics with a consistent reading order. Keep reply controls outside anchors. Place pagination beside the platform label in both eligible entry points and announce the added count in a polite status. Preserve the active platform, open replies, card identity, and user scroll position during polling and append.
- [ ] Run `npm test --prefix apps/web -- src/components/monitor/cari/results-list.test.tsx src/components/monitor/cari/progress-panel.test.tsx src/components/monitor/cari/search-screen.test.tsx`. Check eligibility, exhaustion, failed thumbnails, safe links, a long caption, and multiple pages in browser fixtures.
- [ ] Commit as `feat: improve Cari cards and source paging`.

### Task 5 — AI takeaway and evidence navigation

**Files** — Modify `apps/web/src/components/monitor/cari/ai-summary.tsx`, `conversation-breakdown.tsx`, `evidence-links.tsx`, `results-list.tsx`, and their colocated tests.

**Interfaces** — Consume existing `SnapshotAi`, `supportedThemes`, `supportedQuotes`, `resolveEvidence`, and local result anchors. Keep the original summary's evidence sample distinct from results appended later.

- [ ] Add `summary details reveal verified quotes only` and `citation reveals the parent result and hidden reply`. Assert the takeaway is visible before expansion, the valid quote matches its source text, the unresolved evidence ID is absent, and citation activation opens the correct platform and reply.
- [ ] Put the takeaway and its evidence links first. Put platform analysis, themes, and quotes behind the mobile disclosure with the same evidence semantics on desktop. Make internal links open the correct platform and reply state before moving to the anchor. Keep a pending, insufficient, or failed summary readable while preserving access to posts.
- [ ] Run `npm test --prefix apps/web -- src/components/monitor/cari/ai-summary.test.tsx src/components/monitor/cari/conversation-breakdown.test.tsx src/components/monitor/cari/results-list.test.tsx`. Verify keyboard citation activation and return to the list.
- [ ] Commit as `feat: surface verified Cari summary evidence`.

## Staging release gate

- [ ] Run `npm test --prefix apps/web`, `npm run lint --prefix apps/web`, `npm run typecheck --prefix apps/web`, and `npm run build --prefix apps/web`. Verify `git diff --check`.
- [ ] Use the existing Cari screenshot seeding script with a disposable database. Walk through search, filters, pending-to-complete progress, pagination, history, a missing permalink, and evidence links at the specified widths. Test keyboard focus and reduced motion. Capture mobile and desktop screenshots.
- [ ] Deploy the verified web commit to Railway staging. Verify the active SHA, login, a retained search replay, and one explicit live smoke search if authorized. Compare the receipt and provider call counts against the existing flow. Record evidence and the prior web SHA for rollback.
