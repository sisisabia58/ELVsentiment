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

The Railway worker runs that module and stays up. `python -m sentiment_monitor.collect_once` only runs the approval gate and exits. Threads can run when `config/credential-policy.json` is approved and `THREADS_ACCESS_TOKEN` is set. X still waits on `config/x-budget.json` plus `X_BEARER_TOKEN`. The scheduler still writes `worker_heartbeat`.

## Tests

```bash
npm test --prefix apps/web
apps/worker/.venv/bin/pytest apps/worker/tests -v
PYTHONPATH=eval apps/worker/.venv/bin/pytest eval -v
```

## Runtime configuration

Copy `.env.example` for local names. Do not commit a `.env` file. Production values are Railway service variables. Secret values are never printed. `format_log` replaces them with `[redacted]`.

Names: `DATABASE_URL`, `CONFIG_DIR`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `X_BEARER_TOKEN`, `THREADS_ACCESS_TOKEN`, `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `BACKUP_DESTINATION`, `X_MONTHLY_GLOBAL_POST_READS`, `X_MONTHLY_PER_CUSTOMER_POST_READS`, `THREADS_ROLLING_24H_RESERVE`, `SCHEDULE_MIN_INTERVAL_HOURS`, `MANUAL_MIN_INTERVAL_SECONDS`, `MAX_JOBS_PER_TICK`, `WORKER_POLL_SECONDS`, `WORKER_HEARTBEAT_STALE_SECONDS`, `WORKER_HEARTBEAT_LOG_SECONDS`, `SCORE_INTERVAL_SECONDS`.

`SCORE_INTERVAL_SECONDS` is optional. It defaults to 20. The scoring loop sleeps that many seconds after a batch finds no pending mentions. Values below 5, above 3600, or not a number use 20. `npm run score` ignores it. See `docs/operator-scoring.md`.

The web service pre-deploy command is `node src/db/migrate-cli.mjs`.

## Harken

Collection imports Harken at commit `d0710a427dbbe712594ef3a6c25112e1d14cc027`, which is MIT licensed. Keep that notice in the installed package. Do not delete Harken's LICENSE file or its copyright line. This app does not fork Harken, does not run `harken serve`, and does not use Harken's dashboard, instance accounts, lexicon sentiment, or alert transports. Cursors are rows in Postgres.

## Launch

`python eval/launch_gate.py` prints `blocked` until the user sets the flags in `config/launch-approvals.json`. The evaluation thresholds live in `config/eval-criteria.json` and start unapproved. This repository does not choose those numbers.
