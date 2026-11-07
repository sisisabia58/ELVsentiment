# ScrapeCreators Multi-Platform Sources (`threads`, `instagram`, `tiktok`) + Official X (`x`) Design Specification

**Date:** 2026-11-06
**Status:** Approved

## 1. Intent & Problem Statement

Meta's official Threads keyword search API (`https://graph.threads.net/v1.0/keyword_search`) is not accessible for our deployment. We need to replace the official Threads integration with **ScrapeCreators** (`https://api.scrapecreators.com`) and expand our multi-platform brand monitoring to also collect from **Instagram** (`instagram`) and **TikTok** (`tiktok`) via ScrapeCreators, while keeping **X** (`x`) on its official API (`https://api.x.com/2/tweets/search/recent`) with its existing monthly post-read budget (`x_read_counters` + `config/x-budget.json`).

## 2. Goals & Non-Goals

### Goals
- Replace `graph.threads.net` in `apps/worker/sentiment_monitor/sources/threads.py` with ScrapeCreators `GET /v1/threads/search`.
- Add `instagram` collection using **both** ScrapeCreators `GET /v2/instagram/reels/search` (keyword search) and `GET /v1/instagram/search/hashtag` (hashtag search, normalized without `#` or spaces), deduplicated by `external_id`.
- Add `tiktok` collection using **both** ScrapeCreators `GET /v1/tiktok/search/keyword` (keyword video search) and `GET /v1/tiktok/search/top` (top videos + photo carousels), deduplicated by `external_id`.
- Pass `region=ID` (Indonesia proxy) on all ScrapeCreators search requests.
- Authenticate all ScrapeCreators requests with `x-api-key: <SCRAPECREATORS_API_KEY>` and redact `SCRAPECREATORS_API_KEY` in worker structured logs.
- Remove the rolling 24-hour Threads query reserve (`threads_rolling_24h_reserve` / `threads_query_log`) from blocking or gating ScrapeCreators sources (no credit cap enforced in the worker for now).
- Keep X (`x`) on its official API (`https://api.x.com/2/tweets/search/recent`) with `X_BEARER_TOKEN` and `admit_x_read` monthly budget enforcement unchanged.
- Expand database constraints, project settings, source health/status, onboarding, and Indonesian UI filter/display components across `apps/web` to support `"x" | "threads" | "instagram" | "tiktok"`.

### Non-Goals
- Changing the X collection adapter (`apps/worker/sentiment_monitor/sources/x.py`) or X budget enforcement (`x_read_counters`).
- Adding a local credit counter or rate cap for ScrapeCreators sources (`threads`, `instagram`, `tiktok`).
- Modifying existing SQL migration files (`001_init.sql` through `008_scoring_worker.sql`).

## 3. Hard Constraints

1. **Migration Immutability**: `apps/web/src/db/sql/001_init.sql` through `008_scoring_worker.sql` must remain untouched. All schema constraint updates must be applied in `apps/web/src/db/sql/009_scrapecreators_sources.sql`.
2. **Indonesian Proxy Region**: Every ScrapeCreators search request must pass `region=ID`.
3. **Secret Hygiene**: `SCRAPECREATORS_API_KEY` must never be written to logs or client responses (`_SECRET_NAMES` in `scheduler.py` must include `"SCRAPECREATORS_API_KEY"`).
4. **Source credential separation in web**: `sourceCredentials()` in `apps/web/src/monitor/policy.ts` must only inspect environment variables (`X_BEARER_TOKEN` for `x`, `SCRAPECREATORS_API_KEY` for `threads`, `instagram`, and `tiktok`) and must not read `config/x-budget.json` (preserving the contract tested in `apps/web/src/projects/source-availability.test.ts`).

## 4. Architecture & Data Flow

```
                       ┌─────────────────────────────────────────────┐
                       │         Job Runner (scheduler.py)           │
                       └──────────────────────┬──────────────────────┘
                                              │
                ┌─────────────────────────────┴─────────────────────────────┐
                ▼                                                           ▼
┌───────────────────────────────┐                           ┌───────────────────────────────┐
│   Official X API (source="x") │                           │      ScrapeCreators API       │
│  GET api.x.com/2/tweets/...   │                           │  Header: x-api-key            │
│  Auth: Bearer X_BEARER_TOKEN  │                           │  Param:  region=ID            │
│  Gate: x-budget.json +        │                           │  Gate:   credential-policy    │
│        admit_x_read()         │                           │          (No local cap)       │
└───────────────┬───────────────┘                           └───────┬───────┬───────┬───────┘
                │                                                   │       │       │
                │                                    ┌──────────────┘       │       └──────────────┐
                │                                    ▼                      ▼                      ▼
                │                            ┌───────────────┐      ┌───────────────┐      ┌───────────────┐
                │                            │   threads     │      │   instagram   │      │    tiktok     │
                │                            │ /v1/threads/  │      │ /v2/instagram/│      │ /v1/tiktok/   │
                │                            │ search        │      │ reels/search  │      │ search/keyword│
                │                            │               │      │ + /v1/insta../│      │ + /v1/tiktok/ │
                │                            │               │      │ search/hashtag│      │ search/top    │
                │                            └───────┬───────┘      └───────┬───────┘      └───────┬───────┘
                └────────────────────────────────────┴──────────────────────┴──────────────────────┘
                                                                    │
                                                                    ▼
                                                    ┌───────────────────────────────┐
                                                    │  Normalized Mention Objects   │
                                                    │  store_source() -> mentions,  │
                                                    │  source_status, source_cursors│
                                                    └───────────────────────────────┘
```

### 4.1 ScrapeCreators Endpoints & Normalization

1. **Shared HTTP Helper (`apps/worker/sentiment_monitor/sources/scrapecreators.py`)**:
   - Base URL: `https://api.scrapecreators.com`
   - Sends `GET` with query parameters (always including `region="ID"`) and headers `{"x-api-key": api_key, "Accept": "application/json"}`.
   - Raises `urllib.error.HTTPError` on non-2xx responses so `_failure_detail(error)` in `scheduler.py` classifies `401` (`authorization_failed`), `402` (`rate_limited` — out of ScrapeCreators credits), `429` (`rate_limited`), and other HTTP errors consistently.

2. **Threads (`apps/worker/sentiment_monitor/sources/threads.py`)**:
   - Endpoint: `GET https://api.scrapecreators.com/v1/threads/search?query=<variant>&region=ID`
   - Response items: `payload.get("posts") or payload.get("items") or payload.get("data") or []`
   - Normalization (`normalize_threads_item(item, collected_at)`):
     - `external_id`: `str(item.get("pk") or item.get("id") or item.get("code") or "")`
     - `text`: `caption.text` (if `caption` is a dict) or `caption` (if str) or `text` or joined `text_post_app_info.text_fragments.fragments[].plaintext`
     - `author`: `user.username` or `username`
     - `url`: `item.get("url") or item.get("permalink")` or `https://www.threads.com/@{author}/post/{code}` (when `author` and `code` are present)
     - `posted_at`: ISO-8601 UTC string from Unix timestamp `taken_at` or ISO string `timestamp`
     - `source`: `"threads"`

3. **Instagram (`apps/worker/sentiment_monitor/sources/instagram.py`)**:
   - Endpoint 1 (Reels keyword search): `GET https://api.scrapecreators.com/v2/instagram/reels/search?query=<variant>&region=ID`
     - Extracts list from `payload.get("reels") or payload.get("items") or payload.get("data") or []`
   - Endpoint 2 (Hashtag search): `GET https://api.scrapecreators.com/v1/instagram/search/hashtag?hashtag=<hashtag>&region=ID`
     - `<hashtag>` is derived from `<variant>` by stripping leading `#` and removing whitespace/punctuation (`re.sub(r"[\s#]+", "", variant)`). Skipped if normalized hashtag is empty.
     - Extracts list from `payload.get("posts") or payload.get("items") or payload.get("medias") or payload.get("data") or []`
   - Normalization (`normalize_instagram_item(item, collected_at)`):
     - Unwraps `item.get("media")` if nested.
     - `external_id`: `str(media.get("pk") or media.get("id") or media.get("shortcode") or media.get("code") or "")`
     - `text`: `caption.text` (if dict) or `caption` (if str) or `text` or `edge_media_to_caption.edges[0].node.text`
     - `author`: `user.username` or `owner.username` or `username`
     - `url`: `media.get("url") or media.get("permalink")` or `https://www.instagram.com/p/{code}/` (using `code` or `shortcode`)
     - `posted_at`: ISO-8601 UTC from `taken_at` / `taken_at_timestamp` (Unix seconds) or ISO string `timestamp`
     - `source`: `"instagram"`
   - Deduplicates combined reels + hashtag mentions by `external_id` preserving first-seen order.

4. **TikTok (`apps/worker/sentiment_monitor/sources/tiktok.py`)**:
   - Endpoint 1 (Keyword video search): `GET https://api.scrapecreators.com/v1/tiktok/search/keyword?query=<variant>&region=ID`
   - Endpoint 2 (Top search — videos + photo carousels): `GET https://api.scrapecreators.com/v1/tiktok/search/top?query=<variant>&region=ID`
   - Both endpoints return `search_item_list` (or `aweme_list` / `items` / `data`). Each element may wrap the post inside `item.get("aweme_info")` or be the aweme object directly.
   - Normalization (`normalize_tiktok_item(item, collected_at)`):
     - Unwraps `aweme = item.get("aweme_info") if isinstance(item.get("aweme_info"), dict) else item`
     - `external_id`: `str(aweme.get("aweme_id") or aweme.get("id") or "")`
     - `text`: `aweme.get("desc") or aweme.get("text") or ""`
     - `author`: `author.unique_id` or `author.nickname` (or string `author`)
     - `url`: `aweme.get("share_url") or aweme.get("url")` or `https://www.tiktok.com/@{unique_id}/video/{aweme_id}`
     - `posted_at`: ISO-8601 UTC from `create_time` (Unix seconds) or `posted_at`
     - `source`: `"tiktok"`
   - Deduplicates combined keyword + top mentions by `external_id` preserving first-seen order.

### 4.2 Worker Gate & Scheduler Changes

- **`collect_once.py`**:
  - `sources_allowed(root, env)`:
    - Requires `config/credential-policy.json` `approved: true`.
    - Adds `"x"` if `config/x-budget.json` `approved: true` and `env.get("X_BEARER_TOKEN")` is non-empty.
    - Adds `"threads"`, `"instagram"`, `"tiktok"` if `env.get("SCRAPECREATORS_API_KEY")` is non-empty.
- **`scheduler.py`**:
  - Add `"SCRAPECREATORS_API_KEY"` to `_SECRET_NAMES`.
  - Expand `ALL_SOURCES = ("x", "threads", "instagram", "tiktok")` in `load_enabled_sources` and `collect_project_sources`.
  - In `serve()`:
    - Do **not** gate `"threads"`, `"instagram"`, or `"tiktok"` on `threads_rolling_24h_reserve` / `admit_threads_queries`.
    - Gate `"x"` on `admit_x_read(conn, job["customer_id"], 10, limits)` as before.
    - Accept optional `fetch_threads`, `fetch_instagram`, `fetch_tiktok` callables (with default adapters bound to `SCRAPECREATORS_API_KEY` from `os.environ`) so tests can inject fakes cleanly while preserving backwards-compatible signatures.
  - In `_failure_detail(error, source=...)`:
    - Map HTTP status errors to `{source}_http_{code}` (e.g. `threads_http_401`, `instagram_http_429`, `tiktok_http_402`).
    - Treat HTTP `401` as `authorization_failed` and HTTP `402` / `429` as `rate_limited` in `record_source_failure`.

### 4.3 Database Migration (`009_scrapecreators_sources.sql`)

```sql
alter table mentions drop constraint if exists mentions_source_check;
alter table mentions add constraint mentions_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table source_status drop constraint if exists source_status_source_check;
alter table source_status add constraint source_status_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table source_cursors drop constraint if exists source_cursors_source_check;
alter table source_cursors add constraint source_cursors_source_check
  check (source in ('x', 'threads', 'instagram', 'tiktok'));

alter table project_settings drop constraint if exists project_settings_enabled_sources_check;
alter table project_settings add constraint project_settings_enabled_sources_check
  check (
    cardinality(enabled_sources) >= 1
    and enabled_sources <@ array['x', 'threads', 'instagram', 'tiktok']::text[]
  );
alter table project_settings alter column enabled_sources
  set default array['x', 'threads', 'instagram', 'tiktok'];
```

### 4.4 Web Application & Indonesian UI (`apps/web/src/`)

- **Source Type**: Define `export type PlatformSource = "x" | "threads" | "instagram" | "tiktok"` (and `ALL_SOURCES = ["x", "threads", "instagram", "tiktok"] as const`) with display labels:
  - `x`: `"X"`
  - `threads`: `"Threads"`
  - `instagram`: `"Instagram"`
  - `tiktok`: `"TikTok"`
- **Credentials (`apps/web/src/monitor/policy.ts`)**:
  - `sourceCredentials(env)` returns `{ x: boolean; threads: boolean; instagram: boolean; tiktok: boolean }` where `x` checks `X_BEARER_TOKEN` and `threads`, `instagram`, `tiktok` check `SCRAPECREATORS_API_KEY`.
- **UI Components**:
  - `SourceMark` in `bits.tsx`: Badge for `x` (`X`), `threads` (`@` / `Threads`), `instagram` (`IG` / `Instagram`), `tiktok` (`TT` / `TikTok`).
  - `SourceChoices` in `source-choices.tsx`: Checkboxes for X, Threads, Instagram, and TikTok with per-source availability message (`Sumber <Nama> sedang tidak tersedia, kami sedang memperbaikinya.`).
  - `MentionsView` in `mentions-view.tsx` and `dashboardFor` in `load.ts`: Filter pills for Semua sumber, X, Threads, Instagram, TikTok.
  - `CollectionView` in `collection-view.tsx`, `SourceStatusList` in `source-status-list.tsx`, and `sourceStatusLines` in `source-status.ts`: Status rows for all four sources.
