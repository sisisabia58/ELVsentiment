# Open questions: decisions and remaining items (v2)

Updated 1 Nov 2026 after the user's answers, then aligned the same day with the team-lead decisions. Plan: `docs/superpowers/plans/2026-11-01-sentiment-monitor-mvp.md`. Where this note disagrees with that plan, the plan wins.

Team-lead decisions now in the plan: an always-on worker (1 replica) claims a `jobs` table with `SELECT ... FOR UPDATE SKIP LOCKED` (no Railway cron service); Harken cursors live in Postgres via an adapter, Harken stays at `d0710a4` unmodified, and a cursor moves only in the mention transaction; no `secrets.ts`; one Threads counter in Postgres; Postgres image `postgres:16.15` in Singapore (`asia-southeast1-eqsg3a`); nightly `pg_dump` is not built until `BACKUP_DESTINATION` is set; in-app caps come before Railway's hard spend limit. Defaults, still pending user confirmation: X 20000/month global and 2000/month per customer, Threads reserve 1500 of 2200 per rolling 24 hours, schedules at least 6 hours apart, manual runs at least 15 minutes apart per customer, 5 jobs per pass, poll 20 seconds (range 15–30), heartbeat stale after 90 seconds. Hobby or Pro is unset. Data residency default is Singapore. Backup destination default is empty.

**User's answers (verbatim, relayed by Coder):** "1. Pricing will decide later after we can see live app, 2. Shared account we will need to manage, use our account or API, 3. When triggerred (manually or schedule set by customer), 4. For team it will be later, 5. Follow product lead suggestion. Additional; we will deploy using railway not my private vps".

**Status labels:** **Decided** · **Deferred** · **Still needs research** · **Needs sign-off** (decided in principle, a named person still has to approve).

Railway facts come from docs.railway.com, read 1 Nov 2026; each URL is given where used. Limit numbers below are the team-lead defaults, not a cost estimate. This note does not state a monthly hosting total, a price, or an accuracy target.

## Status at a glance

| Q | Topic | Status |
|---|---|---|
| 23 | Stack | Decided (accept recommendation); **CTO sign-off still required before Task 1** |
| 24 | Repo | Decided: `sentiment-monitor`, private. GitHub owner still to confirm |
| 1 | SME validation | Decided (accept recommendation); recruit list is the user's |
| 2 | Pricing | **Deferred** until a live app exists |
| 3 | Threads approval and query budget | Approval: Still needs research. Budget guard: Decided |
| 4 | Threads empty vs blocked | Decided |
| 5 | Threads paging | Still needs research (live test) |
| 6 | Who pays X | **Decided: one shared operator account/API that we manage** |
| 7 | Confidence thresholds | Decided process; values set after evaluation (Q8) |
| 8 | Labelled set and gate | Decided process; dataset and thresholds Still need research/user |
| 9 | Topic labels | Decided (starter set, to validate) |
| 10 | Multi-label counting | Decided (approve) |
| 11 | High impact | Decided (off in v1); X metrics Still needs research |
| 12 | Overview formula | Decided (approve) |
| 13 | Coverage, cadence, timezone, bucket | **Decided: trigger-based collection**; interval defaults are pending confirmation |
| 14 | Languages, devices, retention, backups | Decided except legal retention (Still needs research) |
| 15 | Hosting | **Decided: Railway**, Singapore (`asia-southeast1`); tier and Indonesia residency still pending |
| 16 | TypeSafe SLA and fallback list | Decided (accept for pilot); meaning of 402 Still needs research |
| 17 | TypeSafe rate limits | Still needs research (console) |
| 18 | TypeSafe hosting and latency | Still needs research (measure from Railway) |
| 19 | TypeSafe retention | Still needs research and legal input |
| 20 | Credential mode | **Decided: `shared_operator`** |
| 21 | Disappearing posts | Decided |
| 22 | Team and timeline | **Deferred** |
| 25 | Indonesian copy | Decided (placeholder, then native review) |
| 26 | Who runs collection and how often | **Decided: always-on worker, jobs table, SKIP LOCKED**; poll default 20s, pending confirmation |

---

## Railway findings (checked 1 Nov 2026)

**Regions.** Railway has four regions: US West (California), US East (Virginia), EU West (Amsterdam) and **Southeast Asia Metal, Singapore (`asia-southeast1-eqsg3a`)**. There is no Indonesia region. A service's region can be changed later, but a service with a volume has downtime while the volume migrates.
https://docs.railway.com/reference/deployment-regions

**Postgres.**
- Railway's Postgres template is a single node built from the official Postgres Docker image. It sits on Railway's private network by default and gives `DATABASE_URL` to other services.
- High availability (Patroni) and point-in-time recovery are opt-in upgrades.
- The page doesn't say which major version the template deploys.

https://docs.railway.com/guides/postgresql

**Backups.**
- Native volume backups can be manual or scheduled, and cover Railway databases.
- Retention by schedule: daily backups are kept 6 days, weekly 27 days, monthly 89 days.
- Backups are billed like volume storage, on incremental size.
- Caveats from the page:
  - Wiping a volume deletes all its backups.
  - A backup can only be restored into the same project and environment.
  - A manual backup is limited to 50% of the volume size.
  - The feature is "still under development".

https://docs.railway.com/reference/backups

**Cron jobs.**
- A service can run on a crontab schedule. Railway runs its start command, and the process must exit when done.
- Runs must be at least 5 minutes apart.
- Schedules are in UTC, and run times can drift by a few minutes.
- If the previous run is still active, the next run is skipped.
- `railway cron run` triggers a run from the CLI.

https://docs.railway.com/reference/cron-jobs

**Separate Python worker next to Next.js.**
- In an isolated monorepo, each service gets its own root directory (for example `apps/web` and `apps/worker`).
- Watch paths stop one service's changes from rebuilding the other.
- The Railway config file needs an absolute path.

https://docs.railway.com/guides/monorepo

**Private networking.** Services in the same project and environment can reach each other at `SERVICE_NAME.railway.internal`, over encrypted WireGuard, without public exposure.
https://docs.railway.com/reference/private-networking

**Volumes.**
- Each service can have one volume.
- Replicas can't be used with volumes.
- Redeploying a service that has a volume causes a short downtime.
- Default size: Hobby 5 GB, Pro 50 GB.

https://docs.railway.com/reference/volumes

**Pricing.**
- Subscriptions:
  - Free: $0, $1 credit a month, 0.5 GB RAM per service.
  - Hobby: $5 a month, includes $5 of usage, described as for "personal projects".
  - Pro: $20 a month, includes $20 of usage, described as for "teams shipping to production".
- Usage rates on top of the included amount: RAM $10/GB/month, CPU $20/vCPU/month, egress $0.05/GB, volume storage $0.15/GB/month. Builds are free.
- Railway now requires a post-paid card.

https://docs.railway.com/reference/pricing/plans

**Spending controls.** A workspace hard limit (minimum $10) takes all workloads offline when reached. A soft limit only sends an email alert.
https://docs.railway.com/reference/usage-limits

**Not checked:** Next.js-specific build settings on Railway. This plan does not use a cron service or a worker volume.

---

## Q23. Stack: **Decided, needs CTO sign-off**

- **Decision:** Accept the plan's recommendation.
  - `apps/web`: Next.js App Router, TypeScript, Tailwind 4, shadcn/ui, Postgres with row-level security, PGlite in tests.
  - `apps/worker`: Python 3.12, importing Harken pinned at `d0710a4` as a library.
  - Deploy both as separate Railway services in one project (monorepo root directories), with Railway Postgres.
- **Reason:** Next.js can't import Harken. A separate worker keeps source failures away from owner sessions, and Postgres row-level security gives per-customer isolation. Railway supports this layout directly (monorepo guide).
- **Source:** Spec; Harken repo; npm registry (versions checked 1 Nov 2026); https://docs.railway.com/guides/monorepo; user's instruction to accept.
- **Open:** The CTO must sign off (`stack_reviewed`) before Task 1.
- **Decided since this note was drafted:** the Postgres image is `postgres:16.15`.

## Q24. Repo: **Decided**

- **Decision:** `sentiment-monitor`, private.
- **Reason:** Commercial product. Private can be made public later; the reverse can't undo exposure. Harken's MIT licence only requires keeping its notice.
- **Source:** My judgment, accepted by the user.
- **Open:** GitHub owner (personal account or org). Railway deploys from that repo, so the owner also decides which Railway workspace connects to it.

## Q1. SME validation: **Decided (method)**

- **Decision:**
  - Recruit from the user's network of food and retail SMEs, starting with the "ayam geprek pak gembus" owner.
  - Run one session per owner (length chosen by the user) on the live or prototype dashboard.
  - Agree in advance which findings change scope.
- **Source:** Spec plus my judgment, accepted.
- **Open:** The recruit list, and what counts as "valuable enough to buy" (user).

## Q2. Pricing: **Deferred**

- **Decision:** Decide after the user can see a live app.
- **Cost inputs to have ready then:**
  - X: $0.005 per post read; 3M reads a month platform cap.
  - Jev: $0.042 per million input tokens.
  - Midtrans QRIS: 0.7%.
  - **Hosting:** Railway. The published rates are listed above. This note does not state a monthly total. The cost is the subscription plus measured usage.
- **Source:** User's answer; cost research notes; https://docs.railway.com/reference/pricing/plans

## Q3. Threads approval and query budget: **Approval still needs research; budget guard decided**

- **Approval:** Only Meta's App Review can answer this. Submit it in Phase 1 with a screencast of monitor-only use.
- **Budget guard (decided):**
  - Because credentials are shared (Q20), every customer's Threads searches draw on the **same** 2,200 queries per user per rolling 24 hours.
  - The scheduler must keep one global Threads query counter, and refuse or defer a job that would exceed the reserved share.
  - The reserve default is 1,500 of the 2,200, in `config/limits.json`. The user can still change it.
- **Source:** https://developers.facebook.com/documentation/threads/keyword-search (limit applies per user across apps; repeat queries count; empty results don't).

## Q4. Threads empty vs sensitive-keyword block: **Decided**

- **Decision:** Show it as "Tidak ada hasil, atau kata kunci diblokir Threads" (no results, or the keyword was blocked by Threads), never as zero. Flag a variant that is always empty while its siblings return posts.
- **Source:** Threads keyword-search doc; my judgment, accepted.

## Q5. Threads paging: **Still needs research**

- **Decision for now:**
  - Use `search_type=RECENT` with narrow `since`/`until` windows.
  - Split the window when a page comes back full (100 posts).
  - Treat `after` as optional.
  - Verify with a live token after approval.
- **Source:** Threads keyword-search doc (no cursor documented); Meta Postman example shows `paging.cursors`; a developer report says `after` repeated the same results. URLs are in v1.

## Q6. Who pays X: **Decided**

- **Decision:** One shared operator X account/API that we manage and pay for. Customers never enter X credentials.
- **Pending confirmation, defaults already in the plan:**
  - Global post-read cap: 20,000 a month. Per-customer cap: 2,000 a month. Both are below the 3M platform cap.
  - The X console spending limit is still pending. This note does not state a dollar amount for it.
- **Source:** User's answer; https://docs.x.com/x-api/getting-started/pricing (cited in the plan's Risks section).

## Q7. Confidence thresholds: **Decided (process)**

- **Decision:** Set the thresholds from the Indonesian evaluation results (Q8), not in advance.
- **Source:** Spec.

## Q8. Labelled set and launch gate: **Decided process; dataset and thresholds still open**

- **Decision:**
  - Use real X/Threads posts for the pilot brands, including slang and "tempe gembus"-type false matches.
  - Two Indonesian labellers work independently, then settle disagreements.
  - The user sets pass thresholds before seeing Jev's scores.
- **Open:** Set size and thresholds (user).

## Q9. Topic labels: **Decided (starter set)**

- **Decision:** *rasa/kualitas produk, harga, pelayanan, pengiriman/waktu tunggu, kebersihan, lokasi/akses, promo*, plus the fallback *lainnya*. Validate in Q1/Q8 before setting `topic_labels`.

## Q10. Multi-label counting: **Decided**

- **Decision:** Approve. A mention with two topics adds one to each topic count, and the UI says topic totals can exceed the mention count.

## Q11. High impact: **Decided (off in v1)**

- **Decision:** No high-impact badge in v1. Threads search returns no reach or like counts.
- **Still needs research:** X `public_metrics`, before any future rule.

## Q12. Overview formula: **Decided**

- **Decision:** Approve `100 × (positive − negative) / all included mentions`. Show "No scored mentions" when there are none, plus a one-line Indonesian explanation.

## Q13. Coverage, cadence, timezone, bucket: **Decided (trigger-based)**

- **Cadence (decided):** Collection runs only when triggered:
  1. **"Kumpulkan sekarang" (collect now)**, started manually by the owner.
  2. **A schedule the customer sets** in their project settings.

  Nothing collects for a customer who has neither.
- **Required to make this safe (decided, values open):**
  - A per-customer X post-read cap and a global X cap (Q6).
  - A global Threads query budget guard (Q3).
  - **Minimum intervals, pending confirmation:** scheduled collections at least 6 hours apart, manual runs at least 15 minutes apart per customer. The worker poll default is 20 seconds, not a cron tick.
- **Timezone:** Asia/Jakarta (WIB) for display, trend days, and customer schedules. `next_run_at` is a timestamptz. The worker compares it with `now()`.
- **Trend bucket:** Daily.
- **Historical coverage:** Whatever X recent search and the Threads `since` window return. No full-archive search in v1. The X recent-search lookback still needs research.
- **Source:** User's answer and the team-lead decisions of 1 Nov 2026.

## Q14. Languages, devices, retention, backups: **Decided except legal retention**

- **Languages:** Indonesian only in v1.
- **Devices:** Mobile-first.
- **Retention, deletion and privacy:** Still needs research and legal input. Indonesia's PDP Law (UU No. 27/2022) likely applies. Suggested default: keep data while the subscription is active, delete on request, store only displayed fields.
- **Backups (decided):**
  - A nightly `pg_dump` to off-Railway storage. `BACKUP_DESTINATION` defaults to empty.
  - The dump is **not built** until the user sets that destination. Railway's hard spend limit is only a backstop.
- **Note for the legal check:** Deleted customer data can live on in Railway backups for up to the retention window (6, 27 or 89 days depending on schedule) and in the off-platform dumps.
- **Source:** https://docs.railway.com/reference/backups; my judgment, accepted.

## Q15. Hosting, backup, region: **Decided (Railway)**

- **Decision:**
  - Deploy on **Railway**, not a VPS, in the **Southeast Asia Metal (Singapore, `asia-southeast1-eqsg3a`)** region for every service. Singapore is Railway's only Asia-Pacific region and the closest to Indonesia.
  - One Railway project, one production environment, with these services:
    1. `web`: Next.js, public domain.
    2. `worker`: Python, always on, 1 replica, no cron schedule (Q26). No volume on this service.
    3. `postgres`: image `postgres:16.15`, private only. Not the moving tag `postgres:16`.
  - Services talk over private networking (`*.railway.internal`). The worker uses `WORKER_DATABASE_URL` to write mentions and cursors in Postgres. It does not call the web process, and there is no `POST /api/internal/mentions`.
  - Secrets (`DATABASE_URL`, `WORKER_DATABASE_URL`, `X_BEARER_TOKEN`, `THREADS_ACCESS_TOKEN`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`) are Railway service variables, never committed and never logged. There is no `SOURCE_CREDENTIAL_KEY`.
  - Set a Railway workspace usage alert and hard limit; the amounts need user input, and the hard limit is at least $10. Remember that hitting the hard limit takes **all** services offline.
- **Plan tier:** Pending. Neither Hobby nor Pro is selected. The default is unset.
- **Backups:** See Q14.
- **Still needs research:** Whether any customer or law requires data stored **in Indonesia**. Railway has no Indonesia region, so that would conflict.
- **Source:** Railway docs listed above.

## Q16. TypeSafe SLA and fallback list: **Decided for pilot**

- **Decision:**
  - No SLA is acceptable for the pilot, given the OpenRouter fallback and visible scoring failures. Revisit before paid launch.
  - Accept the fallback list (network failure, 402, 408, 429, 500, 502, 503, 504), and log and surface every fallback to the operator.
- **Still needs research:** What TypeSafe's 402 means; it probably means credits ran out.

## Q17. TypeSafe rate limits: **Still needs research**

- Read them in console.typesafe.ai after creating the account.
- Note: with trigger-based collection, Jev load follows how many customers collect at once. The scheduler caps jobs per tick at `max_jobs_per_tick`. The default is 5, pending confirmation with the other limit defaults.

## Q18. TypeSafe hosting and latency: **Still needs research**

- Ask TypeSafe support where it's hosted.
- Measure latency from a **Railway service in the Singapore region** with a batch of test calls in Phase 1. The batch size is the operator's choice.

## Q19. TypeSafe retention: **Still needs research and legal input**

- Read TypeSafe's terms for non-enterprise retention and check them against Q14.

## Q20. Credential mode: **Decided**

- **Decision:** `shared_operator`.
  - X and Threads tokens belong to our operator accounts and live in Railway service variables.
  - Customers don't connect their own accounts in v1.
  - `config/credential-policy.json` ships with `"mode": "shared_operator"` and `"approved": false`. The user still flips `approved` together with the X budget (Q6).
- **Effect on the plan:** v1 does not include `secrets.ts` or any unused token-encryption code. Per-customer X accounts are out of scope.

## Q21. Disappearing posts: **Decided**

- **Decision:**
  - Keep the stored mention and its scores, and keep `source_post_unavailable` separate from a scoring failure.
  - Mark a post unavailable only when an explicit fetch fails; show "Postingan mungkin sudah dihapus" (the post may have been deleted).
  - Delete on request or by the retention rule.

## Q22. Team and timeline: **Deferred**

- The user will decide later.

## Q25. Indonesian copy: **Decided**

- Use the plan's sentences as placeholders, then a native-speaker review and testing in Q1. Avoid "confidence"; say "seberapa yakin" (how sure).

## Q26. Who runs collection and how often: **Decided (always-on worker)**

- **Decision:** The worker is one always-on Railway replica. It loops over a `jobs` table and claims due rows with `SELECT ... FOR UPDATE SKIP LOCKED`. There is no Railway cron service and no global cron timer. A manual run inserts a due job. The worker picks it up within the poll interval.
- **Poll:** default 20 seconds, configurable from 15 to 30. A heartbeat row shows `Worker offline` in the UI when it is stale (default 90 seconds).
- **Cursors:** Postgres adapter in the worker. Harken at `d0710a427dbbe712594ef3a6c25112e1d14cc027` is not forked. The cursor advances only in the same transaction that writes the mentions. No volume and no on-disk database file.
- **Source:** User's answer and the team-lead decisions of 1 Nov 2026.

---

## Conflicts with Railway (resolved or still open)

1. **Cursors. Resolved.** They are Postgres rows. The worker has no volume and does not open a database file. Harken is not modified.
2. **Cron floor. Resolved by not using cron.** The worker is always on and polls every 20 seconds by default.
3. **No Indonesia region.** Still open as research. The default is Singapore. If a review requires data inside Indonesia, Railway cannot meet it.
4. **Backups.** The nightly `pg_dump` is the plan and is not built until the user sets `BACKUP_DESTINATION`.
5. **The hard usage limit stops everything.** It is only a backstop. In-app caps stop collection first.
6. **Postgres version. Resolved.** The image tag is `postgres:16.15`.
7. **Hosting cost.** Railway's subscription plus measured usage. This note does not state a monthly total. Hobby or Pro is unset.
8. **The shared Threads token concentrates the limit.** The guard is mandatory. The reserve default is 1,500 of 2,200 per rolling 24 hours.

---

### Still needs the user
- GitHub owner (Q24)
- Confirmation of the limit defaults (Q3, Q6, Q13, Q26). Defaults: X 20,000 global and 2,000 per customer per month; Threads reserve 1,500; schedule gap 6 hours; manual gap 15 minutes; 5 jobs per pass; poll 20 seconds (allowed range 15–30); heartbeat stale after 90 seconds
- X console spending limit, with no dollar amount chosen here (Q6)
- Railway plan tier, Hobby or Pro, default unset (Q15)
- Data residency beyond the Singapore default (Q15)
- Backup destination, default empty, dump not built (Q14)
- Evaluation set and thresholds (Q8)
- Pricing (Q2, deferred) and team (Q22, deferred)

### Still needs the CTO
- Stack sign-off before Task 1 (Q23)

### Still needs research
- Meta approval (Q3)
- Threads cursor (Q5)
- X metrics and recent-search lookback (Q11/Q13)
- PDP Law, data location, and retention (Q14/Q15/Q19)
- TypeSafe 402, rate limits, hosting, and latency (Q16–Q18)
