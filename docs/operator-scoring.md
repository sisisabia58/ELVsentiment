# Run scoring in production

Scoring runs in the web image, separate from the Next.js server and from the collector (`python -m sentiment_monitor.scheduler`). The image compiles `apps/web/src/scoring/cli.ts` to `dist/scoring/cli.js` during `npm run build`. Plain `node` runs that file. `npm run start` is still the Next.js server.

Use one extra Railway service from the same image. Do not add a cron schedule. A cron tick would score one batch of at most 5 mentions and exit. The loop drains pending mentions, then sleeps, and stays up.

## Start

In the same Railway project and environment as web and the collector:

1. Create a service from this repository. Root directory stays the repository root, the same as the web service. The Dockerfile build context is the repo root.
2. Set the service config-as-code path to `/deploy/scoring.railway.toml`. Do not point this service at `/apps/web/railway.toml`. That file starts Next.js and runs migrations. Config-as-code overrides a dashboard start command on every deploy.
3. The scoring file builds `deploy/web.Dockerfile`, starts `exec node dist/scoring/cli.js --loop`, uses one replica, and has no pre-deploy command and no cron. The web service keeps `npm run start` and the migration pre-deploy.
4. The process working directory is `/app/apps/web`. That is the image `WORKDIR`. The start command is `exec node dist/scoring/cli.js --loop`. `exec` replaces the shell Railway uses, so `SIGTERM` reaches node. `npm run score:loop` is the same loop for a manual run; that script also uses `exec`, so a signal sent to npm reaches node.
5. Set variables by name:
   - `WORKER_DATABASE_URL` — the worker connection string. Each claim runs `SET LOCAL ROLE worker_role`. Do not use the migration or owner URL.
   - `TYPESAFE_API_KEY` — Typesafe key. The process never prints it.
   - `SCORE_INTERVAL_SECONDS` — optional. Default **20**. After a batch finds nothing pending, the loop sleeps this many seconds and checks again. A number below 5, above 3600, or not a number uses 20. `npm run score` ignores it. This is the only new variable.
6. Do not set `OPENROUTER_API_KEY` on this service. OpenRouter stays off. The scorer does not call it.
7. `CONFIG_DIR` is already `/app/config` in the image. Approval flags in that directory stay in force. No new flag file is required.
8. Deploy the service. A missing `WORKER_DATABASE_URL` or a missing or blank `TYPESAFE_API_KEY` logs one of these lines and exits 0:
   - `scoring skipped: WORKER_DATABASE_URL is not set`
   - `scoring skipped: TYPESAFE_API_KEY is not set`
   Restart policy is `ON_FAILURE`, so that exit stays stopped instead of looping. Fix the variable and redeploy. A database error does not exit. The loop logs `scoring batch failed: ...` with the key and the connection string removed, sleeps `SCORE_INTERVAL_SECONDS`, and tries the batch again. `ON_FAILURE` does not restart that process. A crashed process (exit 1) restarts.

`npm run score` in `/app/apps/web` runs one batch and exits. Use that for a manual pass. The service start command is the loop.

One batch claims at most 5 pending mentions. While a batch scores or fails something, the loop runs another batch immediately. When a batch claims nothing, it sleeps. `SIGTERM` (a deploy or a stop) finishes the current batch, does not claim another, and exits 0. A second `SIGTERM` exits 1. Claims already taken are scored or settled before the first signal returns. A `kill -9` can leave rows in `scoring` until a later run; the next batch returns a claim to `pending` when `scoring_claimed_at` is older than 180 seconds, or marks it `failed` after 3 attempts.

## Verify

Read-only. Run this in a transaction so the session cannot write. Use any role that can `select` from `mentions`. Do not print connection strings.

```sql
begin read only;

select scoring_status, count(*)
from mentions
group by scoring_status
order by scoring_status;

select count(*) as claimed_inside_lease
from mentions
where scoring_status = 'scoring'
  and scoring_claimed_at > clock_timestamp() - interval '180 seconds';

commit;
```

After the service is up and mentions are waiting, `pending` should fall and `succeeded` (or `failed`) should rise. `claimed_inside_lease` is an in-flight batch. Rows in `scoring` older than 180 seconds are picked up on the next batch. Service logs show the skip line when a variable is missing, and they must not contain the API key.

## Stop

Stop or delete this scoring service only. Leave the web service and the collector running.

Railway sends `SIGTERM`. The loop finishes the mentions already claimed, skips the sleep, and exits 0. It does not start another batch. Setting the replica count to 0 stops it the same way.

## Rollback

1. Stop the scoring service (replica count 0 or delete the service). Web and the collector stay up. Pending mentions stay pending. Nothing in this change alters migrations `001`–`008`.
2. Rows left in `scoring` stay there until a scorer runs again. The next start reclaims a claim older than 180 seconds. Leave a claim that is still inside the lease alone.
3. Rolling this service back to an older web image removes `dist/scoring/cli.js`. Stop the service before that rollback so `exec node dist/scoring/cli.js --loop` does not restart on a missing file. The Next.js service does not need a rollback for scoring to stop.
