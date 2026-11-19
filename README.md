# sentiment-monitor

Monitor-only dashboard for Indonesian SME brand mentions on X and Threads. The product stores candidates, Jev scores, and owner corrections. It does not draft replies, post, or send external alerts.

The web stack and the Harken worker split in `docs/superpowers/plans/2026-11-01-sentiment-monitor-mvp.md` are a recommendation. Do not start the tasks until the CTO and the user accept that recommendation or replace the file paths.

## Web

```bash
npm install --prefix apps/web
npm run dev --prefix apps/web
```

Open `http://127.0.0.1:43123`.

## Worker

```bash
python3 -m venv apps/worker/.venv
apps/worker/.venv/bin/pip install -e "apps/worker[dev]"
apps/worker/.venv/bin/python -m sentiment_monitor.scheduler
```

The Railway worker runs that module and stays up. `python -m sentiment_monitor.collect_once` only runs the approval gate and exits. Scheduled Threads, Instagram, and TikTok use ScrapeAtlas when shared operator credentials are approved and the worker has `SCRAPEATLAS_API_KEY`. Both the project source selection and disabled provider settings are honored. Each poll requests a fresh first page per selected platform and variant. The shared `SCHEDULED_REQUESTS_ROLLING_24H` cap counts admitted requests across all three platforms (defaulting to the configured Threads reserve, normally 1,500). The worker commits reservations before dispatch and records missing charges as unknown. Actual response charges and HTTP status are recorded in `scheduled_provider_calls`. Indexed Instagram and instant X offer partial coverage. Scheduled X remains unavailable pending cursor and budget validation. Facebook instant search accepts explicit hashtags. Keep legacy credentials available for deployment rollback until staging and cutover are verified. The scheduler still writes `worker_heartbeat`.

## Tests

```bash
npm test --prefix apps/web
apps/worker/.venv/bin/pytest apps/worker/tests -v
PYTHONPATH=eval apps/worker/.venv/bin/pytest eval -v
```

## Runtime configuration

Copy `.env.example` for local names. Do not commit a `.env` file. Production values are Railway service variables. Secret values are never printed. `format_log` replaces them with `[redacted]`.

Names: `DATABASE_URL`, `CONFIG_DIR`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `SCRAPEATLAS_API_KEY`, `SCHEDULED_REQUESTS_ROLLING_24H`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `BACKUP_DESTINATION`, `X_MONTHLY_GLOBAL_POST_READS`, `X_MONTHLY_PER_CUSTOMER_POST_READS`, `THREADS_ROLLING_24H_RESERVE`, `SCHEDULE_MIN_INTERVAL_HOURS`, `MANUAL_MIN_INTERVAL_SECONDS`, `MAX_JOBS_PER_TICK`, `WORKER_POLL_SECONDS`, `WORKER_HEARTBEAT_STALE_SECONDS`, `WORKER_HEARTBEAT_LOG_SECONDS`, `SCORE_INTERVAL_SECONDS`.

`SCORE_INTERVAL_SECONDS` is optional. It defaults to 20. The scoring loop sleeps that many seconds after a batch finds no pending mentions. Values below 5, above 3600, or not a number use 20. `npm run score` ignores it. See `docs/operator-scoring.md`.

### Cari sekarang (instant search)

Names only; set real values in Railway. Do not commit values.

- `CARI_SEKARANG_ENABLED` — off by default. Only `1`/`true` enables the `/cari` pages, the polling route, and the nav entry.
- `CARI_PROVIDER_MODE` — live by default. Fixture data is used only when this is explicitly `fixture`.
- `CARI_AI_PROVIDER` — defaults to `demo` when unset. `demo` writes a zero-cost summary and hides summary, stance, quote, theme, and question UI. `gemini` and `opencode` show that UI and call that provider. `off` stores no summary.
- `GEMINI_API_KEY` — required only when `CARI_AI_PROVIDER=gemini`. A missing key marks the summary failed and still shows the posts.
- `OPENCODE_API_KEY` — required only when `CARI_AI_PROVIDER=opencode`.
- `OPENCODE_MODEL` — optional, default `deepseek-v4.1-flash`.
- `GEMINI_MODEL` — optional, default `gemini-3.5-flash-lite`.
- `GEMINI_MAX_RPM` — optional request spacing, default 10.
- `GEMINI_INPUT_USD_PER_MTOK` and `GEMINI_OUTPUT_USD_PER_MTOK` — optional cost rates, defaults `0.30` and `2.50`. Cost is stored for the operator and is not shown as a tenant credit.
- `SCRAPEATLAS_API_KEY` — ScrapeAtlas provider credential for the launch sources.
- Platform admin is **not** an env var. After the real owner has signed up, the operator grants it once with SQL: `insert into platform_admins (user_id) select id from users where email = 'owner@example.com';` Run that as the migration/table-owner role (`MIGRATION_DATABASE_URL`), not as `app_user`. Only a live session for a row in `platform_admins` can write `/pengaturan/provider`. Revoke with `delete from platform_admins where user_id = (select id from users where email = 'owner@example.com');`.
- `CARI_DAILY_SEARCH_LIMIT` — optional per-customer daily instant-search cap (web and worker, default 20).

The web service pre-deploy command is `node src/db/migrate-cli.mjs`.

## Harken

Collection imports Harken at commit `d0710a427dbbe712594ef3a6c25112e1d14cc027`, which is MIT licensed. Keep that notice in the installed package. Do not delete Harken's LICENSE file or its copyright line. This app does not fork Harken, does not run `harken serve`, and does not use Harken's dashboard, instance accounts, lexicon sentiment, or alert transports. Cursors are rows in Postgres.

## Launch

`python eval/launch_gate.py` prints `blocked` until the user sets the flags in `config/launch-approvals.json`. The evaluation thresholds live in `config/eval-criteria.json` and start unapproved. This repository does not choose those numbers.
